import { parseArgs } from '@/core/args';
import { launch } from '@/core/supervisor';

/** Anything that is not a ccmx subcommand: run claude under the supervisor. */
export function launchCommand(argv: string[]): Promise<number> {
  return launch(parseArgs(argv));
}
