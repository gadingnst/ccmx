import { MANY_VALUES, ONE_VALUE, OPTIONAL_VALUE } from '@/core/claude-flags';
import { isUuid } from '@/core/sessions';
import { CliError } from '@/utils/errors';

export type Parsed = {
  as?: string;
  /** undefined: not given · null: open the picker · string: that session. */
  resume?: string | null;
  /** Picker filter from `--resume <term>`. */
  search?: string;
  cont: boolean;
  sessionId?: string;
  print: boolean;
  /** Everything ccmx does not own, in order, for the first launch. */
  rest: string[];
};

/** Claude Code's root subcommands and aliases (claude --help, 2.1.300); passed straight through. */
export const CLAUDE_SUBCOMMANDS = new Set([
  'agents',
  'attach',
  'auth',
  'auto-mode',
  'doctor',
  'gateway',
  'import',
  'install',
  'kill',
  'logs',
  'mcp',
  'plugin',
  'plugins',
  'purge',
  'rc',
  'remote-control',
  'respawn',
  'rm',
  'setup-token',
  'stop',
  'ultrareview',
  'update',
  'upgrade'
]);

/** Dropped on relaunch: they would fork a new session, open a new worktree, or detach. */
const NOT_ON_RELAUNCH = new Set([
  '--fork-session',
  '-w',
  '--worktree',
  '--bg',
  '--background',
  '--teleport',
  '--cloud',
  '--from-pr'
]);

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { cont: false, print: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv.at(i)!;
    const next = argv.at(i + 1);
    if (a === '--as') {
      if (!next || next.startsWith('-')) throw new CliError('--as needs a profile name', 2);
      out.as = next;
      i++;
    } else if (a.startsWith('--as=')) {
      out.as = a.slice(5);
      if (!out.as) throw new CliError('--as needs a profile name', 2);
    } else if (a === '-r' || a === '--resume') {
      if (isUuid(next)) {
        out.resume = next;
        i++;
      } else {
        out.resume = null;
        if (next !== undefined && !next.startsWith('-')) {
          out.search = next;
          i++;
        }
      }
    } else if (a.startsWith('--resume=')) {
      const v = a.slice(9);
      if (isUuid(v)) out.resume = v;
      else Object.assign(out, { resume: null, search: v || undefined });
    } else if (a === '-c' || a === '--continue') {
      out.cont = true;
    } else if (a === '--session-id') {
      out.sessionId = next;
      i++;
    } else if (a.startsWith('--session-id=')) {
      out.sessionId = a.slice(13);
    } else {
      if (a === '-p' || a === '--print') out.print = true;
      out.rest.push(a);
    }
  }
  return out;
}

/**
 * Flags to carry into a relaunch. Positional args are the user's first prompt and must
 * not be sent again, so only flags and their values survive. An optional value cannot be
 * told apart from a prompt, so it is dropped and the flag kept bare.
 */
export function carriedArgs(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest.at(i)!;
    // Everything after `--` is the prompt, even words that look like flags.
    if (a === '--') break;
    if (!a.startsWith('-') || a === '-') continue;
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0;
    const isWord = (w: string | undefined) => w !== undefined && !w.startsWith('-');
    const skipValues = () => {
      if (inline) return;
      if (ONE_VALUE.has(flag) && rest.at(i + 1) !== undefined) i++;
      else if (MANY_VALUES.has(flag)) while (isWord(rest.at(i + 1))) i++;
      else if (OPTIONAL_VALUE.has(flag) && isWord(rest.at(i + 1))) i++;
    };
    if (NOT_ON_RELAUNCH.has(flag)) {
      skipValues();
      continue;
    }
    out.push(a);
    if (inline) continue;
    if (ONE_VALUE.has(flag) && rest.at(i + 1) !== undefined) out.push(rest.at(++i)!);
    else if (MANY_VALUES.has(flag)) while (isWord(rest.at(i + 1))) out.push(rest.at(++i)!);
    else if (OPTIONAL_VALUE.has(flag) && isWord(rest.at(i + 1))) i++;
  }
  return out;
}

export function isPassthrough(p: Parsed): boolean {
  const first = p.rest.at(0);
  if (first && CLAUDE_SUBCOMMANDS.has(first)) return true;
  return (
    p.print || p.rest.some((a) => a === '-h' || a === '--help' || a === '-v' || a === '--version')
  );
}
