import adapter from "@sveltejs/adapter-cloudflare";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

import { APP_VERSION } from "./src/lib/version.js";

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
 * The whole SvelteKit configuration is the argument to `sveltekit()` below.
 *
 * Tailwind v4 has no `tailwind.config.js`: the theme is declared in CSS via
 * `@theme` in `src/app.css`, which is where the shadcn-svelte design tokens
 * live. The Vite plugin is the whole of the build-side configuration.
 */
export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      preprocess: vitePreprocess(),

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

      // SvelteKit's own origin check is OFF here and ON in `hooks.server.ts`,
      // with the same rule, for every path outside `/api`: the framework runs
      // its check before any hook, where it refuses the CLI's bodiless DELETEs
      // before the Hono app and its own guard ever see them. See
      // `src/lib/server/csrf.ts`. NO cross-origin form submission to the admin
      // UI is trusted, and widening that has to be argued with against that
      // file, not this list.
      csrf: {
        trustedOrigins: ["*"],
      },

      version: {
        // The same value `/health` reports, from the one stamped module. In-repo
        // it is `0.0.0-dev`; `mise run app:set` stamps an `app-v*` release.
        name: APP_VERSION,
      },
    }),
  ],
});
