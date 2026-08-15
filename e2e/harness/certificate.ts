/**
 * A self-signed X.509 certificate for `localhost`, built here rather than
 * shelled out to `openssl`.
 *
 * ---------------------------------------------------------------------------
 * WHY A CERTIFICATE IS NEEDED AT ALL
 * ---------------------------------------------------------------------------
 * `resolveCertsUrl` refuses anything that is not `https://`, and it is right to:
 * a JWKS fetched over plaintext can be substituted in transit, which turns key
 * substitution from a cryptographic attack into a network one. That refusal is
 * a property worth having, so the harness satisfies it instead of asking for it
 * to be relaxed -- it serves the mock Access JWKS over real TLS, with a
 * certificate `workerd` is told to trust for the duration of the run.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `openssl req -x509`
 * ---------------------------------------------------------------------------
 * The same reason `scripts/*` are Node ESM rather than shell: the repository is
 * authored on Windows, where `openssl` is present only if the developer
 * installed Git for Windows and happens to have its `usr/bin` on PATH. A suite
 * whose first step is "shell out to a binary mise does not pin" fails on a
 * clean machine for a reason that has nothing to do with the application.
 *
 * `node:crypto` generates key material but cannot emit a certificate, so the
 * DER is assembled here. The profile is fixed and small -- RSA-2048,
 * SHA-256, CN=localhost, SAN of `localhost` and `127.0.0.1` -- and
 * `assertUsable()` below performs a REAL TLS handshake against the result
 * before the run continues, so a mistake in this file is a loud failure in
 * `globalSetup` rather than a mystifying one an hour later.
 */

import { connect as tlsConnect, createServer as createTlsServer } from "node:tls";
import { generateKeyPairSync, sign, X509Certificate } from "node:crypto";

// ---------------------------------------------------------------------------
// Minimal DER
// ---------------------------------------------------------------------------

/** DER length: short form under 128, long form above. */
function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);

  const bytes: number[] = [];
  let remaining = size;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }

  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tagged(tag: number, contents: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(contents.length), contents]);
}

const sequence = (...parts: Buffer[]): Buffer => tagged(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tagged(0x31, Buffer.concat(parts));
const octetString = (value: Buffer): Buffer => tagged(0x04, value);
const utf8String = (value: string): Buffer => tagged(0x0c, Buffer.from(value, "utf8"));
const nullValue = (): Buffer => Buffer.from([0x05, 0x00]);
const boolean = (value: boolean): Buffer => tagged(0x01, Buffer.from([value ? 0xff : 0x00]));

/** An unsigned integer, with the leading zero DER requires when bit 7 is set. */
function integer(value: Buffer | number): Buffer {
  const bytes = typeof value === "number" ? Buffer.from([value]) : value;

  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00) start += 1;

  const trimmed = bytes.subarray(start);
  const needsPad = (trimmed[0] ?? 0) & 0x80;

  return tagged(0x02, needsPad ? Buffer.concat([Buffer.from([0x00]), trimmed]) : trimmed);
}

/** A BIT STRING with an explicit count of unused trailing bits. */
function bitString(value: Buffer, unusedBits = 0): Buffer {
  return tagged(0x03, Buffer.concat([Buffer.from([unusedBits]), value]));
}

/**
 * An OBJECT IDENTIFIER from its dotted form.
 *
 * Written out rather than table-driven so that adding an extension later does
 * not mean hand-encoding base-128 by eye.
 */
function objectIdentifier(dotted: string): Buffer {
  const parts = dotted.split(".").map((part) => Number.parseInt(part, 10));
  const [first = 0, second = 0, ...rest] = parts;

  const bytes: number[] = [first * 40 + second];

  for (const part of rest) {
    const chunk: number[] = [part & 0x7f];
    let remaining = part >>> 7;
    while (remaining > 0) {
      chunk.unshift((remaining & 0x7f) | 0x80);
      remaining >>>= 7;
    }
    bytes.push(...chunk);
  }

  return tagged(0x06, Buffer.from(bytes));
}

/** `[n]` EXPLICIT: a constructed context-specific tag wrapping the value. */
const explicit = (n: number, contents: Buffer): Buffer => tagged(0xa0 | n, contents);
/** `[n]` IMPLICIT primitive: the value's own tag replaced. */
const implicitPrimitive = (n: number, contents: Buffer): Buffer => tagged(0x80 | n, contents);

const OID = {
  sha256WithRsa: "1.2.840.113549.1.1.11",
  commonName: "2.5.4.3",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extendedKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

/** `AlgorithmIdentifier` for sha256WithRSAEncryption. NULL params, per RFC 4055. */
const signatureAlgorithm = (): Buffer => sequence(objectIdentifier(OID.sha256WithRsa), nullValue());

/** `Name` carrying a single CN. */
const distinguishedName = (commonName: string): Buffer =>
  sequence(set(sequence(objectIdentifier(OID.commonName), utf8String(commonName))));

/** UTCTime, `YYMMDDHHMMSSZ`. Valid until 2049, which is long enough. */
function utcTime(when: Date): Buffer {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const text =
    pad(when.getUTCFullYear() % 100) +
    pad(when.getUTCMonth() + 1) +
    pad(when.getUTCDate()) +
    pad(when.getUTCHours()) +
    pad(when.getUTCMinutes()) +
    pad(when.getUTCSeconds()) +
    "Z";

  return tagged(0x17, Buffer.from(text, "ascii"));
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return critical
    ? sequence(objectIdentifier(oid), boolean(true), octetString(value))
    : sequence(objectIdentifier(oid), octetString(value));
}

// ---------------------------------------------------------------------------
// The certificate
// ---------------------------------------------------------------------------

export interface SelfSignedCertificate {
  /** PEM, for `tls.createServer({ cert })` and for `SSL_CERT_FILE`. */
  certificatePem: string;
  /** PEM, for `tls.createServer({ key })`. Never leaves this machine. */
  privateKeyPem: string;
}

/**
 * A self-signed certificate for `localhost` / `127.0.0.1`.
 *
 * `basicConstraints: CA:TRUE` because the certificate is simultaneously the
 * trust anchor (it is what `SSL_CERT_FILE` names) and the leaf the server
 * presents. `keyCertSign` is set for the same reason -- a trust anchor that is
 * not permitted to sign certificates is rejected by some verifiers even when it
 * signs only itself.
 */
export function createSelfSignedCertificate(validForDays = 2): SelfSignedCertificate {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  // Node exports SubjectPublicKeyInfo directly, which is exactly the field the
  // certificate needs -- there is no reason to re-encode the modulus by hand.
  const spki = publicKey.export({ type: "spki", format: "der" });

  const notBefore = new Date(Date.now() - 60 * 60 * 1000);
  const notAfter = new Date(Date.now() + validForDays * 24 * 60 * 60 * 1000);

  const name = distinguishedName("localhost");

  const subjectAltName = sequence(
    implicitPrimitive(2, Buffer.from("localhost", "ascii")),
    implicitPrimitive(7, Buffer.from([127, 0, 0, 1])),
  );

  const extensions = explicit(
    3,
    sequence(
      extension(OID.basicConstraints, true, sequence(boolean(true))),
      // digitalSignature (0), keyEncipherment (2), keyCertSign (5).
      extension(OID.keyUsage, true, bitString(Buffer.from([0xa4]), 2)),
      extension(OID.extendedKeyUsage, false, sequence(objectIdentifier(OID.serverAuth))),
      extension(OID.subjectAltName, false, subjectAltName),
    ),
  );

  const tbs = sequence(
    explicit(0, integer(2)), // v3
    integer(Buffer.from([0x01, ...cryptoSerial()])),
    signatureAlgorithm(),
    name,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    name,
    spki,
    extensions,
  );

  const signatureValue = sign("sha256", tbs, privateKey);

  const certificate = sequence(tbs, signatureAlgorithm(), bitString(signatureValue));

  return {
    certificatePem: toPem("CERTIFICATE", certificate),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Seven random bytes behind a fixed leading `0x01`, so the serial is positive. */
function cryptoSerial(): Uint8Array {
  const bytes = new Uint8Array(7);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function toPem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body}${body.endsWith("\n") ? "" : "\n"}-----END ${label}-----\n`;
}

/**
 * Prove the certificate actually works before anything depends on it.
 *
 * A real TLS handshake against a real server, verified against the certificate
 * as the ONLY trust anchor and with `servername: "localhost"`, so both the
 * signature and the subjectAltName are exercised. Hand-assembled DER is exactly
 * the kind of code that is subtly wrong in a way no unit test of its parts would
 * catch, and the failure it produces two steps later ("Could not reach the
 * Access certs endpoint") points at the wrong file entirely.
 */
export async function assertUsable(certificate: SelfSignedCertificate): Promise<void> {
  const parsed = new X509Certificate(certificate.certificatePem);

  if (!parsed.subjectAltName?.includes("DNS:localhost")) {
    throw new Error(`The generated certificate has no localhost SAN: ${parsed.subjectAltName}`);
  }

  const server = createTlsServer(
    { cert: certificate.certificatePem, key: certificate.privateKeyPem },
    (socket) => {
      socket.end("ok");
    },
  );

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The verification server did not bind to a port.");
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const socket = tlsConnect(
        {
          host: "127.0.0.1",
          port: address.port,
          servername: "localhost",
          ca: [certificate.certificatePem],
        },
        () => {
          if (!socket.authorized) {
            reject(
              new Error(
                `The generated certificate did not verify: ${socket.authorizationError?.message ?? "unknown reason"}`,
              ),
            );
            socket.destroy();
            return;
          }
          socket.end();
          resolve();
        },
      );

      socket.on("error", reject);
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
