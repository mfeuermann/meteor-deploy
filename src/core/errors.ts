/**
 * A user-facing error. The CLI prints its message (and hint) without a stack
 * trace and exits with `exitCode`.
 */
export class CometError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, opts: { exitCode?: number; hint?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'CometError';
    this.exitCode = opts.exitCode ?? 1;
    this.hint = opts.hint;
  }
}
