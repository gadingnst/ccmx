import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { type Parsed, carriedArgs } from '@/core/args';
import type { Config } from '@/core/config';
import { appendHistory } from '@/core/history';
import { claudeBin, slugFor } from '@/core/paths';
import { type Profile, account, findProfile, profileEnv } from '@/core/profiles';
import { poolFor } from '@/core/projects';
import { listLive } from '@/core/registry';
import {
  ensureSessionIn,
  findSession,
  limitEvidence,
  listSessions,
  sessionCwd,
  sessionFileIn
} from '@/core/sessions';
import { updateProfile } from '@/core/state';
import { nextAvailable, pickTarget } from '@/core/strategy';
import { CliError } from '@/utils/errors';
import { logger } from '@/utils/logger';
import { clock } from '@/utils/time';

function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args.at(i)!;
    if (a === flag) return args.at(i + 1);
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

function explicitProfile(name: string): Profile {
  const p = findProfile(name);
  if (!p) throw new CliError(`no profile "${name}". Run \`ccmx login ${name}\` first.`, 2);
  if (!account(p))
    throw new CliError(`profile "${name}" is not logged in. Run \`ccmx login ${name}\`.`, 2);
  return p;
}

/**
 * `ccmx -p`: one headless turn for scripts and agents. Runs on the profile with the most
 * headroom and records what it learns, so repeated calls rotate. With text or json output
 * the result is held back until the turn is done: if the profile hit its usage limit, the
 * same session continues on the next profile and only the final result is printed.
 * stream-json goes straight through and is never handed off.
 */
export async function runPrint(parsed: Parsed, cfg: Config): Promise<number> {
  let cwd = process.cwd();
  const rest = parsed.rest;
  if (parsed.resume === null) {
    throw new CliError(
      '-p cannot open the session picker. Find an id with `ccmx sessions --here --json`, then `ccmx -r <id> -p …`.',
      2
    );
  }
  let session = typeof parsed.resume === 'string' ? findSession(parsed.resume) : undefined;
  if (typeof parsed.resume === 'string' && !session) {
    throw new CliError(`session ${parsed.resume} not found in any profile.`, 2);
  }
  if (parsed.cont) {
    const busy = new Set(listLive().map((l) => l.sessionId));
    session = listSessions({ cwd }).find((x) => !busy.has(x.id));
  }
  if (session) {
    const home = sessionCwd(session.file);
    if (home && existsSync(home)) cwd = home;
  }
  const id = session?.id ?? parsed.sessionId ?? randomUUID();
  const slug = slugFor(cwd);
  const pool = poolFor(cwd);

  const format = flagValue(rest, '--output-format') ?? 'text';
  const streaming = format === 'stream-json' || flagValue(rest, '--input-format') === 'stream-json';
  const persisted = !rest.includes('--no-session-persistence') && !rest.includes('--fork-session');
  const handOff = !parsed.as && !streaming && persisted && cfg.auto_switch_on_rate_limit;

  let prof = parsed.as ? explicitProfile(parsed.as) : pickTarget(cfg, { pool, forStart: true });
  if (!prof) {
    const next = nextAvailable(cfg, pool);
    throw new CliError(
      `every profile is limited${next ? `; ${next.profile} frees up at ${clock(next.at)}` : ''}.`
    );
  }
  let args = [...(session ? ['--resume', id] : ['--session-id', id]), ...rest];
  const tried = new Set<string>();

  while (true) {
    tried.add(prof.name);
    const startedAt = Date.now();
    updateProfile(prof.name, { lastUsed: startedAt });
    const s = findSession(id);
    if (s) ensureSessionIn(prof, s, cwd);
    const proc = Bun.spawn([claudeBin(), ...args], {
      cwd,
      env: profileEnv(prof),
      stdio: ['inherit', streaming ? 'inherit' : 'pipe', 'inherit']
    });
    const output = streaming
      ? Promise.resolve(new Uint8Array())
      : new Response(proc.stdout as ReadableStream).bytes();
    const code = await proc.exited;
    const bytes = await output;

    const found = sessionFileIn(prof, id, slug);
    const ev = found ? limitEvidence(found.file, startedAt) : null;
    // Only a refused quota counts; throttling is written as rate_limit too, without one.
    const hit = ev?.kind === 'usage' ? ev : null;
    if (hit && !hit.scoped)
      updateProfile(prof.name, { limitedUntil: hit.resetsAt, limitType: hit.type });
    const next = hit && handOff ? pickTarget(cfg, { exclude: [...tried], pool }) : undefined;
    if (!hit || !next) {
      if (hit) {
        logger.warn(
          `${prof.name} hit its usage limit (resets ${clock(hit.resetsAt)})${handOff ? '; no other profile has room' : ''}.`
        );
      }
      process.stdout.write(bytes);
      return code;
    }
    appendHistory({
      at: Date.now(),
      from: prof.name,
      to: next.name,
      trigger: 'rate-limit',
      reason: 'usage limit during a -p run',
      sessionId: id,
      cwd
    });
    logger.warn(`${prof.name} hit its usage limit; continuing this turn on ${next.name}.`);
    // The prompt is already in the transcript; only nudge the session on (after `--`, so
    // the nudge can never be read as a flag).
    args = ['--resume', id, ...carriedArgs(rest), '--', cfg.auto_message];
    prof = next;
  }
}
