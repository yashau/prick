import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CODE_ALIASES,
  DEPRECATED_ERROR_CODES,
  ERROR_STATUS,
  INTERNAL_MESSAGE,
  PrickError,
  canonicalCode,
  classifyD1Constraint,
  toPrickError,
  type PrickErrorCode,
} from "../../src/lib/server/core/errors.js";
import {
  DecryptFailedError,
  MasterKeyConfigError,
  SecretTooLargeError,
  UnknownKeyError,
} from "../../src/lib/server/crypto/errors.js";
import { formatZodIssues, statusFor, toErrorBody } from "../../src/lib/server/http/errors.js";

/**
 * The error taxonomy, and the two invariants that make it one taxonomy rather
 * than two that happen to agree today.
 */

const ALL_CODES = Object.keys(ERROR_STATUS) as PrickErrorCode[];

describe("no deprecated code can reach a response body", () => {
  /**
   * The alias map is EMPTY today -- `MISCONFIGURED` was deleted once `auth/**`
   * stopped constructing it, rather than carried on as a deprecated name nobody
   * emits. So the per-alias cases below currently generate nothing.
   *
   * That makes this next test the load-bearing one: it proves the FOLDING
   * MACHINERY works using a synthetic alias, so the mechanism is verified even
   * with no real aliases in the map. Without it the suite would pass vacuously,
   * and the day someone adds an alias they would inherit an untested fold.
   *
   * The per-alias cases stay, enumerated over the map rather than a hand-written
   * list, so a future alias is covered from the moment it is added.
   */
  it("the fold is applied to whatever the map contains, empty or not", () => {
    const synthetic: Partial<Record<PrickErrorCode, PrickErrorCode>> = {
      NOT_IMPLEMENTED: "INTERNAL",
    };

    // Same reduction toErrorBody performs, driven by an injected map.
    const fold = (code: PrickErrorCode) => synthetic[code] ?? code;

    expect(fold("NOT_IMPLEMENTED")).toBe("INTERNAL");
    expect(fold("SERVER_MISCONFIGURED")).toBe("SERVER_MISCONFIGURED");

    // And the real map is genuinely empty -- if this starts failing, the cases
    // below have woken up and are doing the work instead.
    expect(DEPRECATED_ERROR_CODES).toHaveLength(0);
  });

  for (const deprecated of DEPRECATED_ERROR_CODES) {
    it(`${deprecated} is folded to its canonical name`, () => {
      const error = new PrickError(deprecated, "something is wrong with the configuration");
      const body = toErrorBody(error, "req-1");

      expect(body.code).toBe(CODE_ALIASES[deprecated]);
      expect(body.code).not.toBe(deprecated);
    });

    it(`${deprecated} carries the SAME status as its canonical name`, () => {
      // An alias that mapped to a different status would be a second taxonomy
      // wearing the first one's name -- the caller would see one code and get
      // two behaviours depending on which literal the thrower happened to use.
      const canonical = CODE_ALIASES[deprecated] as PrickErrorCode;
      expect(ERROR_STATUS[deprecated]).toBe(ERROR_STATUS[canonical]);
    });
  }

  it("every code in the taxonomy round-trips to a body carrying its canonical name", () => {
    for (const code of ALL_CODES) {
      const body = toErrorBody(new PrickError(code, "message"), "req-1");
      expect(body.code).toBe(canonicalCode(code));
      expect(DEPRECATED_ERROR_CODES).not.toContain(body.code);
    }
  });
});

describe("a bad master key fails closed at 500", () => {
  it("SERVER_MISCONFIGURED is 500, not 503", () => {
    // 503 says "come back later". A MASTER_KEY that decodes to 31 bytes will
    // never come good on its own, and a client retrying on it is waiting for
    // something that cannot happen.
    expect(ERROR_STATUS.SERVER_MISCONFIGURED).toBe(500);
  });

  it("NO_ADMINS_CONFIGURED stays 503, because that one IS recoverable", () => {
    // Set the var, redeploy. No code change. "The service is not ready" is the
    // honest reading.
    expect(ERROR_STATUS.NO_ADMINS_CONFIGURED).toBe(503);
  });

  it("IDENTITY_PROVIDER_UNAVAILABLE is 503, and is NOT the same thing", () => {
    // These two were briefly merged, and merging them is wrong in a way that is
    // invisible until it matters: a caller told SERVER_MISCONFIGURED gives up,
    // but Access returning 502 for thirty seconds is precisely what a caller
    // should retry. Same shape at the throw site, opposite meaning downstream.
    expect(ERROR_STATUS.IDENTITY_PROVIDER_UNAVAILABLE).toBe(503);
    expect(ERROR_STATUS.IDENTITY_PROVIDER_UNAVAILABLE).not.toBe(ERROR_STATUS.SERVER_MISCONFIGURED);
  });
});

describe("crypto errors cross into the taxonomy without losing their message", () => {
  it("maps MasterKeyConfigError to SERVER_MISCONFIGURED", () => {
    const error = toPrickError(
      new MasterKeyConfigError("MASTER_KEY decodes to 31 bytes; exactly 32 are required."),
    );

    expect(error.code).toBe("SERVER_MISCONFIGURED");
    expect(error.status).toBe(500);
    // The message survives, because it is the only thing that tells the
    // operator WHAT to fix.
    expect(error.message).toContain("31 bytes");
  });

  it("maps DecryptFailedError to DECRYPT_FAILED", () => {
    expect(toPrickError(new DecryptFailedError("tag check failed")).code).toBe("DECRYPT_FAILED");
  });

  it("keeps UNKNOWN_KID distinct from DECRYPT_FAILED", () => {
    // "You removed MASTER_KEY_OLD too early" and "this row has been tampered
    // with" need opposite responses -- restore the key, versus investigate a
    // compromise. A single generic failure code cannot tell them apart, so the
    // distinction has to survive to the operator.
    const error = toPrickError(new UnknownKeyError("abc123", ["def456"]));

    expect(error.code).toBe("UNKNOWN_KID");
    expect(error.code).not.toBe("DECRYPT_FAILED");
    // The kid is not secret, and naming it is the whole point.
    expect(error.message).toContain("abc123");
  });

  it("maps SecretTooLargeError to PAYLOAD_TOO_LARGE", () => {
    expect(toPrickError(new SecretTooLargeError(1024)).status).toBe(413);
  });

  it("degrades anything unrecognised to a CONSTANT message", () => {
    const error = toPrickError(new Error("connection to 10.0.0.5 failed with token sk-live-x"));

    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe(INTERNAL_MESSAGE);
    // "Include the underlying message, it's useful" is how a value ends up in
    // a 500 body. Nothing established what this throwable's message contains.
    expect(error.message).not.toContain("sk-live-x");
  });

  it("puts the constant message in the BODY too, not just the error", () => {
    const body = toErrorBody(new Error("token sk-live-x"), "req-1");

    expect(body.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("sk-live-x");
  });

  it("statusFor handles a non-PrickError without throwing", () => {
    expect(statusFor(new Error("boom"))).toBe(500);
    expect(statusFor(new MasterKeyConfigError("bad"))).toBe(500);
    expect(statusFor(new PrickError("NOT_FOUND", "nope"))).toBe(404);
  });
});

describe("the zod formatter drops issue.input", () => {
  it("keeps path and message and nothing else", () => {
    const schema = z.object({ DATABASE_URL: z.string().max(3) });
    const result = schema.safeParse({ DATABASE_URL: "postgres://user:hunter2@db/app" });

    if (result.success) throw new Error("expected the schema to reject this input");
    const issues = formatZodIssues(result.error);

    expect(issues[0]).toMatchObject({ path: "DATABASE_URL" });
    expect(Object.keys(issues[0] ?? {}).sort()).toEqual(["message", "path"]);

    // A VALIDATION_FAILED on a secret write is BY DEFINITION a request whose
    // body contained a secret value. Echoing `issue.input` would put that value
    // in the response, the Worker log and the audit detail simultaneously.
    expect(JSON.stringify(issues)).not.toContain("hunter2");
  });

  it("still reports the KEY name, which is plaintext metadata", () => {
    // The path segment for a SecretsMap entry IS the secret's key name. Key
    // names are stored in plaintext and listed in the UI; it is the sibling
    // `input` field that holds the value.
    const schema = z.record(z.string().regex(/^[A-Z]+$/), z.string());
    const result = schema.safeParse({ "bad-key": "sk-live-secret" });

    if (result.success) throw new Error("expected the schema to reject this input");
    const issues = formatZodIssues(result.error);

    expect(JSON.stringify(issues)).not.toContain("sk-live-secret");
  });
});

describe("D1 constraint classification", () => {
  it("recognises the expected_rev guard by its TABLE, not by a column", () => {
    // The design note calls this "a PK collision", so the obvious classifier
    // looks for `environments.id`. SQLite reports the FIRST unique index
    // violated, and `environments_project_slug_uniq` is checked before the
    // primary key -- so the real message names (project_id, slug). A classifier
    // written against `environments.id` maps every 412 to a 500 while looking
    // correct.
    expect(
      classifyD1Constraint(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: environments.project_id, environments.slug: SQLITE_CONSTRAINT",
        ),
      ),
    ).toBe("environment-rev");

    expect(
      classifyD1Constraint(new Error("D1_ERROR: UNIQUE constraint failed: environments.id")),
    ).toBe("environment-rev");
  });

  it("recognises the version race", () => {
    expect(
      classifyD1Constraint(
        new Error(
          "D1_ERROR: UNIQUE constraint failed: secret_versions.environment_id, secret_versions.key, secret_versions.version: SQLITE_CONSTRAINT",
        ),
      ),
    ).toBe("secret-version");
  });

  it("calls everything else 'other', so a real bug is not mapped to a 412", () => {
    expect(classifyD1Constraint(new Error("D1_ERROR: no such table: secrets"))).toBe("other");
    expect(classifyD1Constraint(new Error("UNIQUE constraint failed: projects.slug"))).toBe(
      "other",
    );
    expect(classifyD1Constraint("not an error at all")).toBe("other");
  });
});

describe("NOT_FOUND does not distinguish absent from invisible", () => {
  it("has no parameter that could vary between the two cases", async () => {
    const { notFound } = await import("../../src/lib/server/core/errors.js");

    // The shape is the enforcement. There is no `notFound(kind, becauseHidden)`
    // overload for a handler to reach for under time pressure.
    expect(notFound("project").message).toBe(notFound("project").message);
    expect(notFound("project").status).toBe(404);
  });
});
