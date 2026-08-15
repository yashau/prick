import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Let the drift test import `@prick/shared` from source.
 *
 * `@prick/shared` publishes nothing: its `exports` map points straight at
 * `src/index.ts`, which is the right call for a private package consumed only by
 * bundlers. Node can load that file -- pnpm links the workspace package and Node
 * resolves the symlink to its real path, which is outside `node_modules`, so
 * type stripping applies -- but the modules INSIDE it import each other with
 * `.js` specifiers (`./limits.js`), and Node's type stripping deliberately does
 * not map `./x.js` onto `./x.ts`.
 *
 * So the import fails on `ERR_MODULE_NOT_FOUND` for a file that was never meant
 * to exist. This hook closes exactly that gap and nothing else:
 *
 *   - only relative specifiers ending in `.js`
 *   - only when the importing module lives under `packages/shared/`
 *   - only when the `.js` does not exist and a sibling `.ts` does
 *
 * It is scoped that tightly on purpose. A general "try .ts if .js is missing"
 * rule would change how every dependency in the test process resolves, which is
 * a strange thing to switch on in order to compare five regular expressions.
 *
 * This file is test-only: `package.json` ships `dist/` and `README.md`, so it
 * is not in the published artefact, and `tsconfig.build.json` compiles `src/`
 * only, so it is not in the build either.
 */

const SHARED_PREFIX = new URL("../../../shared/", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;

    if (
      parent !== undefined &&
      parent.startsWith(SHARED_PREFIX) &&
      specifier.startsWith(".") &&
      specifier.endsWith(".js")
    ) {
      const asJs = new URL(specifier, parent);
      const asTs = new URL(`${specifier.slice(0, -".js".length)}.ts`, parent);

      if (!existsSync(fileURLToPath(asJs)) && existsSync(fileURLToPath(asTs))) {
        return { url: asTs.href, format: "module-typescript", shortCircuit: true };
      }
    }

    return nextResolve(specifier, context);
  },
});
