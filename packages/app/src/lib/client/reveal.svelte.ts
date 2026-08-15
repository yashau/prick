import { SvelteMap } from "svelte/reactivity";

/**
 * The ONLY place a decrypted secret value is ever held in the browser.
 *
 * Not a page store -- page data is serialised into `__sveltekit_data`, which is
 * the exact payload `ssr = false` exists to keep empty. Not `localStorage` or
 * `sessionStorage` -- both survive the tab and are readable by any script that
 * ever gets a foothold. Not the URL. Not a service worker cache; there is no
 * service worker, and `worker-src 'none'` makes registering one fail.
 *
 * A `SvelteMap` rather than a plain `Map` because deletion has to be reactive:
 * when the expiry sweep drops an entry, every cell bound to it must re-render
 * as masked in the same tick. A plain Map would expire the value in memory and
 * leave it on the screen, which is the worst of both.
 */

/** How long a revealed value stays revealed. */
export const REVEAL_TTL_MS = 30_000;

/** How often the sweep runs. Also the countdown's tick rate. */
const SWEEP_MS = 250;

interface RevealedValue {
  value: string;
  expiresAt: number;
}

class RevealStore {
  /** key -> value. Keyed by `project/environment/KEY`, never by KEY alone. */
  readonly #values = new SvelteMap<string, RevealedValue>();

  /**
   * A reactive clock, ticked by the sweep.
   *
   * Reading `Date.now()` inside a `$derived` would not be reactive -- it is not
   * a signal -- so a countdown built on it would render once and then freeze at
   * whatever it happened to say. This is the signal.
   */
  #now = $state(Date.now());

  #timer: ReturnType<typeof setInterval> | null = null;

  /** How many values are currently held. Drives the "wipe" affordance. */
  get size(): number {
    return this.#values.size;
  }

  get anyRevealed(): boolean {
    return this.#values.size > 0;
  }

  static id(project: string, environment: string, key: string): string {
    return `${project}/${environment}/${key}`;
  }

  has(id: string): boolean {
    return this.#values.has(id);
  }

  get(id: string): string | undefined {
    return this.#values.get(id)?.value;
  }

  /** Milliseconds left before this value is dropped. `0` when not held. */
  remaining(id: string): number {
    const held = this.#values.get(id);
    if (!held) return 0;
    return Math.max(0, held.expiresAt - this.#now);
  }

  /** Whole seconds left, for the countdown label. */
  secondsRemaining(id: string): number {
    return Math.ceil(this.remaining(id) / 1000);
  }

  set(id: string, value: string): void {
    this.#values.set(id, { value, expiresAt: Date.now() + REVEAL_TTL_MS });
    this.#arm();
  }

  hide(id: string): void {
    this.#values.delete(id);
    this.#disarmIfEmpty();
  }

  /**
   * Drop everything.
   *
   * Called by the idle watcher at 15 minutes, by the "hide all" control, and
   * on navigation out of the secrets subtree. There is no path that keeps a
   * value across any of those.
   */
  wipe(): void {
    this.#values.clear();
    this.#disarmIfEmpty();
  }

  /**
   * The timer is a genuine side effect and is managed explicitly rather than
   * through `$effect`, because this store lives at module scope where there is
   * no effect root to attach to. It runs only while something is revealed, so
   * an idle tab with nothing on screen schedules nothing.
   */
  #arm(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      const now = Date.now();
      this.#now = now;
      for (const [id, held] of this.#values) {
        if (held.expiresAt <= now) this.#values.delete(id);
      }
      this.#disarmIfEmpty();
    }, SWEEP_MS);
  }

  #disarmIfEmpty(): void {
    if (this.#values.size > 0 || this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}

export const reveal = new RevealStore();

/** Convenience so components do not reach for the static method directly. */
export function revealId(project: string, environment: string, key: string): string {
  return RevealStore.id(project, environment, key);
}
