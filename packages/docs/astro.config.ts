import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

import { SITE_TAGLINE, SITE_TITLE, sidebarGroups, warnIfDocsMissing } from "./docs-source";

warnIfDocsMissing();

export default defineConfig({
  // The public docs hostname. Used for canonical URLs, the sitemap and Open
  // Graph tags.
  //
  // This MUST be the hostname that actually serves the site: the `routes` block
  // in `wrangler.jsonc` puts the Worker on `docs.getprick.dev` as a custom
  // domain, and with workers.dev and preview URLs switched off there, that is
  // the only hostname which answers. Advertising a canonical URL on a hostname
  // that answers nothing tells every crawler the real page is a duplicate of one
  // that does not exist, and keeps the site out of the index entirely -- so this
  // is a correctness setting, not a cosmetic one.
  //
  // Change it and the `routes` block in `wrangler.jsonc` in the same commit,
  // never one without the other. scripts/docs.test.mjs asserts they agree.
  site: "https://docs.getprick.dev",

  // ---------------------------------------------------------------------------
  // Fully static. There is no server.
  //
  // This site has no database, no authentication and no secrets, so there is
  // nothing for a Worker to do that the assets runtime cannot do faster. That
  // is also why `@astrojs/cloudflare` is NOT a dependency: an SSR adapter would
  // buy nothing here and would add a runtime to keep patched.
  // ---------------------------------------------------------------------------
  output: "static",

  // Trailing-slash-free URLs, matching `html_handling: auto-trailing-slash` on
  // the assets runtime.
  build: { format: "directory" },

  // ---------------------------------------------------------------------------
  // `security.csp` is deliberately LEFT OFF. This was tried, measured, and
  // rejected -- do not switch it on without repeating the measurement.
  //
  // Astro's CSP support hashes the inline <script> and <style> ELEMENTS it
  // emits and ships the policy as a <meta> tag. Enabling it here produced
  // `style-src 'self' <2 hashes>` -- and a single built page carries 299 inline
  // `style="..."` ATTRIBUTES, from Starlight's own components (`--sl-icon-size`
  // on every icon) and from Expressive Code's syntax highlighting.
  //
  // Hashes do not authorise style attributes; only `'unsafe-inline'` or
  // `'unsafe-hashes'` does, and both are ignored once a hash-source is present
  // in the same directive. So the generated policy blocks all 299 of them. That
  // is not a cosmetic problem: several are `style="display: none;"`, and a
  // blocked `display: none` fails OPEN -- collapsed menus and the search modal
  // render permanently visible.
  //
  // Astro says as much itself at build time:
  //   "Shiki syntax highlighting uses inline styles that are not compatible
  //    with Content Security Policy (CSP)."
  //
  // The policy therefore lives entirely in `public/_headers`, where it is a
  // real header rather than a <meta> tag -- which it has to be anyway, because
  // `frame-ancestors` is specified to be ignored in meta CSP.
  // ---------------------------------------------------------------------------

  integrations: [
    starlight({
      title: SITE_TITLE,
      description: `${SITE_TAGLINE} -- a self-hosted secrets manager that runs on one Cloudflare Worker and a D1 database.`,

      tagline: SITE_TAGLINE,

      // The mark alone, with Starlight rendering `title` as text beside it.
      // `lockup.svg` bakes the wordmark into the artwork, which makes the site's
      // name an image: not selectable, not searchable, and fixed at one colour
      // in both themes. As text it is none of those things, and it is the same
      // string the `<title>` is composed from, so the header and the tab cannot
      // drift apart.
      //
      // Both variants point at the same file: the mark is legible on either
      // background, so a second asset would be a second thing to keep in sync
      // for no gain.
      logo: {
        light: "./src/assets/logo.svg",
        dark: "./src/assets/logo.svg",
      },

      social: [{ icon: "github", label: "GitHub", href: "https://github.com/yashau/prick" }],

      // Pagefind. Starlight builds the index as part of a static build and
      // serves it from `/pagefind/`; it is stated explicitly here because it is
      // a feature this site is required to have, not an implementation detail
      // that may be silently defaulted away.
      pagefind: true,

      // The dark/light toggle is Starlight's default and is left on. Stated for
      // the same reason.
      // (`defaultProps.themeToggle` does not exist; the control is unconditional.)

      // Edit links are built in `src/routeData.ts`, NOT here. See that file for
      // why `editLink.baseUrl` cannot be used when content is loaded from
      // outside `src/content/docs/`.
      routeMiddleware: "./src/routeData.ts",

      // Autogenerated from the directory structure, in a fixed group order.
      // Adding a page to an existing directory requires no change here.
      sidebar: sidebarGroups(),

      // Starlight ships a 404 route out of the box. Overriding it would mean
      // adding a file to `docs/`, which belongs to another workstream, so the
      // built-in page stands. `wrangler.jsonc` points `not_found_handling` at
      // the `/404.html` it produces.
    }),
  ],
});
