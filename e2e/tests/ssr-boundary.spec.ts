/**
 * THE SSR BOUNDARY.
 *
 * `packages/app/src/routes/(app)/p/[project]/[env]/+layout.ts` sets
 * `ssr = false`, and that one line is the mechanism by which a secret value
 * cannot reach the page payload: no server render means no `__sveltekit_data`
 * script, which means there is nothing for a value -- or a key name -- to leak
 * into.
 *
 * Everything below asserts on the RAW HTML of the response, never on the
 * rendered DOM. Those are different documents and only one of them is the
 * thing at risk: the rendered DOM is what the browser built after fetching
 * values over `fetch`, while the raw HTML is what is written to a proxy log, a
 * `view-source:`, a back/forward cache entry and any middlebox between the
 * Worker and the browser. Asserting on the DOM would be asserting on the wrong
 * artefact and would pass no matter what the payload contained.
 *
 * The positive control at the bottom is what makes the rest of the file mean
 * something: a server-RENDERED screen is shown to serialise its data, so
 * "nothing was found" here cannot be quietly explained by the fetch having
 * failed or by SvelteKit having stopped emitting payloads at all.
 */

import { environmentPath, expect, test } from "../fixtures";
import { SEED, SEEDED_SECRETS, STAGING_SECRETS } from "../harness/constants";

const SECRET_SUBTREE = [
  `/p/${SEED.project}/${SEED.production}`,
  `/p/${SEED.project}/${SEED.production}/history`,
];

test.describe("the ssr = false subtree", () => {
  for (const path of SECRET_SUBTREE) {
    test(`serves no value and no key name at ${path}`, async ({ context }) => {
      const response = await context.request.get(path);
      expect(response.status()).toBe(200);

      const html = await response.text();

      // The page renders at all -- so this is a real document, not an error.
      expect(html).toContain("<!doctype html>");

      /*
       * NO PAYLOAD AT ALL.
       *
       * SvelteKit hands hydration data to the client as the THIRD argument of
       * the inline `kit.start(app, element, { node_ids, data })` call. With
       * `ssr = false` inherited from the layout, the emitted call is
       * `kit.start(app, element);` -- no third argument, so not even the parent
       * layout's project list is serialised, let alone anything from this
       * environment.
       */
      expect(html).toContain("kit.start(app, element)");
      expect(html, "the shell must carry no hydration payload").not.toContain("node_ids");
      expect(html).not.toContain('type:"data"');

      // No VALUE. These are the real, encrypted-at-rest values that
      // `globalSetup` wrote through the API -- not fixture strings compiled
      // into the bundle, which would prove nothing about D1.
      for (const value of Object.values(SEEDED_SECRETS)) {
        expect(html, `the raw HTML of ${path} must not contain a secret value`).not.toContain(
          value,
        );
      }

      // No KEY NAME either. Key names are plaintext metadata by design, and
      // they are still an inventory of what this environment holds.
      for (const key of Object.keys(SEEDED_SECRETS)) {
        expect(html, `the raw HTML of ${path} must not contain a key name`).not.toContain(key);
      }
    });
  }

  /**
   * The values are not in the JavaScript either.
   *
   * `ssr = false` closes the payload. This closes the other half: every script
   * the page loads is fetched and searched, so a value that reached the browser
   * through a bundled constant rather than through the payload would fail here.
   * It is the assertion that stays true after the client is cut over to the
   * real API, when the payload check alone would start being the only one.
   */
  test("no served script carries a seeded value", async ({ page, context }) => {
    const scripts = new Set<string>();
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.add(request.url());
    });

    await page.goto(`/p/${SEED.project}/${SEED.production}`, { waitUntil: "networkidle" });
    expect(scripts.size, "the page should have loaded at least one script").toBeGreaterThan(0);

    const values = [...Object.values(SEEDED_SECRETS), ...Object.values(STAGING_SECRETS)];

    for (const url of scripts) {
      const body = await (await context.request.get(url)).text();
      for (const value of values) {
        expect(body, `${url} must not contain a secret value`).not.toContain(value);
      }
    }
  });

  /**
   * THE POSITIVE CONTROL.
   *
   * A server-rendered screen DOES serialise its data into the document. Without
   * this, every assertion above would also pass against a Worker that had
   * stopped rendering anything at all, and the suite would report a security
   * property it was no longer testing.
   */
  test("a server-rendered screen does embed its payload", async ({ context }) => {
    const html = await (await context.request.get("/projects")).text();

    // The third argument the secrets shell does not have.
    expect(html).toContain("node_ids");
    expect(html).toContain('type:"data"');
    expect(html.length).toBeGreaterThan(2000);
  });

  /**
   * And the value IS obtainable -- over `fetch`, from the API, one key at a
   * time, audited. Otherwise "the value is not in the HTML" would be satisfied
   * by an application that could not read secrets at all.
   */
  test("the value reaches the browser only through /api/v1", async ({ api }) => {
    const path = `${environmentPath(SEED.project, SEED.production)}/secrets/DATABASE_URL`;
    const revealed = await api.raw(`${path}?reason=reveal`);

    expect(revealed.status).toBe(200);
    expect((revealed.body as { value: string }).value).toBe(SEEDED_SECRETS["DATABASE_URL"]);
  });
});
