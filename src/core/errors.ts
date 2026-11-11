/**
 * A user-facing error. The CLI prints its message (and hint) without a stack
 * trace and exits with `exitCode`. Any other error is treated as a bug and printed with its
 * stack. Both go through secret masking before they are printed.
 */
export class CometError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  /**
   * @param opts.exitCode Process exit code, default 1.
   * @param opts.hint A next step for the user, printed as `Hint: …` below the message.
   * @param opts.cause The underlying error, kept for debugging; it is not printed.
   */
  constructor(message: string, opts: { exitCode?: number; hint?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'CometError';
    this.exitCode = opts.exitCode ?? 1;
    this.hint = opts.hint;
  }
}
