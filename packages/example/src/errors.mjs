// CLI error types. All user-facing messages are full lines (already carry the
// "error: " prefix where appropriate) and MUST stay ASCII; dynamic parts are
// escaped by the printers in cli.mjs before hitting stdout/stderr.

/** Generic CLI failure. `message` is the full user-facing line. */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} exitCode
   */
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/** Usage/structure problems (unknown option, missing value, ...): exit code 2. */
export class UsageError extends CliError {
  /** @param {string} message */
  constructor(message) {
    super(message, 2);
    this.name = "UsageError";
  }
}
