/** Safe field hints only; neither the supplied key nor crypto internals reach HTTP. */
export class SettingsFieldError extends RangeError {
  readonly field: string;
  readonly hint: string;
  constructor(field: string, hint: string, message = hint, options?: ErrorOptions) {
    super(message, options);
    this.field = field;
    this.hint = hint;
  }
}
