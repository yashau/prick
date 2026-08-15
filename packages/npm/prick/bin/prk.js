#!/usr/bin/env node
"use strict";

/*
 * =============================================================================
 * @yashau/prick -- launcher shim.
 *
 * THIS PACKAGE HAS NO `scripts` FIELD, AND THAT IS THE POINT.
 *
 * There is no postinstall, no preinstall, no prepare. Nothing downloads, no
 * network request is made, and no code executes at install time. The real
 * binary arrives as an ordinary `optionalDependencies` entry that npm resolves
 * from the platform fields in its manifest, which means:
 *
 *   - `npm install --ignore-scripts` works exactly like a normal install, and
 *     that is precisely the flag a security-conscious user of a SECRETS MANAGER
 *     runs;
 *   - the install needs no egress beyond the registry it is already talking to;
 *   - every byte is covered by the lockfile's integrity hash and by npm
 *     provenance attestation;
 *   - a corporate registry mirror can cache all of it.
 *
 * The alternative -- one package that downloads a binary from GitHub Releases
 * in a postinstall -- fails all four. It is disqualifying here.
 *
 * All this file does is find the right prebuilt binary and hand control to it.
 * =============================================================================
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const manifest = require("../package.json");

const BIN_NAME = process.platform === "win32" ? "prk.exe" : "prk";

/** Every platform package that is ever published, for the error message. */
const SUPPORTED = [
  "@yashau/prick-darwin-arm64",
  "@yashau/prick-darwin-x64",
  "@yashau/prick-linux-arm64-gnu",
  "@yashau/prick-linux-arm64-musl",
  "@yashau/prick-linux-x64-gnu",
  "@yashau/prick-linux-x64-musl",
  "@yashau/prick-win32-arm64-msvc",
  "@yashau/prick-win32-x64-msvc",
];

/**
 * Work out which platform package should be installed.
 *
 * detect-libc is called HERE, by us, rather than relying on npm's `libc`
 * manifest field. pnpm honours that field; npm's support for it is partial, so
 * on npm a glibc host can end up with the musl package installed (or neither)
 * and the failure surfaces as a confusing exec error rather than as a resolution
 * problem. Doing the detection ourselves means the diagnosis is ours to make.
 *
 * Returns `{ pkg, label }`, or `{ pkg: null, label }` for a platform we do not
 * build for at all -- the two cases need different advice.
 */
function detectTarget() {
  const { platform, arch } = process;

  if (platform === "linux") {
    // Loaded lazily so a darwin/win32 user is never affected by a problem in
    // this dependency.
    let family = null;
    try {
      family = require("detect-libc").familySync();
    } catch {
      // Detection failed. glibc is the overwhelmingly more common case, and
      // guessing wrong here produces a clear "install this instead" error
      // rather than a wrong answer.
      family = null;
    }
    const libc = family === "musl" ? "musl" : "gnu";
    const label = `${platform}-${arch}-${libc}`;

    if (arch === "x64" || arch === "arm64") {
      return { pkg: `@yashau/prick-linux-${arch}-${libc}`, label };
    }
    return { pkg: null, label };
  }

  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) {
    return { pkg: `@yashau/prick-darwin-${arch}`, label: `${platform}-${arch}` };
  }

  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    return { pkg: `@yashau/prick-win32-${arch}-msvc`, label: `${platform}-${arch}` };
  }

  return { pkg: null, label: `${platform}-${arch}` };
}

function resolveBinary(pkgName) {
  // Platform packages declare no `exports` field, so a direct subpath resolve
  // works and is the cheapest path.
  try {
    const direct = require.resolve(`${pkgName}/bin/${BIN_NAME}`);
    if (fs.existsSync(direct)) return direct;
  } catch {
    /* fall through */
  }

  // Fallback: locate the package root via its manifest and join. Survives an
  // `exports` map being added to the platform packages later.
  try {
    const root = path.dirname(require.resolve(`${pkgName}/package.json`));
    const candidate = path.join(root, "bin", BIN_NAME);
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* fall through */
  }

  return null;
}

/**
 * Never a bare MODULE_NOT_FOUND stack trace.
 *
 * The message names the platform we detected, the exact package that provides
 * it, and the command that installs it -- because the three realistic causes
 * (`--omit=optional`, a lockfile built on another OS, a genuinely unsupported
 * platform) look identical from a stack trace and need different fixes.
 */
function reportMissing(target) {
  const { pkg, label } = target;
  const version = manifest.version;
  const lines = [];

  lines.push(`prk: no prebuilt binary available for this platform.`);
  lines.push("");
  lines.push(`  detected      ${label}`);
  lines.push(`  node          ${process.version}`);

  if (pkg === null) {
    lines.push("");
    lines.push("This platform is not one that prick publishes binaries for.");
    lines.push("");
    lines.push("Supported platforms:");
    for (const name of SUPPORTED) lines.push(`  ${name}`);
    lines.push("");
    lines.push(
      "Build from source instead:  cargo install --git https://github.com/yashau/prick prk",
    );
    process.stderr.write(lines.join("\n") + "\n");
    return;
  }

  lines.push(`  expected      ${pkg}@${version}`);
  lines.push("");
  lines.push(`${pkg} is an optionalDependency of ${manifest.name} and was not`);
  lines.push("installed. The usual causes:");
  lines.push("");
  lines.push("  * the install ran with --omit=optional / --no-optional");
  lines.push("  * the lockfile was generated on a different platform or libc");
  lines.push("  * the package was pruned by a Docker multi-stage copy");
  lines.push("");
  lines.push("Install it directly:");
  lines.push("");
  lines.push(`  npm install ${pkg}@${version}`);
  lines.push("");

  process.stderr.write(lines.join("\n") + "\n");
}

function main() {
  const target = detectTarget();
  const binary = target.pkg === null ? null : resolveBinary(target.pkg);

  if (binary === null) {
    reportMissing(target);
    process.exit(127);
  }

  /*
   * Hold SIGINT and SIGTERM while the child runs.
   *
   * Without this the shim dies first on Ctrl-C and the terminal is handed back
   * while the real process is still running -- and, worse, whatever the child
   * was doing gets no chance to finish. Registering a no-op listener suppresses
   * Node's default action; the child receives the signal from the terminal's
   * process group as normal and decides what to do about it.
   */
  const held = ["SIGINT", "SIGTERM", "SIGHUP"];
  const noop = () => {};
  for (const signal of held) {
    try {
      process.on(signal, noop);
    } catch {
      /* not available on this platform */
    }
  }

  const result = spawnSync(binary, process.argv.slice(2), {
    stdio: "inherit",
    windowsHide: true,
  });

  for (const signal of held) process.removeListener(signal, noop);

  if (result.error) {
    process.stderr.write(`prk: failed to execute ${binary}\n${String(result.error.message)}\n`);
    process.exit(126);
  }

  /*
   * RE-RAISE the signal rather than translating it to an exit code.
   *
   * Translating to 128+n makes `prk` look like it EXITED with a large status;
   * re-raising makes the shell see the same termination reason the real binary
   * had. That is what keeps `WIFSIGNALED` true for a caller, keeps bash's job
   * control and `trap` behaving, and keeps `prk run -- <cmd>` faithful to the
   * child it wraps -- which is the entire premise of that subcommand.
   *
   * The listeners are removed above, so this restores the default action and
   * terminates the process. The 128+n exit is only reached if the signal turns
   * out to be blocked or unsupported (Windows, mainly).
   */
  if (result.signal) {
    try {
      process.kill(process.pid, result.signal);
    } catch {
      /* fall through to the numeric translation */
    }
    const number = os.constants.signals[result.signal];
    process.exit(typeof number === "number" ? 128 + number : 1);
  }

  process.exit(result.status === null ? 1 : result.status);
}

main();
