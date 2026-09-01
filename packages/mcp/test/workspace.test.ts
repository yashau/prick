import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test, { after, describe } from "node:test";

import { PrickApiClient } from "../src/api.ts";
import { ToolError } from "../src/errors.ts";
import { secretsDiff, type ToolContext } from "../src/tools.ts";
import { isWithinRoot, resolveWithinRoot } from "../src/workspace.ts";
import { capturingLogger, jsonResponse, stubConfig, stubFetch, type StubCall } from "./helpers.ts";

/**
 * `secrets_diff` is the only tool that reads the local disk, and the path comes
 * from a language model. These tests are the ones that say the model cannot
 * choose which file that is.
 *
 * A refused path must be refused BEFORE the API is called, so every case here
 * also asserts on the recorded calls: a refusal that still hits the network has
 * told the far side that somebody asked.
 */

// The sandbox goes through `realpath` because the OS temp directory is itself a
// symbolic link on macOS (/tmp -> /private/tmp) and often a junction on
// Windows. Comparing a canonical path against an uncanonicalised root is
// exactly the bug the second check in the reader exists to catch, and a fixture
// that reproduced it would fail every test here for the wrong reason.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "prick-mcp-workspace-")));

const root = join(sandbox, "project");
const outside = join(sandbox, "elsewhere");
/** Shares a textual prefix with the root without being inside it. */
const lookalike = `${root}-backup`;

mkdirSync(root);
mkdirSync(join(root, "config"));
mkdirSync(outside);
mkdirSync(lookalike);

writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://hunter2@db/app\nONLY_LOCAL=x\n");
writeFileSync(join(outside, "credentials"), "AWS_SECRET_ACCESS_KEY=hunter2\n");
writeFileSync(join(lookalike, ".env"), "SHOULD_NOT_BE_READ=1\n");

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** `true` when this platform let us create the link; symlinks need a privilege on Windows. */
function trySymlink(target: string, link: string, type: "file" | "junction" = "file"): boolean {
  try {
    symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

function diffContext(): { ctx: ToolContext; calls: StubCall[] } {
  const config = stubConfig({ workspaceRoot: root });
  const logger = capturingLogger();
  const stub = stubFetch(() => jsonResponse({ secrets: [{ key: "DATABASE_URL", version: 1 }] }));

  return {
    ctx: {
      client: new PrickApiClient(config, logger.logger, stub.fetch),
      config,
      logger: logger.logger,
    },
    calls: stub.calls,
  };
}

async function refusal(envFile: string): Promise<ToolError> {
  const { ctx, calls } = diffContext();

  try {
    await secretsDiff(ctx, { project: "app", environment: "prod", env_file: envFile });
  } catch (error) {
    assert.ok(error instanceof ToolError, "expected a ToolError");
    assert.equal(calls.length, 0, "the path was refused, so nothing should have been requested");
    return error;
  }

  assert.fail(`secrets_diff read "${envFile}", which is outside the workspace`);
}

describe("isWithinRoot", () => {
  test("the root itself and anything under it", () => {
    assert.ok(isWithinRoot(root, root));
    assert.ok(isWithinRoot(root, join(root, ".env")));
    assert.ok(isWithinRoot(root, join(root, "config", "local.env")));
  });

  test("a sibling that merely starts with the root's name is not inside it", () => {
    // The separator in the prefix test is what decides this one: without it
    // `/srv/app-backup` reads as living under `/srv/app`.
    assert.equal(isWithinRoot(root, join(lookalike, ".env")), false);
  });

  test("`..` does not climb out, however it is spelled", () => {
    assert.equal(isWithinRoot(root, join(root, "..", "elsewhere", "credentials")), false);
    assert.equal(isWithinRoot(root, join(root, "config", "..", "..", "elsewhere")), false);
    // ...and a `..` that comes back is still inside.
    assert.ok(isWithinRoot(root, join(root, "config", "..", ".env")));
  });

  test("an unrelated absolute path is outside", () => {
    assert.equal(isWithinRoot(root, join(outside, "credentials")), false);
    assert.equal(isWithinRoot(root, sandbox), false);
  });

  test("case is folded on Windows and only on Windows", () => {
    const shouted = root.toUpperCase();

    if (process.platform === "win32") {
      // `C:\Project` and `c:\project` are one directory here, and a client that
      // sends a drive letter in the other case is not attacking anything.
      assert.ok(isWithinRoot(root, join(shouted, ".env")));
    } else {
      // On a case-sensitive filesystem they are two directories, and treating
      // them as one would be the hole this module exists to close.
      assert.equal(isWithinRoot(root, join(shouted, ".env")), false);
    }
  });
});

describe("resolveWithinRoot", () => {
  test("a relative path resolves against the root and is reported relative to it", () => {
    assert.deepEqual(resolveWithinRoot(root, ".env"), {
      absolute: join(root, ".env"),
      display: ".env",
    });
    assert.deepEqual(resolveWithinRoot(root, `.${sep}config${sep}local.env`), {
      absolute: join(root, "config", "local.env"),
      display: join("config", "local.env"),
    });
  });

  test("an absolute path inside the root is accepted", () => {
    // A client that knows where the project is will send one of these, and
    // refusing it would only teach the caller to write `..`-free relatives.
    assert.equal(resolveWithinRoot(root, join(root, ".env")).display, ".env");
  });

  test("the refusal quotes the argument back and nothing else", () => {
    const requested = join("..", "elsewhere", "credentials");

    assert.throws(
      () => resolveWithinRoot(root, requested),
      (error: unknown) => {
        assert.ok(error instanceof ToolError);
        assert.equal(error.code, "INVALID_INPUT");
        assert.equal(error.detail.path, requested);

        // Naming the root, or what the argument resolved to, would answer
        // "where does this operator keep their projects" for free.
        const said = `${error.message}${error.detail.hint ?? ""}`;
        assert.ok(!said.includes(root), "the refusal named the workspace root");
        assert.ok(!said.includes(sandbox), "the refusal mapped out the filesystem");
        return true;
      },
    );
  });
});

describe("secrets_diff path containment", () => {
  test("the ordinary case still works: a .env in the project it was started in", async () => {
    const { ctx, calls } = diffContext();

    const result = await secretsDiff(ctx, {
      project: "app",
      environment: "prod",
      env_file: ".env",
    });

    assert.equal(result.env_file, ".env");
    assert.deepEqual(result.in_both, ["DATABASE_URL"]);
    assert.deepEqual(result.only_in_file, ["ONLY_LOCAL"]);
    assert.equal(calls.length, 1);
  });

  test("an absolute path inside the workspace works, and is reported relative", async () => {
    const { ctx } = diffContext();

    const result = await secretsDiff(ctx, {
      project: "app",
      environment: "prod",
      env_file: join(root, ".env"),
    });

    // Reported relative even though it was given absolute: the operator's
    // directory layout does not travel back with the answer.
    assert.equal(result.env_file, ".env");
  });

  test("`..` traversal is refused", async () => {
    const error = await refusal(join("..", "elsewhere", "credentials"));

    assert.equal(error.code, "INVALID_INPUT");
    assert.match(error.message, /outside this server's workspace/);
  });

  test("an absolute path elsewhere on the machine is refused", async () => {
    assert.equal((await refusal(join(outside, "credentials"))).code, "INVALID_INPUT");
  });

  test("a sibling directory sharing the root's name prefix is refused", async () => {
    assert.equal((await refusal(join(lookalike, ".env"))).code, "INVALID_INPUT");
  });

  test("a symbolic link pointing out of the workspace is refused", async (t) => {
    const link = join(root, "linked.env");

    if (!trySymlink(join(outside, "credentials"), link)) {
      t.skip("this platform does not permit creating symbolic links here");
      return;
    }

    // Nothing about the string "linked.env" is suspicious. Only `realpath`
    // knows, which is why the reader checks a second time.
    const error = await refusal("linked.env");
    assert.equal(error.code, "INVALID_INPUT");
    assert.equal(error.detail.path, "linked.env");
  });

  test("a linked DIRECTORY leading out of the workspace is refused too", async (t) => {
    // The Windows form of the same attack, and the one that runs unprivileged
    // there: a junction is a directory link any user can create. On POSIX the
    // type argument is ignored and this is an ordinary symbolic link.
    const link = join(root, "vendor");

    if (!trySymlink(outside, link, "junction")) {
      t.skip("this platform does not permit creating directory links here");
      return;
    }

    const error = await refusal(join("vendor", "credentials"));
    assert.equal(error.code, "INVALID_INPUT");
  });

  test("a symbolic link that stays inside the workspace is followed", async (t) => {
    const link = join(root, "alias.env");

    if (!trySymlink(join(root, ".env"), link)) {
      t.skip("this platform does not permit creating symbolic links here");
      return;
    }

    const { ctx } = diffContext();
    const result = await secretsDiff(ctx, {
      project: "app",
      environment: "prod",
      env_file: "alias.env",
    });

    assert.deepEqual(result.in_both, ["DATABASE_URL"]);
  });

  test("a missing file inside the workspace is a LOCAL_FILE error, not a refusal", async () => {
    // The two failures have to stay distinguishable: "you may not read that" is
    // advice the caller can act on, "it is not there" is a different fix.
    const error = await refusal("not-here.env");

    assert.equal(error.code, "LOCAL_FILE");
    assert.equal(error.detail.path, "not-here.env");
  });

  test("a directory inside the workspace is not a regular file", async () => {
    const error = await refusal("config");

    assert.equal(error.code, "LOCAL_FILE");
    assert.match(error.message, /not a regular file/);
  });
});
