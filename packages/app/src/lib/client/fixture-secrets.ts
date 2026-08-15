/**
 * The secret half of `PrickApi`, against the fixture store.
 *
 * This is the slice that holds VALUES, which is why it is worth being able to
 * point at it on its own: when the seam is cut, this file and the value column
 * of the store go together, and nothing in the project/identity/audit slices
 * has to be re-read to be sure of it.
 *
 * Part of the seam described in `./fixtures.ts`, and deleted with it.
 */

import type { BatchInput, ImportPreview, PrickApi, RevealReason, WriteResult } from "./api.js";
import { ApiError } from "./errors.js";
import {
  auditLog,
  auditRow,
  bumpEnvironment,
  delay,
  fail,
  findEnvironment,
  listing,
  secret,
  version,
} from "./fixture-store.js";

/**
 * A deliberately small `.env` reader, for the import PREVIEW only.
 *
 * The real parser is `src/lib/server/core/dotenv.ts` and it is far stricter.
 * This one exists because the preview has to come from somewhere while the
 * API is being written, and it dies with the rest of this seam.
 */
function parseEnvFixture(source: string): {
  entries: Record<string, string>;
  warnings: { line: number; message: string }[];
} {
  const entries: Record<string, string> = {};
  const warnings: { line: number; message: string }[] = [];

  source.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;

    const eq = line.indexOf("=");
    if (eq === -1) {
      warnings.push({ line: index + 1, message: "No '=' on this line; skipped." });
      return;
    }

    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    let value = line.slice(eq + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      warnings.push({ line: index + 1, message: `"${key}" is not a POSIX variable name.` });
      return;
    }

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  });

  return { entries, warnings };
}

type SecretApi = Pick<
  PrickApi,
  | "listSecrets"
  | "revealSecret"
  | "writeSecrets"
  | "renameSecret"
  | "importSecrets"
  | "exportSecrets"
  | "listVersions"
  | "rollbackSecret"
>;

export const fixtureSecretApi: SecretApi = {
  listSecrets: (project, environment_) => delay(listing(findEnvironment(project, environment_))),

  revealSecret: (project, environment_, key, reason: RevealReason) => {
    const found = findEnvironment(project, environment_);
    const entry = found.secrets.find((candidate) => candidate.key === key);
    if (!entry) fail("NOT_FOUND", "No such key.", 404);

    if (entry.unreadable) {
      auditLog.push(
        auditRow({
          ts: Date.now(),
          action: "secret.reveal",
          outcome: "error",
          projectSlug: project,
          environmentSlug: environment_,
          targetKey: key,
          detail: { kind: "secret.unreadable", keys: [key], kid: "0000000000000000" },
        }),
      );
      fail(
        "UNKNOWN_KID",
        `${key} is sealed under key id 0000000000000000, which this keyring does not hold.`,
        500,
        "MASTER_KEY_OLD may have been removed before the rekey finished. Restore it and re-run the rekey.",
      );
    }

    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "secret.reveal",
        projectSlug: project,
        environmentSlug: environment_,
        targetKey: key,
        detail: { kind: "secret.read", reason, count: 1 },
      }),
    );
    return delay(entry.value);
  },

  writeSecrets: (project, environment_, input: BatchInput) => {
    const found = findEnvironment(project, environment_);

    if (input.expected_rev !== undefined && input.expected_rev !== found.rev) {
      fail(
        "PRECONDITION_FAILED",
        "This environment changed while you were editing it.",
        412,
        "Reload to pick up the current values, then re-apply your change.",
      );
    }

    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];

    for (const [key, value] of Object.entries(input.set ?? {})) {
      const existing = found.secrets.find((entry) => entry.key === key);
      if (existing) {
        existing.value = value;
        existing.version += 1;
        existing.updatedAt = Date.now();
        existing.unreadable = false;
        existing.versions.unshift(
          version(existing.version, "update", Date.now(), "ada@example.com"),
        );
        changed.push(key);
      } else {
        const created = secret({ key, value, version: 1, ageDays: 0 });
        created.updatedAt = Date.now();
        found.secrets.push(created);
        added.push(key);
      }
    }

    const deleting = new Set(input.delete ?? []);
    if (input.mode === "replace") {
      const keeping = new Set(Object.keys(input.set ?? {}));
      for (const entry of found.secrets) if (!keeping.has(entry.key)) deleting.add(entry.key);
    }

    for (const key of deleting) {
      const index = found.secrets.findIndex((entry) => entry.key === key);
      if (index !== -1) {
        found.secrets.splice(index, 1);
        removed.push(key);
      }
    }

    const rev = bumpEnvironment(found);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "secret.write",
        projectSlug: project,
        environmentSlug: environment_,
        detail: {
          kind: "secret.diff",
          mode: input.mode ?? "merge",
          added,
          changed,
          removed,
          reason: input.reason,
        },
      }),
    );
    return delay({ rev } satisfies WriteResult);
  },

  renameSecret: (project, environment_, from, to) => {
    const found = findEnvironment(project, environment_);
    const entry = found.secrets.find((candidate) => candidate.key === from);
    if (!entry) fail("NOT_FOUND", "No such key.", 404);
    if (found.secrets.some((candidate) => candidate.key === to)) {
      fail("CONFLICT", `"${to}" already exists in this environment.`, 409);
    }

    entry.key = to;
    entry.version += 1;
    entry.updatedAt = Date.now();
    entry.versions.unshift(version(entry.version, "rename", Date.now(), "ada@example.com"));

    const rev = bumpEnvironment(found);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "secret.rename",
        projectSlug: project,
        environmentSlug: environment_,
        targetKey: to,
        detail: { kind: "secret.rename", from, to, version: entry.version },
      }),
    );
    return delay({ rev } satisfies WriteResult);
  },

  importSecrets: (project, environment_, input) => {
    const found = findEnvironment(project, environment_);

    let entries: Record<string, string>;
    let warnings: { line: number; message: string }[] = [];

    if (input.format === "json") {
      try {
        const parsed: unknown = JSON.parse(input.content);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          fail("VALIDATION_FAILED", "Expected a JSON object of key/value pairs.", 422);
        }
        entries = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value),
          ]),
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        fail("VALIDATION_FAILED", "That is not valid JSON.", 422);
      }
    } else {
      const parsed = parseEnvFixture(input.content);
      entries = parsed.entries;
      warnings = parsed.warnings;
    }

    const existing = new Map(found.secrets.map((entry) => [entry.key, entry.value]));
    const added: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];

    for (const [key, value] of Object.entries(entries)) {
      if (!existing.has(key)) added.push(key);
      else if (existing.get(key) !== value) changed.push(key);
      else unchanged.push(key);
    }

    const removed =
      input.mode === "replace"
        ? [...existing.keys()].filter((key) => !(key in entries)).sort()
        : [];

    if (input.dry_run) {
      return delay({
        dryRun: true,
        added: added.sort(),
        changed: changed.sort(),
        removed,
        unchanged: unchanged.sort(),
        warnings,
        rev: found.rev,
      } satisfies ImportPreview);
    }

    for (const [key, value] of Object.entries(entries)) {
      const entry = found.secrets.find((candidate) => candidate.key === key);
      if (entry) {
        entry.value = value;
        entry.version += 1;
        entry.updatedAt = Date.now();
        entry.versions.unshift(version(entry.version, "import", Date.now(), "ada@example.com"));
      } else {
        const created = secret({ key, value, version: 1, ageDays: 0 });
        created.updatedAt = Date.now();
        found.secrets.push(created);
      }
    }

    for (const key of removed) {
      const index = found.secrets.findIndex((entry) => entry.key === key);
      if (index !== -1) found.secrets.splice(index, 1);
    }

    const rev = bumpEnvironment(found);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "secret.import",
        projectSlug: project,
        environmentSlug: environment_,
        detail: {
          kind: "secret.diff",
          mode: input.mode,
          added,
          changed,
          removed,
          reason: input.reason,
        },
      }),
    );

    return delay({
      dryRun: false,
      added: added.sort(),
      changed: changed.sort(),
      removed,
      unchanged: unchanged.sort(),
      warnings,
      rev,
    } satisfies ImportPreview);
  },

  exportSecrets: (project, environment_) => {
    const found = findEnvironment(project, environment_);
    const unreadable = found.secrets.filter((entry) => entry.unreadable);

    if (unreadable.length > 0) {
      // The opposite of quietly writing a shorter file. An export that cannot
      // include every key fails; it never silently omits one.
      fail(
        "DECRYPT_FAILED",
        `${unreadable.length} value(s) in this environment cannot be decrypted, so the export would be incomplete.`,
        500,
        `Affected keys: ${unreadable.map((entry) => entry.key).join(", ")}.`,
      );
    }

    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "secret.export",
        projectSlug: project,
        environmentSlug: environment_,
        detail: { kind: "secret.read", reason: "export", count: found.secrets.length },
      }),
    );

    return delay(Object.fromEntries(found.secrets.map((entry) => [entry.key, entry.value])));
  },

  listVersions: (project, environment_, key) => {
    const found = findEnvironment(project, environment_);
    const entry = found.secrets.find((candidate) => candidate.key === key);
    if (!entry) fail("NOT_FOUND", "No such key.", 404);
    return delay(entry.versions);
  },

  rollbackSecret: (project, environment_, input) => {
    const found = findEnvironment(project, environment_);
    const entry = found.secrets.find((candidate) => candidate.key === input.key);
    if (!entry) fail("NOT_FOUND", "No such key.", 404);

    entry.version += 1;
    entry.updatedAt = Date.now();
    entry.versions.unshift(version(entry.version, "rollback", Date.now(), "ada@example.com"));

    const rev = bumpEnvironment(found);
    auditLog.push(
      auditRow({
        ts: Date.now(),
        action: "secret.rollback",
        projectSlug: project,
        environmentSlug: environment_,
        targetKey: input.key,
        detail: {
          kind: "secret.version",
          key: input.key,
          from: input.to_version,
          to: entry.version,
          reason: input.reason,
        },
      }),
    );
    return delay({ rev, version: entry.version });
  },
};
