/**
 * Commands throw instead of calling `process.exit`, so they stay testable; `src/cli.ts`
 * is the one place that turns an error into a message and an exit code.
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

export function getExitCode(err: unknown): number {
  return err instanceof CliError ? err.exitCode : 1;
}
