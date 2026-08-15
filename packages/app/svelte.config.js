import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/**
 * NOTE ON THE VITE SETUP -- this is a settled decision, do not "fix" it.
 *
 * This app uses SvelteKit's own Vite plugin plus `@sveltejs/adapter-cloudflare`.
 * It deliberately does NOT use `@cloudflare/vite-plugin`: that plugin and
 * SvelteKit both want to own the server environment, and the pairing is
 * unsupported (workers-sdk#8922, closed unresolved). Real bindings in `vite dev`
 * come from the adapter's `platformProxy`, which runs the same miniflare that
 * `wrangler dev` does.
 *
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter({
      // Read the real deployment config so `vite dev` and `wrangler deploy`
      // cannot disagree about which bindings exist.
      config: "./wrangler.jsonc",

      platformProxy: {
        configPath: "./wrangler.jsonc",
        // Keep local D1 state on disk between `vite dev` restarts. Without
        // this every restart is an empty database and no migration you are
        // testing ever runs twice.
        persist: true,
      },
    }),

    // -----------------------------------------------------------------------
    // Content Security Policy.
    //
    // `mode: 'auto'` makes SvelteKit emit nonces for server-rendered pages and
    // hashes for prerendered ones. Combined with 'strict-dynamic' that means
    // no host allowlist is trusted for scripts at all -- only the loader
    // SvelteKit itself nonces, and whatever that loader pulls in.
    //
    // TWO GAPS THIS DOES NOT CLOSE, both handled in `static/_headers`:
    //
    //  1. On PRERENDERED pages SvelteKit has no response to attach a header to,
    //     so it emits the policy as a <meta> tag -- and `frame-ancestors` is
    //     specified to be IGNORED in meta CSP. Clickjacking protection must
    //     therefore also arrive as a real header.
    //  2. Static assets are served by the Workers assets runtime WITHOUT
    //     invoking the Worker, so no Hono middleware can add headers to them.
    // -----------------------------------------------------------------------
    csp: {
      mode: "auto",
      directives: {
        "default-src": ["none"],
        "script-src": ["self", "strict-dynamic"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:"],
        "font-src": ["self"],
        // Same-origin only. The UI talks to /api/v1 on this very Worker; there
        // is no third-party telemetry endpoint and there must never be one.
        "connect-src": ["self"],
        "manifest-src": ["self"],
        "form-action": ["self"],
        "base-uri": ["none"],
        "frame-ancestors": ["none"],
        "object-src": ["none"],
        // No service worker is registered anywhere in this app. A SW cache is
        // a plaintext secret store on disk; blocking the directive means an
        // accidental registration fails loudly instead of shipping.
        "worker-src": ["none"],
        "upgrade-insecure-requests": true,
      },
    },

    // Same-origin-only form posts are already covered by `form-action 'self'`;
    // this is SvelteKit's own CSRF check on top. The empty list is the point:
    // NO cross-origin form submission is trusted, and adding an entry here has
    // to be argued with against this comment.
    csrf: {
      trustedOrigins: [],
    },

    version: {
      // The release pipeline stamps this from the git tag. In-repo it is the
      // placeholder, matching every other version representation in the tree.
      name: "0.0.0-dev",
    },
  },
};

export default config;
