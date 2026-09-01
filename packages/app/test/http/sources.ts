/**
 * The `http` tree as TEXT, for the sentinel tests that assert a rule about the
 * source rather than about a response.
 *
 * Shared by `validation.test.ts` (the zod-validator and `issue.input`
 * confinement rules) and `csrf.test.ts` (the "never frame on body presence"
 * rule). Both are rules a one-line diff can break while looking entirely
 * reasonable, and a behavioural test cannot always see the breakage -- the body
 * presence one could not, which is why it shipped.
 *
 * Extracted here rather than copied so the comment-stripping heuristic below has
 * one definition. Two subtly different strippers would mean a sentinel that
 * fires in one file and not the other for reasons nobody could see.
 */

export const HTTP_SOURCES = import.meta.glob(
  ["../../src/lib/server/http/**/*.ts", "!../../src/lib/server/http/**/*.test.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/**
 * Comments are stripped before a sentinel greps.
 *
 * Every rule these sentinels guard is about what the CODE does, and every name
 * they look for appears in prose all over this tree precisely because it is the
 * thing being explained -- `crossSiteGuard`'s comment block spends a paragraph
 * on `c.req.raw.body` in order to forbid it. A sentinel that fires on its own
 * documentation is a sentinel somebody deletes.
 *
 * Deliberately a heuristic rather than a parser: block comments go, and a `//`
 * goes unless it is preceded by `:` or a quote, which is what keeps `https://`
 * inside a string intact. It can in principle drop code that follows a URL on
 * the same line -- a false NEGATIVE, never a false positive -- and every rule it
 * guards is also covered by a behavioural test.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, "$1");
}
