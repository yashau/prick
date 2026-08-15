import { reveal } from "./reveal.svelte.js";

/**
 * Session idle watcher.
 *
 * Access itself will re-challenge eventually, but its session is measured in
 * hours and is invisible to this tab. What matters here is narrower and
 * sooner: an admin console left open on a shared screen must not still be
 * holding a plaintext value, and must say so rather than silently continuing
 * to look logged in.
 *
 * At the threshold this store does two things, in this order:
 *
 *   1. wipes every revealed value, immediately and unconditionally,
 *   2. raises `idle`, which the root layout renders as a blocking dialog
 *      offering re-authentication.
 *
 * The wipe is not contingent on the dialog: if the dialog fails to mount for
 * any reason, the values are still gone.
 */

/** 15 minutes. */
export const IDLE_AFTER_MS = 15 * 60 * 1000;

/** Coarse resolution on purpose -- this is a guard, not a stopwatch. */
const CHECK_MS = 15_000;

/**
 * Activity signals.
 *
 * `pointermove` covers mouse, pen and touch in one listener. `visibilitychange`
 * is included because returning to a backgrounded tab is activity even when
 * nothing else fires, and because a tab that was hidden for the whole window
 * should still trip.
 */
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "scroll",
  "focus",
] as const;

class IdleWatcher {
  /** True once the threshold has passed with no activity. */
  idle = $state(false);

  #lastActivity = Date.now();
  #timer: ReturnType<typeof setInterval> | null = null;
  #listeners = 0;

  /** Whole minutes since the last activity signal. For the dialog copy. */
  get idleMinutes(): number {
    return Math.floor((Date.now() - this.#lastActivity) / 60_000);
  }

  /**
   * Attach the listeners. Returns the detach function, so a component can call
   * this from `$effect` and let Svelte own the teardown.
   *
   * Reference-counted: the root layout is the only caller today, but a second
   * caller must not tear the first one's listeners down.
   */
  start(): () => void {
    this.#listeners += 1;

    if (this.#listeners === 1) {
      const bump = this.#bump;
      for (const event of ACTIVITY_EVENTS) {
        window.addEventListener(event, bump, { passive: true, capture: true });
      }
      document.addEventListener("visibilitychange", this.#onVisibility);

      this.#lastActivity = Date.now();
      this.#timer = setInterval(this.#check, CHECK_MS);
    }

    return () => {
      this.#listeners -= 1;
      if (this.#listeners > 0) return;

      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, this.#bump, { capture: true });
      }
      document.removeEventListener("visibilitychange", this.#onVisibility);

      if (this.#timer !== null) {
        clearInterval(this.#timer);
        this.#timer = null;
      }
    };
  }

  /** Dismiss the dialog and restart the window. Used after a re-auth check. */
  resume(): void {
    this.#lastActivity = Date.now();
    this.idle = false;
  }

  #bump = (): void => {
    // Deliberately does NOT clear `idle`. Once the session has gone idle and
    // the values have been wiped, moving the mouse is not re-authentication --
    // the dialog stays until it is answered.
    if (this.idle) return;
    this.#lastActivity = Date.now();
  };

  #onVisibility = (): void => {
    if (document.visibilityState === "visible") this.#bump();
    else this.#check();
  };

  #check = (): void => {
    if (this.idle) return;
    if (Date.now() - this.#lastActivity < IDLE_AFTER_MS) return;

    reveal.wipe();
    this.idle = true;
  };
}

export const idle = new IdleWatcher();
