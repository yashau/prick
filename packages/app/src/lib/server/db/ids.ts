/**
 * UUIDv7 generation.
 *
 * TODO(build order step 9): implement. `crypto.randomUUID()` is v4 and is NOT
 * a substitute -- v4 ids have no temporal ordering, which makes
 * `WHERE id > :cursor ORDER BY id` return arbitrary rows and turns audit-log
 * keyset pagination into a silently wrong feature rather than a broken one.
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
export function uuidv7(_now: number = Date.now()): string {
  throw new Error("uuidv7() is not implemented yet");
}

/**
 * Extract the embedded millisecond timestamp from a UUIDv7.
 *
 * TODO(build order step 9): implement. Used to render "when" in the audit log
 * without a second column, and to sanity-check a client-supplied cursor.
 */
export function uuidv7Timestamp(_id: string): number {
  throw new Error("uuidv7Timestamp() is not implemented yet");
}
