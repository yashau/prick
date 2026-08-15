import { describe, expect, it } from "vitest";

import { classifyClaims, type AccessClaims } from "../../src/lib/server/auth/claims.js";
import { throwsWith } from "./rejects.js";

const BASE = {
  iss: "https://test-team.cloudflareaccess.com",
  aud: ["test-aud"],
  exp: 2_000_000_000,
} satisfies Pick<AccessClaims, "iss" | "aud" | "exp">;

function claims(extra: Partial<AccessClaims>): AccessClaims {
  return { ...BASE, sub: "", ...extra };
}

describe("classifyClaims -- accepted", () => {
  it("maps a human token to a lower-cased email subject", () => {
    expect(classifyClaims(claims({ sub: "uuid-here", email: "Operator@Example.COM" }))).toEqual({
      kind: "user",
      subject: "operator@example.com",
    });
  });

  it("trims surrounding whitespace from the email", () => {
    expect(classifyClaims(claims({ sub: "uuid", email: "  ops@example.com \t" }))).toEqual({
      kind: "user",
      subject: "ops@example.com",
    });
  });

  /**
   * The machine-client shape: EMPTY `sub`, a `common_name`, no `email`, no
   * `nbf`. Every one of those is what a verifier written against the human
   * shape gets wrong.
   */
  it("maps a service token to its opaque common_name", () => {
    expect(
      classifyClaims(claims({ sub: "", common_name: "e367826f93b8d71185e03fe518aff3b4.access" })),
    ).toEqual({ kind: "service", subject: "e367826f93b8d71185e03fe518aff3b4.access" });
  });

  it("does not lower-case a common_name", () => {
    expect(classifyClaims(claims({ sub: "", common_name: "AbCdEf.access" }))).toEqual({
      kind: "service",
      subject: "AbCdEf.access",
    });
  });
});

describe("classifyClaims -- rejected", () => {
  const rejected: [name: string, input: Partial<AccessClaims>][] = [
    ["neither an email nor a common_name", { sub: "uuid" }],
    ["neither, with an empty sub", { sub: "" }],
    ["both an email and a common_name", { sub: "uuid", email: "a@b.c", common_name: "x.access" }],
    ["both, with an empty sub", { sub: "", email: "a@b.c", common_name: "x.access" }],
    ["an email but an empty sub", { sub: "", email: "a@b.c" }],
    ["a common_name but a non-empty sub", { sub: "uuid", common_name: "x.access" }],
    ["an email that is only whitespace", { sub: "uuid", email: "   " }],
    ["a common_name that is only whitespace", { sub: "", common_name: "   " }],
    ["an empty email", { sub: "uuid", email: "" }],
  ];

  for (const [name, input] of rejected) {
    it(`REJECTS claims carrying ${name}`, () => {
      throwsWith(() => classifyClaims(claims(input)), "UNAUTHENTICATED");
    });
  }

  it("REJECTS a non-string sub rather than coercing it", () => {
    throwsWith(
      () => classifyClaims({ ...BASE, sub: undefined as unknown as string, email: "a@b.c" }),
      "UNAUTHENTICATED",
    );
  });

  it("never produces an empty subject", () => {
    // An identity keyed on "" is one that every future subject collides with.
    for (const [, input] of rejected) {
      let subject: string | null = null;
      try {
        subject = classifyClaims(claims(input)).subject;
      } catch {
        subject = null;
      }
      expect(subject).not.toBe("");
    }
  });
});
