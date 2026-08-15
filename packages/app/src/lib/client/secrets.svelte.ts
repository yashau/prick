import { SvelteSet } from "svelte/reactivity";

import { api, type SecretListEntry } from "./api.js";
import { copySecretValue } from "./clipboard.js";
import { ApiError, toApiError } from "./errors.js";
import { reveal, revealId } from "./reveal.svelte.js";

/**
 * All the state one environment's secrets screen needs.
 *
 * Lives in a rune class rather than the page component because three separate
 * surfaces mutate it -- the table, the import dialog and the bulk toolbar --
 * and because keeping the fetch/announce/refresh sequence in one place is what
 * stops one of them forgetting to re-read `rev` after a write.
 *
 * WHAT IS NOT HERE: values. `rows` carries key names, versions and timestamps
 * only, exactly as the API returns them. A revealed value goes into
 * `reveal.svelte.ts` and nowhere else, and this class never reads one back out
 * except to hand it to an editor the user explicitly opened.
 */
export class SecretsController {
  readonly project: string;
  readonly environment: string;

  rows = $state<SecretListEntry[]>([]);
  rev = $state(0);
  loading = $state(true);
  /** A failure that replaces the whole table, e.g. 403 or a dead network. */
  error = $state<ApiError | null>(null);

  /** Keys with an in-flight request. Drives per-row spinners and disabling. */
  readonly busy = new SvelteSet<string>();

  /**
   * Politely announced to screen readers.
   *
   * A reveal is a visual change with no focus movement, so without this it is
   * silent for anyone not looking at the cell. It says WHICH key was revealed
   * and that it will re-mask; it never contains a value.
   */
  announcement = $state("");

  constructor(project: string, environment: string) {
    this.project = project;
    this.environment = environment;
  }

  get unreadableCount(): number {
    return this.rows.filter((row) => row.unreadable).length;
  }

  idFor(key: string): string {
    return revealId(this.project, this.environment, key);
  }

  isRevealed(key: string): boolean {
    return reveal.has(this.idFor(key));
  }

  valueOf(key: string): string | undefined {
    return reveal.get(this.idFor(key));
  }

  secondsLeft(key: string): number {
    return reveal.secondsRemaining(this.idFor(key));
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const [rows, environment] = await Promise.all([
        api.listSecrets(this.project, this.environment),
        api.getEnvironment(this.project, this.environment),
      ]);
      this.rows = rows;
      this.rev = environment.rev;
    } catch (cause) {
      this.error = toApiError(cause);
    } finally {
      this.loading = false;
    }
  }

  /** Re-read after a write. Never optimistic: `rev` has to come from the server. */
  async refresh(): Promise<void> {
    const [rows, environment] = await Promise.all([
      api.listSecrets(this.project, this.environment),
      api.getEnvironment(this.project, this.environment),
    ]);
    this.rows = rows;
    this.rev = environment.rev;
  }

  /**
   * Fetch one value and hold it for 30 seconds.
   *
   * Audited server-side as `secret.reveal` with `reason: "reveal"` before it
   * returns. There is no cache: hiding and revealing the same key twice is two
   * audit rows, which is the honest record of what happened.
   */
  async revealKey(key: string): Promise<void> {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      const value = await api.revealSecret(this.project, this.environment, key, "reveal");
      reveal.set(this.idFor(key), value);
      this.announcement = `${key} revealed. It will be hidden again in 30 seconds.`;
    } catch (cause) {
      const error = toApiError(cause);
      this.announcement = `${key} could not be revealed: ${error.message}`;
      throw error;
    } finally {
      this.busy.delete(key);
    }
  }

  hideKey(key: string): void {
    reveal.hide(this.idFor(key));
    this.announcement = `${key} hidden.`;
  }

  /**
   * Copy REFETCHES rather than reading the revealed value out of memory.
   *
   * One extra round trip buys a distinct `secret.reveal` row with
   * `reason: "copy"`, which is the difference between "someone looked at this"
   * and "someone took this" in the audit log. Without it, a copy of an already
   * revealed value would leave no trace at all.
   */
  async copyKey(key: string): Promise<void> {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      await copySecretValue(this.project, this.environment, key);
    } finally {
      this.busy.delete(key);
    }
  }

  /** Fetch a value for an editor the user has explicitly opened. */
  async loadForEdit(key: string): Promise<string> {
    this.busy.add(key);
    try {
      return await api.revealSecret(this.project, this.environment, key, "reveal");
    } finally {
      this.busy.delete(key);
    }
  }

  /**
   * Write one value.
   *
   * `expected_rev` is sent on every write, not just full replaces: a merge
   * that silently lands on top of somebody else's change is the quiet version
   * of the same bug. A mismatch is a 412 and the environment is untouched.
   */
  async save(key: string, value: string, reason?: string): Promise<void> {
    this.busy.add(key);
    try {
      const result = await api.writeSecrets(this.project, this.environment, {
        mode: "merge",
        set: { [key]: value },
        expected_rev: this.rev,
        ...(reason ? { reason } : {}),
      });
      this.rev = result.rev;
      // A fresh write supersedes whatever was revealed: the old value is now
      // historical and must not linger on screen as if it were current.
      reveal.hide(this.idFor(key));
      await this.refresh();
    } finally {
      this.busy.delete(key);
    }
  }

  async remove(keys: string[], reason?: string): Promise<void> {
    for (const key of keys) this.busy.add(key);
    try {
      const result = await api.writeSecrets(this.project, this.environment, {
        mode: "merge",
        delete: keys,
        expected_rev: this.rev,
        ...(reason ? { reason } : {}),
      });
      this.rev = result.rev;
      for (const key of keys) reveal.hide(this.idFor(key));
      await this.refresh();
    } finally {
      for (const key of keys) this.busy.delete(key);
    }
  }

  /**
   * Rename a key.
   *
   * There is no cheap rename on the server: the ciphertext is bound to
   * `(purpose, environment_id, key, version)`, so the value is decrypted under
   * the old AAD and re-encrypted under the new one in a single batch. From
   * here it is one call, but it is worth knowing it is not a metadata edit.
   */
  async rename(from: string, to: string): Promise<void> {
    this.busy.add(from);
    try {
      const result = await api.renameSecret(this.project, this.environment, from, to);
      this.rev = result.rev;
      reveal.hide(this.idFor(from));
      await this.refresh();
    } finally {
      this.busy.delete(from);
    }
  }

  async rollback(key: string, toVersion: number, reason?: string): Promise<void> {
    this.busy.add(key);
    try {
      const result = await api.rollbackSecret(this.project, this.environment, {
        key,
        to_version: toVersion,
        ...(reason ? { reason } : {}),
      });
      this.rev = result.rev;
      reveal.hide(this.idFor(key));
      await this.refresh();
    } finally {
      this.busy.delete(key);
    }
  }
}
