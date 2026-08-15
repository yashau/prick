import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// Just SvelteKit. `@cloudflare/vite-plugin` is deliberately absent -- see the
// note at the top of svelte.config.js. Cloudflare bindings in `vite dev` come
// from the adapter's platformProxy, not from a second plugin fighting SvelteKit
// for ownership of the server environment.
export default defineConfig({
  plugins: [sveltekit()],
});
