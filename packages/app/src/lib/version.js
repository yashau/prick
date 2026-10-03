// The web app's version. The ONLY place it is written down.
//
// `0.0.0-dev` in the tree, exactly like every other manifest: the git tag is the
// source of truth. `mise run app:set` (scripts/app.mjs) stamps the CalVer of an
// `app-v*` tag into this file before a deploy, and nothing else writes to it.
// Never hand-edit it and never commit a stamped value.
//
// Plain JavaScript rather than TypeScript so that `svelte.config.js` can import
// it as well as the Worker: SvelteKit's `version.name` and the API's `/health`
// then cannot disagree about which build is running.

/** CalVer `YYYY.MMDD.N` of an `app-v*` release, or `0.0.0-dev` if unstamped. */
export const APP_VERSION = "0.0.0-dev";
