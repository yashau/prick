import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// SvelteKit + Tailwind v4. `@cloudflare/vite-plugin` is deliberately absent --
// see the note at the top of svelte.config.js. Cloudflare bindings in
// `vite dev` come from the adapter's platformProxy, not from a second plugin
// fighting SvelteKit for ownership of the server environment.
//
// Tailwind v4 has no `tailwind.config.js`: the theme is declared in CSS via
// `@theme` in `src/app.css`, which is where the shadcn-svelte design tokens
// live. The Vite plugin is the whole of the build-side configuration.
export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
});
