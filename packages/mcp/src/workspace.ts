import { relative as relativePath, resolve as resolvePath, sep } from "node:path";

import { ToolError } from "./errors.ts";

/**
 * The boundary around the one tool that touches the local disk.
 *
 * `secrets_diff` takes a filesystem path, and the thing that supplies it is a
 * language model that has been reading whatever the user pointed it at. A path
 * arriving over the wire is therefore no more trustworthy than the document it
 * came from, and "read the key names out of ~/.aws/credentials" is a sentence
 * somebody can put in a README.
 *
 * THE SHAPE IS THE ENFORCEMENT. There is no list of forbidden paths to keep up
 * to date. Every path is resolved against ONE directory that the operator fixed
 * before the transport was connected, and a path that does not land inside it
 * does not reach the disk. `..`, an absolute path elsewhere and a symbolic link
 * pointing out of the tree are all the same case, because all three are decided
 * by comparing a resolved path against a resolved root rather than by
 * recognising a shape of string.
 *
 * The comparison happens twice, in two different places, on purpose:
 *
 * - LEXICALLY in `secretsDiff`, before anything is opened. A path that is
 *   already outside is refused without a `stat`, and a `stat` on an attacker's
 *   path is itself an answer -- it says whether the file exists.
 * - CANONICALLY in the reader, after `realpath`. A link inside the workspace
 *   that points out of it is invisible to any amount of string handling.
 */

/**
 * Windows paths compare without case; POSIX ones compare with it.
 *
 * Folded on `win32` only. On a case-sensitive volume -- which macOS can be
 * formatted as -- folding would make `/Root/x` look like it sits under `/root`,
 * and those are two different directories. Being wrong in that direction opens
 * exactly the hole this module exists to close.
 */
const CASE_INSENSITIVE = process.platform === "win32";

function fold(path: string): string {
  return CASE_INSENSITIVE ? path.toLowerCase() : path;
}

/**
 * Is `candidate` the root itself, or something beneath it?
 *
 * Both sides go through `resolve`, which normalises separators, collapses `..`
 * and anchors a drive-relative Windows path. The separator is appended before
 * the prefix test so that `/srv/app-secrets` is not read as living inside
 * `/srv/app`.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = fold(resolvePath(root));
  const resolvedCandidate = fold(resolvePath(candidate));

  if (resolvedCandidate === resolvedRoot) return true;

  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedCandidate.startsWith(prefix);
}

export interface WorkspacePath {
  /** Absolute and normalised. The only form handed to a filesystem call. */
  absolute: string;
  /** Root-relative. The only form allowed to leave this process. */
  display: string;
}

/**
 * The refusal, as one function so that both checks refuse identically.
 *
 * It quotes the caller's own argument back and NOTHING ELSE. Naming the root,
 * or the absolute path the argument resolved to, would answer "where does this
 * operator keep their projects, and under what user name" -- which is a
 * question the caller asked and this server declines to answer.
 */
export function outsideWorkspace(display: string): ToolError {
  return new ToolError("INVALID_INPUT", "That path is outside this server's workspace.", {
    path: display,
    hint: "env_file must name a file inside the directory this server was started in. Relative paths resolve against it; `..`, an absolute path elsewhere, and a symbolic link leading out of it are all refused.",
  });
}

/**
 * Resolve an `env_file` argument against the workspace root.
 *
 * Absolute paths are accepted rather than rejected outright: an MCP client that
 * knows where the project lives will send one, and refusing it would push the
 * caller into constructing a relative path to the same file. What matters is
 * where the path lands, not how it was written.
 */
export function resolveWithinRoot(root: string, requested: string): WorkspacePath {
  const absolute = resolvePath(root, requested);

  // The refusal quotes the caller's own argument, not the relative form: for a
  // path that escaped, the relative form is a run of `..` segments that maps
  // out the tree above the root.
  if (!isWithinRoot(root, absolute)) throw outsideWorkspace(requested);

  return { absolute, display: relativePath(root, absolute) };
}
