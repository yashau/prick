import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

import { DOCS_BASE, DOCS_PATTERN } from "../docs-source";

/**
 * The `docs` collection is loaded from the repository-root `docs/` directory.
 *
 * WHY NOT `docsLoader()`:
 *
 * Starlight ships `docsLoader()` from `@astrojs/starlight/loaders`, and it is
 * the right thing to use when content lives in `src/content/docs/`. It cannot
 * be used here: it computes its own base from the Astro config
 * (`getCollectionPathFromRoot`) and exposes no option to override it -- the
 * only knob it accepts is `generateId`. Verified by reading
 * `node_modules/@astrojs/starlight/loaders.ts` at 0.41.7, not by inference.
 *
 * So we call Astro's `glob()` loader directly with the same extension list and
 * the same underscore-prefix exclusion that `docsLoader()` applies, and pair it
 * with `docsSchema()` -- which is the part that actually matters, since that is
 * what gives every page `title`, `description`, `sidebar`, `tableOfContents`,
 * `editUrl` and the rest of Starlight's frontmatter contract.
 *
 * `base` is resolved by Astro against the project root, so it reads the files
 * where they already are. Nothing is copied and nothing is symlinked.
 */
export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: DOCS_PATTERN, base: DOCS_BASE }),
    schema: docsSchema(),
  }),
};
