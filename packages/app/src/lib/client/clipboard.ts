import { api } from "./api.js";
import { ApiError } from "./errors.js";

/**
 * Clipboard handling for secret values.
 *
 * Two rules here are load-bearing rather than stylistic.
 *
 * 1. COPY REFETCHES. It never reads the value out of `reveal.svelte.ts`, even
 *    when the value is sitting right there and revealed. Taking a value and
 *    looking at one are different acts with different consequences, and the
 *    audit log can only distinguish them if the copy is its own request. The
 *    cost is one round trip; the benefit is that "who took this value" is
 *    answerable.
 *
 * 2. NO `document.execCommand("copy")` FALLBACK. That API requires the value
 *    to exist in a focused, selected DOM node -- exactly the thing this whole
 *    design refuses to do. On a browser without the async Clipboard API the
 *    honest outcome is a failure the user can see, not a value written into
 *    the document to work around it.
 */

/** How long a copied secret is left on the clipboard before it is overwritten. */
export const CLIPBOARD_CLEAR_MS = 30_000;

export class ClipboardUnavailableError extends Error {
  constructor() {
    super(
      "This browser will not give the page clipboard access. Reveal the value and copy it manually.",
    );
    this.name = "ClipboardUnavailableError";
  }
}

function clipboard(): Clipboard {
  // `navigator.clipboard` is undefined on insecure origins and in some
  // embedded webviews. Checked rather than assumed, because the failure is
  // otherwise a rejected promise with a message nobody can act on.
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new ClipboardUnavailableError();
  }
  return navigator.clipboard;
}

/**
 * Overwrite the clipboard, but only while this document still has focus.
 *
 * The focus check is the entire subtlety. If the user has copied a value and
 * moved on -- pasted it into a terminal, then copied something else entirely --
 * clearing on a timer would silently destroy whatever they are holding now.
 * Clipboard hygiene is not worth stomping unrelated user data for, so the
 * clear happens only in the case where the clipboard is plausibly still ours.
 *
 * Writing a single space rather than an empty string: several platforms treat
 * an empty write as a no-op and leave the previous contents in place.
 */
function scheduleClear(): void {
  setTimeout(() => {
    if (typeof document === "undefined" || !document.hasFocus()) return;
    void navigator.clipboard?.writeText(" ").catch(() => {
      // A denied clipboard write at this point is not actionable and must not
      // surface as an error toast half a minute after an action succeeded.
    });
  }, CLIPBOARD_CLEAR_MS);
}

/**
 * Fetch a secret value and put it on the clipboard.
 *
 * Produces one `secret.reveal` audit row with `reason: "copy"`, every time.
 */
export async function copySecretValue(
  project: string,
  environment: string,
  key: string,
): Promise<void> {
  const target = clipboard();
  const value = await api.revealSecret(project, environment, key, "copy");
  await target.writeText(value);
  scheduleClear();
}

/**
 * Copy something that is NOT a secret: a request id, a key name, a slug.
 *
 * No timed clear -- there is nothing here worth stomping a user's clipboard
 * over, and a request id is meant to be pasted into a chat message minutes
 * later.
 */
export async function copyPlainText(text: string): Promise<void> {
  await clipboard().writeText(text);
}

/** True when a failure should be blamed on the browser rather than the server. */
export function isClipboardFailure(error: unknown): boolean {
  return error instanceof ClipboardUnavailableError || !(error instanceof ApiError);
}
