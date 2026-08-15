import type { AuditEntryView } from "./api.js";

/**
 * Rendering rules for audit rows.
 *
 * The log is the only place a denial or a decrypt failure is durably recorded,
 * so a row that renders as an opaque action string is a row nobody reads. Every
 * action gets a sentence; every detail shape gets a one-line summary.
 *
 * The summariser is total by construction: `detail` arrives as `unknown`
 * (a JSON blob in a TEXT column) and an unrecognised shape falls through to
 * `null` rather than throwing and taking the whole table with it.
 */

export const ACTION_LABELS: Record<string, string> = {
  "project.create": "Project created",
  "project.update": "Project updated",
  "project.delete": "Project deleted",
  "environment.create": "Environment created",
  "environment.update": "Environment updated",
  "environment.delete": "Environment deleted",
  "secret.write": "Secrets written",
  "secret.reveal": "Secret revealed",
  "secret.export": "Environment exported",
  "secret.list": "Secrets listed",
  "secret.rollback": "Secret rolled back",
  "secret.rename": "Secret renamed",
  "secret.import": "Secrets imported",
  "identity.update": "Identity updated",
  "grant.create": "Grant created",
  "grant.revoke": "Grant revoked",
  "admin.rekey": "Rekey ran",
  "access.denied": "Access denied",
};

/** Every action the audit filter offers, in the order they are listed. */
export const ACTIONS = Object.keys(ACTION_LABELS);

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export const OUTCOME_LABELS: Record<string, string> = {
  success: "Succeeded",
  denied: "Denied",
  error: "Error",
};

/**
 * id -> slug, for the two ids an audit row carries.
 *
 * The server sends `projectId` and `environmentId` and NOTHING ELSE, which is
 * the right shape for an append-only log: a denormalised slug would be a name
 * frozen at write time, and delete-then-recreate can point that name at a
 * different id. So the resolution happens HERE, at render time, against the
 * lists the screen has already loaded -- `/audit` has the project list, and
 * `/p/[project]` has that project's environments.
 */
export interface ScopeNames {
  projects?: Record<string, string>;
  environments?: Record<string, string>;
}

/**
 * `project/environment`, or as much of it as can be resolved.
 *
 * FALLS BACK TO THE ID, never to nothing. A row whose project has since been
 * deleted still happened, and hiding its scope would quietly turn the most
 * interesting rows in the log -- the ones about things that no longer exist --
 * into rows that look install-wide.
 *
 * A denial recorded at environment scope carries `environment_id` and a NULL
 * `project_id` (there is no project on that scope to record), so the
 * environment half stands alone rather than being rendered as a suffix of a
 * project that is not there.
 */
export function scopeLabel(entry: AuditEntryView, names: ScopeNames = {}): string | null {
  const project =
    entry.projectId === null ? null : (names.projects?.[entry.projectId] ?? entry.projectId);
  const environment =
    entry.environmentId === null
      ? null
      : (names.environments?.[entry.environmentId] ?? entry.environmentId);

  if (project === null) return environment;
  if (environment === null) return project;
  return `${project}/${environment}`;
}

type Detail = Record<string, unknown>;

function asDetail(value: unknown): Detail | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Detail)
    : null;
}

function names(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * One line describing what the row did.
 *
 * KEY NAMES appear here and that is correct -- they are stored in plaintext and
 * are what makes the log usable. VALUES are not representable in `AuditDetail`
 * at all, so there is nothing here that could print one.
 */
export function summariseDetail(entry: AuditEntryView): string | null {
  const detail = asDetail(entry.detail);
  if (!detail) return null;

  switch (detail["kind"]) {
    case "secret.diff": {
      const added = names(detail["added"]).length;
      const changed = names(detail["changed"]).length;
      const removed = names(detail["removed"]).length;
      const parts: string[] = [];
      if (added) parts.push(`${added} added`);
      if (changed) parts.push(`${changed} changed`);
      if (removed) parts.push(`${removed} removed`);
      const mode = typeof detail["mode"] === "string" ? detail["mode"] : "merge";
      return `${mode}: ${parts.length > 0 ? parts.join(", ") : "no change"}`;
    }
    case "secret.read": {
      const reason = typeof detail["reason"] === "string" ? detail["reason"] : "reveal";
      const count = typeof detail["count"] === "number" ? detail["count"] : 1;
      return `${reason} · ${count} key${count === 1 ? "" : "s"}`;
    }
    case "secret.unreadable": {
      const keys = names(detail["keys"]);
      const kid = typeof detail["kid"] === "string" ? detail["kid"] : null;
      return `could not decrypt ${keys.join(", ")}${kid ? ` (key id ${kid})` : ""}`;
    }
    case "secret.version":
      return `${String(detail["key"])}: v${String(detail["from"])} → v${String(detail["to"])}`;
    case "secret.rename":
      return `${String(detail["from"])} → ${String(detail["to"])}`;
    case "resource": {
      const fields = names(detail["fields"]);
      return fields.length > 0
        ? `${String(detail["slug"])} (${fields.join(", ")})`
        : String(detail["slug"]);
    }
    case "grant":
      return `${String(detail["role"])} at ${String(detail["scopeType"])} scope for ${String(detail["subject"])}`;
    case "identity":
      return `${String(detail["subject"])} (${names(detail["fields"]).join(", ")})`;
    case "denial":
      return `needed ${String(detail["required"])} on a ${String(detail["resource"])} at ${String(detail["scope"])} scope`;
    default:
      return null;
  }
}

/** The keys a `secret.diff` row touched, for the expanded view. */
export function diffKeys(entry: AuditEntryView): {
  added: string[];
  changed: string[];
  removed: string[];
} | null {
  const detail = asDetail(entry.detail);
  if (!detail || detail["kind"] !== "secret.diff") return null;
  return {
    added: names(detail["added"]),
    changed: names(detail["changed"]),
    removed: names(detail["removed"]),
  };
}
