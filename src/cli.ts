#!/usr/bin/env bun
import { loginCommand, logoutCommand } from '@/commands/auth';
import { clearCommand } from '@/commands/clear';
import { configCommand } from '@/commands/config';
import { forceSwitchCommand } from '@/commands/force-switch';
import { helpCommand } from '@/commands/help';
import { historyCommand } from '@/commands/history';
import { hookCommand, statuslineCommand } from '@/commands/hook';
import { launchCommand } from '@/commands/launch';
import { listCommand } from '@/commands/list';
import { migrateCommand } from '@/commands/migrate';
import { projectCommand } from '@/commands/project';
import { sessionsCommand } from '@/commands/sessions';
import { skillCommand } from '@/commands/skill';
import { statusCommand } from '@/commands/status';
import { claudeBin } from '@/core/paths';
import { validName } from '@/core/profiles';
import { CliError, getErrorMessage, getExitCode } from '@/utils/errors';
import { logger } from '@/utils/logger';
import { VERSION } from '@/version';

/** ccmx's version, then the claude it drives. */
function printVersion() {
  console.log(`ccmx ${VERSION}`);
  try {
    const claude = Bun.spawnSync([claudeBin(), '--version']).stdout?.toString().trim();
    console.log(`claude ${claude || 'not found'}`);
  } catch {
    console.log('claude not found');
  }
}

function profileArg(args: string[], verb: string): string {
  const name = args.at(0);
  if (!name || !validName(name)) throw new CliError(`usage: ccmx ${verb} <profile>`, 2);
  return name;
}

type Handler = (args: string[]) => unknown | Promise<unknown>;

/**
 * ccmx's own subcommands. Everything else, including every claude flag, goes to the
 * supervisor untouched, which is why this is a lookup table rather than an option parser.
 * Each entry is described in src/commands/help.ts.
 */
export const COMMANDS: Record<string, Handler> = {
  help: (a) => helpCommand(a),
  '--help': () => helpCommand([]),
  '-h': () => helpCommand([]),
  version: () => printVersion(),
  '--version': () => printVersion(),
  '-v': () => printVersion(),
  status: (a) => statusCommand(a),
  login: (a) => loginCommand(profileArg(a, 'login')),
  logout: (a) => logoutCommand(profileArg(a, 'logout')),
  list: (a) => listCommand(a),
  ls: (a) => listCommand(a),
  clear: (a) => clearCommand(profileArg(a, 'clear')),
  sessions: (a) => sessionsCommand(a),
  history: (a) => historyCommand(a),
  config: (a) => configCommand(a.at(0), a.slice(1)),
  project: (a) => projectCommand(a.at(0), a.slice(1)),
  'force-switch': (a) => forceSwitchCommand(a),
  migrate: (a) => migrateCommand(a),
  skill: (a) => skillCommand(a),
  // Internal: called by claude through the per-launch settings.
  hook: (a) => hookCommand(a.at(0)),
  statusline: () => statuslineCommand()
};

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const handler = cmd ? COMMANDS[cmd] : undefined;
  try {
    const result = handler ? await handler(rest) : await launchCommand(argv);
    return typeof result === 'number' ? result : 0;
  } catch (err) {
    logger.error(getErrorMessage(err));
    return getExitCode(err);
  }
}

if (import.meta.main) main(process.argv.slice(2)).then((code) => process.exit(code));
