/**
 * Field-level errors returned by a form action.
 *
 * A closed union of field names rather than `Record<string, string>` for two
 * reasons. The obvious one is `noPropertyAccessFromIndexSignature`, which turns
 * every `errors.slug` into `errors["slug"]`. The useful one is that a server
 * action mapping a zod issue onto a field name that no input carries becomes a
 * compile error instead of a message that renders nowhere -- which is exactly
 * the failure you do not notice, because the form simply looks like it failed
 * for no reason.
 */
export type FormField =
  | "form"
  | "name"
  | "slug"
  | "description"
  | "confirm"
  | "identity"
  | "role"
  | "scope"
  | "project"
  | "environment"
  | "expires";

export type FormErrors = Partial<Record<FormField, string>>;

/**
 * Collapse zod issues into one message per field, dropping everything else.
 *
 * `issue.input` is NEVER read here, and that is the point: a
 * `VALIDATION_FAILED` on a secret write would otherwise put the rejected value
 * into the response body, the Worker log and the audit detail in one move. The
 * same rule the API's error hook follows applies to form actions, because a
 * form action's return value is serialised into page data.
 */
export function fieldErrors(
  issues: readonly { path: PropertyKey[]; message: string }[],
): FormErrors {
  const errors: FormErrors = {};

  for (const issue of issues) {
    const field = String(issue.path[0] ?? "form") as FormField;
    errors[field] ??= issue.message;
  }

  return errors;
}

/**
 * The message a refused form action carries, or `null` for any other result.
 *
 * An action result's `data` is typed loosely, so this reads `errors.form`
 * defensively. A switch that submits a form uses it to toast the server's
 * reason, because the page-level alert can sit off screen while the switch the
 * user just flipped is the thing they are looking at.
 */
export function refusalMessage(result: { type: string; data?: unknown }): string | null {
  if (result.type !== "failure" || typeof result.data !== "object" || result.data === null) {
    return null;
  }
  const errors = (result.data as { errors?: unknown }).errors;
  if (typeof errors !== "object" || errors === null) return null;
  const message = (errors as FormErrors).form;
  return typeof message === "string" && message !== "" ? message : null;
}
