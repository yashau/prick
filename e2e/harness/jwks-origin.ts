/**
 * The mock Cloudflare Access origin.
 *
 * One HTTPS endpoint, `/cdn-cgi/access/certs`, serving the public half of the
 * keypair `access.ts` generated. `workerd` fetches it through the ordinary
 * `fetch()` in `jwks.ts` -- there is no interception, no stub and no injected
 * key set, which is the point: the caching, the TTL, the unknown-`kid` refetch
 * and the `alg`-from-the-JWKS-entry rule are all exercised as written.
 *
 * ---------------------------------------------------------------------------
 * WHY IT COUNTS ITS OWN REQUESTS
 * ---------------------------------------------------------------------------
 * `globalSetup` asserts that it was hit at least once before the suite starts.
 * Without that check, a harness whose TLS trust silently stopped working would
 * present as forty authentication failures with no indication that the JWKS
 * fetch was the cause.
 *
 * ---------------------------------------------------------------------------
 * WHY `127.0.0.1` AND NOT `localhost`
 * ---------------------------------------------------------------------------
 * `localhost` resolves to `::1` before `127.0.0.1` on a default Windows stack
 * and the other way round elsewhere, so a server bound to one of them is
 * unreachable through the name on the other. The literal removes the ambiguity,
 * and it does not weaken the check: the certificate carries `IP:127.0.0.1` in
 * its subjectAltName, and verifying an IP literal is a real SAN match rather
 * than a skipped one.
 */

import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";

import type { SelfSignedCertificate } from "./certificate";

export interface JwksOrigin {
  /** The value `ACCESS_CERTS_URL` is set to. */
  certsUrl: string;
  /** How many times the Worker has fetched the key set. */
  hits(): number;
  close(): Promise<void>;
}

const CERTS_PATH = "/cdn-cgi/access/certs";

export async function startJwksOrigin(
  certificate: SelfSignedCertificate,
  jwksDocument: string,
): Promise<JwksOrigin> {
  let hits = 0;

  const server: Server = createServer(
    { cert: certificate.certificatePem, key: certificate.privateKeyPem },
    (request, response) => {
      if (request.url !== CERTS_PATH) {
        // Loud rather than a 200 with an empty key set: a Worker asking this
        // origin for anything else means the certs URL has drifted, and an
        // empty JWKS would surface as "unknown signing key" three layers away.
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found", path: request.url ?? "" }));
        return;
      }

      hits += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(jwksDocument);
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    certsUrl: `https://127.0.0.1:${String(address.port)}${CERTS_PATH}`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
