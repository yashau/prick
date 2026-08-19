import { describe, expect, it } from "vitest";

import { initialsFor } from "../../src/lib/client/format.js";

/**
 * THE AVATAR'S TWO LETTERS.
 *
 * Small surface, one real bug: initials taken from an address used to be
 * computed over the whole string, so the second letter came from the DOMAIN.
 * Everyone at one organisation then shared it, which defeats the only thing an
 * avatar is for.
 */
describe("initialsFor", () => {
  it("takes a name over an address, first and last word", () => {
    expect(initialsFor({ displayName: "John Doe", subject: "jdoe@corp.example.com" })).toBe("JD");
  });

  it("skips middle names rather than letting them displace the surname", () => {
    expect(
      initialsFor({ displayName: "Ada Grace King Lovelace", subject: "ada@example.com" }),
    ).toBe("AL");
  });

  it("NEVER takes a letter from the domain", () => {
    // The regression. `jdoe@corp.example.com` split on every separator gives
    // ["jdoe", "corp", ...] -- and "JC" reads as a set of initials while half
    // of it stands for the employer.
    const initials = initialsFor({ displayName: null, subject: "jdoe@corp.example.com" });

    expect(initials).toBe("JD");
    expect(initials).not.toBe("JC");
  });

  it("does not collide for two colleagues on one domain", () => {
    // Both used to render "JC": first letter of the local part, then the
    // domain's. This is the case the bug was worst in.
    const one = initialsFor({ displayName: null, subject: "jdoe@corp.example.com" });
    const two = initialsFor({ displayName: null, subject: "jsmith@corp.example.com" });

    expect(one).toBe("JD");
    expect(two).toBe("JS");
    expect(one).not.toBe(two);
  });

  it("uses both parts of a structured local part", () => {
    for (const subject of [
      "john.doe@example.com",
      "john_doe@example.com",
      "john-doe@example.com",
    ]) {
      expect(initialsFor({ displayName: null, subject })).toBe("JD");
    }

    // A `+tag` suffix is a separator too, so the tag supplies the second letter
    // rather than the domain.
    expect(initialsFor({ displayName: null, subject: "john+doe@example.com" })).toBe("JD");
  });

  it("falls back to the subject for a service token, which has no name", () => {
    // A `common_name` carries no `@`, so the local-part split leaves it whole.
    expect(
      initialsFor({ displayName: null, subject: "e367826f93b8d71185e03fe518aff3b4.access" }),
    ).toBe("EA");
  });

  it("treats a blank display name as absent rather than rendering nothing", () => {
    expect(initialsFor({ displayName: "   ", subject: "jdoe@corp.example.com" })).toBe("JD");
  });

  it("counts code points, so a name outside the BMP is not cut in half", () => {
    const initials = initialsFor({ displayName: "𝒜da", subject: "a@example.com" });

    expect([...initials]).toHaveLength(2);
  });

  it("answers something rather than an empty badge", () => {
    expect(initialsFor({ displayName: null, subject: "" })).toBe("?");
    expect(initialsFor({ displayName: null, subject: "@example.com" })).toBe("?");
  });
});
