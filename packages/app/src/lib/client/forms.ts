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
