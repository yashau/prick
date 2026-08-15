import { readFileSync } from "node:fs";

/**
 * The server identity reported in the MCP `initialize` response.
 *
 * The version is READ FROM `package.json` AT STARTUP rather than written here
 * as a literal. Versions in this repository are machine-managed -- every
 * manifest carries `0.0.0-dev` and the release pipeline stamps the real CalVer
 * into them before compiling -- so a hand-written constant would be a second
 * representation of the version, which is exactly the thing that drifts.
 *
 * The relative URL resolves identically from `src/version.ts` and from
 * `dist/version.js`: both are one directory below the package root.
 */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version: unknown = (parsed as { version: unknown }).version;
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // A packaging accident must not stop the server from serving. Fall through.
  }

  return "0.0.0-dev";
}

export const SERVER_NAME = "prick-mcp";
export const SERVER_VERSION: string = readPackageVersion();
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
