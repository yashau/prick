/**
 * UUIDv7 generation.
 *
 * `crypto.randomUUID()` is v4 and is NOT a substitute -- v4 ids have no
 * temporal ordering, which makes `WHERE id > :cursor ORDER BY id` return
 * arbitrary rows and turns audit-log keyset pagination into a silently wrong
 * feature rather than a broken one.
 *
 * Layout (RFC 9562 section 5.7):
 *
 *   48 bits  unix_ts_ms   big-endian milliseconds
 *    4 bits  version      0b0111
 *   12 bits  rand_a       monotonic counter within the same millisecond
 *    2 bits  variant      0b10
 *   62 bits  rand_b       CSPRNG
 *
 * The `rand_a` counter matters: two ids minted in the same millisecond must
 * still order deterministically, or a cursor can skip or repeat a row at a
 * millisecond boundary under load.
 */

/** Widest value the 48-bit timestamp field can hold: the year 10889. */
const MAX_TIMESTAMP_MS = 0xffff_ffff_ffff;

/** The 12-bit `rand_a` counter is exhausted after this many ids in one ms. */
const MAX_COUNTER = 0x0fff;

let lastTimestamp = -1;
let counter = 0;

/**
 * Advance the monotonic state.
 *
 * Two cases that are easy to get wrong and both produce a broken cursor:
 *
 *   the clock going BACKWARDS -- NTP corrections do this -- must not emit an id
 *   that sorts before one already handed out, so the previous timestamp is kept
 *   and the counter advances instead.
 *
 *   the counter overflowing within one millisecond must borrow from the next
 *   millisecond rather than wrap, which would repeat an id.
 */
function advance(now: number): { timestamp: number; sequence: number } {
  const requested = Math.max(0, Math.min(MAX_TIMESTAMP_MS, Math.floor(now)));

  if (requested > lastTimestamp) {
    lastTimestamp = requested;
    counter = 0;
    return { timestamp: lastTimestamp, sequence: counter };
  }

  counter += 1;

  if (counter > MAX_COUNTER) {
    lastTimestamp += 1;
    counter = 0;
  }

  return { timestamp: lastTimestamp, sequence: counter };
}

export function uuidv7(now: number = Date.now()): string {
  const { timestamp, sequence } = advance(now);

  const random = crypto.getRandomValues(new Uint8Array(8));
  // Variant 0b10 in the top two bits of byte 8.
  random[0] = ((random[0] ?? 0) & 0x3f) | 0x80;

  const timestampHex = timestamp.toString(16).padStart(12, "0");
  // Version 0b0111 in the top nibble, then the 12-bit counter.
  const versionHex = (0x7000 | sequence).toString(16).padStart(4, "0");
  const randomHex = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return [
    timestampHex.slice(0, 8),
    timestampHex.slice(8, 12),
    versionHex,
    randomHex.slice(0, 4),
    randomHex.slice(4, 16),
  ].join("-");
}

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Extract the embedded millisecond timestamp from a UUIDv7.
 *
 * Used to render "when" in the audit log without a second column, and to
 * sanity-check a client-supplied cursor. A v4 id -- or anything else -- is
 * rejected rather than reinterpreted, because a cursor whose timestamp is
 * nonsense produces a page of rows that looks plausible and is wrong.
 */
export function uuidv7Timestamp(id: string): number {
  if (!UUIDV7_PATTERN.test(id)) {
    throw new Error("not a UUIDv7");
  }

  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
