// action/errors.mjs — the one failure type the action throws.
//
// Its own module because every other file in this directory raises one and none
// of them should have to import a command or an effect to do so: this is the
// bottom of the dependency graph and imports nothing itself.

/** A failure with an actionable next step. Never carries a secret value. */
export class ActionError extends Error {
  /**
   * @param {string} message
   * @param {string} [hint]
   */
  constructor(message, hint) {
    super(message);
    this.name = "ActionError";
    this.hint = hint;
  }
}
