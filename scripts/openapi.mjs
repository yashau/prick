#!/usr/bin/env node
/**
 * Write `docs/openapi.json`, or fail if it is stale.
 *
 *   node scripts/openapi.mjs write    regenerate the committed document
 *   node scripts/openapi.mjs check    exit 1 if the committed document differs
 *
 * The document is generated from the Worker's ROUTE TABLE, so `check` is a real
 * freshness gate rather than a formatting one: adding a route, renaming a path,
 * changing a request schema or altering a status code all change the output.
 * Committing the result means the API surface appears in a pull request diff
 * even when the change that produced it is three files away.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS UNDER PLAIN NODE, AND WHAT IT COSTS
 * ---------------------------------------------------------------------------
 * The obvious alternative -- generate the document from inside the Vitest
 * workers pool, where module resolution already works -- cannot write a file:
 * workerd has no filesystem. So this imports the Hono application directly.
 *
 * That works because nothing in the `http/` graph needs workerd: `hono`,
 * `drizzle-orm` and `zod` are ordinary packages, and the two Web APIs the crypto
 * module touches (`crypto.subtle`, `atob`) are globals in Node 26. No Worker is
 * started and no request is served -- `generateSpecs` reads `hono.routes`, which
 * is populated by `createApi()` alone.
 *
 * The one thing that does not work out of the box is module specifiers. Both
 * `packages/app/src` and `packages/shared/src` import each other's siblings as
 * `./x.js` (correct for a bundler, and required by `verbatimModuleSyntax`),
 * while the files on disk are `./x.ts`. Node's type stripping deliberately does
 * NOT map one onto the other, so the import fails on `ERR_MODULE_NOT_FOUND` for
 * a file that was never meant to exist. The hook below closes exactly that gap
 * and nothing else -- relative specifiers only, inside `packages/` only, only
 * when the `.js` is absent and the `.ts` is present. A general "try .ts if .js
 * is missing" rule would change how every dependency in the process resolves,
 * which is a strange thing to switch on in order to serialise a JSON document.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT = join(ROOT, 'docs', 'openapi.json');

/**
 * Module specifiers are file URLs, not paths.
 *
 * `import()` of an absolute Windows path (`C:\...`) is rejected by the ESM
 * loader as an unsupported URL scheme -- it reads `c:` as the protocol. This
 * repository is authored on Windows and built on a three-OS matrix, so the URL
 * form is the only one that works everywhere.
 */
const APP = new URL('../packages/app/src/lib/server/http/app.ts', import.meta.url).href;
const OPENAPI = new URL('../packages/app/src/lib/server/http/openapi.ts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;

    if (
      parent !== undefined &&
      parent.startsWith(new URL('../packages/', import.meta.url).href) &&
      specifier.startsWith('.') &&
      specifier.endsWith('.js')
    ) {
      const asJs = new URL(specifier, parent);
      const asTs = new URL(`${specifier.slice(0, -'.js'.length)}.ts`, parent);

      if (!existsSync(fileURLToPath(asJs)) && existsSync(fileURLToPath(asTs))) {
        return { url: asTs.href, format: 'module-typescript', shortCircuit: true };
      }
    }

    return nextResolve(specifier, context);
  },
});

/**
 * Serialise deterministically.
 *
 * Two properties matter, and only one of them is obvious. The formatting has to
 * be stable so `check` compares content rather than whitespace -- but the KEY
 * ORDER has to be stable too, and it is not by default: `generateSpecs` builds
 * `paths` by iterating the route table and merging objects, so a route
 * registered in a different order produces the same document with the keys
 * rearranged. Sorting them makes a reordered mount a no-op in the diff and a
 * genuinely new route a one-hunk addition.
 */
function stableStringify(value) {
  const sorted = sortKeys(value);
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeys(/** @type {Record<string, unknown>} */ (value)[key]);
  }
  return out;
}

async function generate() {
  const [{ createApi }, { generateDocument }] = await Promise.all([import(APP), import(OPENAPI)]);

  return stableStringify(await generateDocument(createApi()));
}

const command = process.argv[2] ?? 'write';

if (command !== 'write' && command !== 'check') {
  process.stderr.write(`usage: node scripts/openapi.mjs [write|check]\n`);
  process.exit(2);
}

const generated = await generate();

if (command === 'write') {
  writeFileSync(OUTPUT, generated, 'utf8');
  process.stdout.write(`wrote docs/openapi.json (${String(generated.length)} bytes)\n`);
} else {
  const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';

  if (committed !== generated) {
    process.stderr.write(
      'docs/openapi.json is stale.\n' +
        'The API surface changed but the committed document did not.\n' +
        'Run: mise run openapi\n',
    );
    process.exit(1);
  }

  process.stdout.write('docs/openapi.json is up to date\n');
}
