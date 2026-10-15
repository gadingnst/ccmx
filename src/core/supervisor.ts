import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { type Parsed, carriedArgs, isPassthrough } from '@/core/args';
import { refusedModel } from '@/core/classify';
import { type Config, loadConfig } from '@/core/config';
import { runPrint } from '@/core/headless';
import { type HistoryEntry, appendHistory } from '@/core/history';
import { removeLaunchSettings, writeLaunchSettings, writePlugin } from '@/core/launchfiles';
import { CLAUDE_INSTALL_HINT, claudeAvailable, claudeBin, slugFor } from '@/core/paths';
import { type Profile, account, findProfile, profileEnv } from '@/core/profiles';
import { poolFor } from '@/core/projects';
import { type SessionState, endLive, listLive, writeLive } from '@/core/registry';
import {
  type LimitEvidence,
  type Session,
  ensureSessionIn,
  findSession,
  limitEvidence,
  listSessions,
  resolveSessionId,
  sessionCwd,
  sessionFileIn
} from '@/core/sessions';
import { type Signals, clearSignals, setReplayFlag, takeSignal } from '@/core/signals';
import { pinnedTo, setPin, updateProfile } from '@/core/state';
import {
  candidates,
  hasCapacity,
  isExhausted,
  isOverThreshold,
  nextAvailable,
  pickTarget,
  rotateFrom
} from '@/core/strategy';
import { headroom } from '@/core/usage';
import { CliError } from '@/utils/errors';
import { logger } from '@/utils/logger';
import { pick } from '@/utils/picker';
import { ago, clock } from '@/utils/time';
import pc from 'picocolors';

type Trigger = HistoryEntry['trigger'];

type Pending = {
  trigger: Trigger;
  reason: string;
  /** Profile to move to. `preferred` targets were picked by ccmx and may be replaced. */
  target?: string;
  preferred?: boolean;
  /** The user's blocked prompt, sent again as the first turn after the switch. */
  resumeMessage?: string;
  /** For a model-switch: the model to continue with on the same profile. */
  model?: string;
  /** Rate limited with nowhere to go: claude keeps running until a profile frees up. */
  parked?: boolean;
};

/** Tests shrink waits with CCMX_TIME_SCALE (e.g. 0.001). */
const scale = () => Number(process.env.CCMX_TIME_SCALE || 1);
const TICK_MS = 100;
const FIB_S = [10, 10, 20, 30, 50, 80];
const fibDelay = (n: number) => (FIB_S.at(n) ?? 120) * 1000 * scale();
/** Restarts after server/network errors before ccmx leaves the error on screen instead. */
const MAX_RETRIES = 5;
const SUSPEND_POLL_MS = 400;

/** Whether `pid` is stopped (Ctrl+Z). Bun reports exits, not stops, so ask `ps`. */
function isStopped(pid: number): boolean {
  const r = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)]);
  return r.stdout.toString().trim().startsWith('T');
}

/** Undo terminal modes claude may have left on after a hard kill. */
const TERMINAL_RESET =
  '\x1b[?2026l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l' +
  '\x1b[>4;0m\x1b[<u\x1b[r\x1b[0m\x1b[?1049l\x1b[?25h';

function descendants(root: number): number[] {
  const r = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=']);
  const kids = new Map<number, number[]>();
  for (const line of r.stdout.toString().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const queue = [root];
  for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
    for (const c of kids.get(p) ?? []) {
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

/** Ask claude to quit (SIGINT), then force it after 5 s and clean up what it left behind. */
async function gracefulExit(proc: Bun.Subprocess) {
  const kids = descendants(proc.pid);
  proc.kill('SIGINT');
  const deadline = Date.now() + 5000;
  while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline)
    await Bun.sleep(100);
  let forced = false;
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGKILL');
    forced = true;
  }
  await proc.exited;
  await Bun.sleep(500);
  for (const k of kids) {
    try {
      process.kill(k, 'SIGTERM');
    } catch {}
  }
  if (forced && process.stdout.isTTY) {
    process.stdout.write(TERMINAL_RESET);
    spawnSync('stty', ['sane'], { stdio: 'inherit' });
  }
}

function waitForTranscript(file: string) {
  const deadline = Date.now() + 2000;
  let last = -1;
  let since = Date.now();
  while (Date.now() < deadline) {
    const size = existsSync(file) ? statSync(file).size : 0;
    if (size > 0 && size === last && Date.now() - since >= 200) return;
    if (size !== last) {
      last = size;
      since = Date.now();
    }
    Bun.sleepSync(50);
  }
}

type Ctx = {
  cfg: Config;
  /** Where claude runs; follows the session into a worktree (SessionStart reports it). */
  cwd: string;
  slug: string;
  pool?: string[];
  sessionId: string;
  startedAt: number;
  settings: string;
  plugin: string;
  /** The user's own statusline from their --settings, for the shim to show. */
  userStatusLine?: string;
  /** Consecutive restarts after API errors; a completed turn resets it. */
  retries: number;
  /** Fallback models already tried in this run (model_fallback). */
  triedModels: Set<string>;
};

function live(ctx: Ctx, prof: Profile, state: SessionState, detail?: string) {
  writeLive({
    pid: process.pid,
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    profile: prof.name,
    state,
    detail,
    startedAt: ctx.startedAt,
    updatedAt: Date.now()
  });
}

/** Whether the session on `prof` should move now, and where. */
function thresholdMove(ctx: Ctx, prof: Profile): Profile | undefined {
  const h = headroom(prof.name);
  if (pinnedTo(process.pid) === prof.name && !isExhausted(h)) return undefined;
  if (!isOverThreshold(h, ctx.cfg)) return undefined;
  return pickTarget(ctx.cfg, { exclude: [prof.name], pool: ctx.pool });
}

/** A model a scoped limit (`seven_day_opus`, …) is about, if its name says. */
const modelOfType = (type?: string) => type?.match(/opus|sonnet|haiku|fable/)?.[0];

/**
 * Where a switch request should go. An unusable request (no profile with room, a profile
 * that is not logged in, the one already running) is dropped instead of ending the session.
 */
function switchTarget(
  ctx: Ctx,
  prof: Profile,
  sw: Signals['switch-requested']
): Profile | undefined {
  const t = sw.target
    ? findProfile(sw.target)
    : sw.trigger === 'manual'
      ? rotateFrom(prof.name, ctx.cfg, ctx.pool)
      : pickTarget(ctx.cfg, { exclude: [prof.name], pool: ctx.pool });
  if (!t || t.name === prof.name || !account(t)) return undefined;
  return t;
}

async function runOnce(
  ctx: Ctx,
  prof: Profile,
  args: string[]
): Promise<{ code: number; pending?: Pending }> {
  const env = {
    ...profileEnv(prof),
    CCMX_WRAPPED: '1',
    CCMX_WRAPPER_PID: String(process.pid),
    CCMX_PROFILE: prof.name,
    ...(ctx.userStatusLine ? { CCMX_USER_STATUSLINE: ctx.userStatusLine } : {})
  };
  // ccmx's flags go first: anything after a `--` in args is prompt text.
  const proc = Bun.spawn(
    [claudeBin(), '--settings', ctx.settings, '--plugin-dir', ctx.plugin, ...args],
    { cwd: ctx.cwd, env, stdio: ['inherit', 'inherit', 'inherit'] }
  );
  // Ctrl+C belongs to claude; ccmx must outlive it to hand the session on.
  const ignore = () => {};
  const onTerm = () => proc.kill('SIGTERM');
  const onHup = () => proc.kill('SIGHUP');
  process.on('SIGINT', ignore);
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);

  const cfg = ctx.cfg;
  const pid = process.pid;
  const launchedAt = Date.now();
  let pending: Pending | undefined;
  let stopping: Promise<void> | undefined;
  let lastAt = Date.now();
  let turnInFlight = false;
  let lastIdleCheck = 0;
  let lastParkCheck = 0;
  let lastSuspendCheck = 0;
  const stop = () => {
    stopping ??= gracefulExit(proc);
  };
  const running = () => proc.exitCode === null && proc.signalCode === null;

  /** What the transcript says about the refusal; the hook can fire just before it is written. */
  const evidence = async (): Promise<LimitEvidence | null> => {
    for (let i = 0; i < 10; i++) {
      const f = sessionFileIn(prof, ctx.sessionId, ctx.slug);
      const ev = f ? limitEvidence(f.file, launchedAt) : null;
      if (ev) return ev;
      await Bun.sleep(100);
    }
    return null;
  };

  const retry = (reason: string) => {
    if (pending || !cfg.retry_on_api_error || ctx.retries >= MAX_RETRIES) return;
    pending = { trigger: 'retry', reason };
    stop();
  };

  const tick = async (now: number) => {
    // Ctrl+Z stops claude only. Stop ccmx too, or the shell keeps waiting on a job that
    // still looks alive and the terminal freezes; `fg` continues the whole group.
    if (!stopping && now - lastSuspendCheck >= SUSPEND_POLL_MS) {
      lastSuspendCheck = now;
      if (isStopped(proc.pid)) {
        process.kill(process.pid, 'SIGSTOP');
        proc.kill('SIGCONT');
        lastAt = Date.now();
        return;
      }
    }

    const started = takeSignal(pid, 'session-started');
    if (started?.sessionId) {
      ctx.sessionId = started.sessionId;
      if (started.cwd && started.cwd !== ctx.cwd) {
        ctx.cwd = started.cwd;
        ctx.slug = slugFor(started.cwd);
      }
      live(ctx, prof, 'running');
    }

    const limited = takeSignal(pid, 'rate-limited');
    if (limited && (!pending || pending.parked) && cfg.auto_switch_on_rate_limit) {
      const ev = await evidence();
      if (!ev || ev.kind === 'transient') {
        // No refused quota in the transcript: throttling or load, not this account.
        retry(limited.message || 'temporary API refusal');
      } else {
        const model =
          refusedModel(limited.message) ?? (ev.scoped ? modelOfType(ev.type) : undefined);
        const fallback = model
          ? cfg.model_fallback.find(
              (m) => !ctx.triedModels.has(m) && !m.toLowerCase().includes(model)
            )
          : undefined;
        // A cap on one model is not the account's limit: other sessions may still use it.
        if (!ev.scoped) updateProfile(prof.name, { limitedUntil: ev.resetsAt, limitType: ev.type });
        const target = pickTarget(cfg, { exclude: [prof.name], pool: ctx.pool });
        const reason = limited.message || 'usage limit reached';
        if (fallback) {
          pending = { trigger: 'model-switch', reason, model: fallback };
          stop();
        } else if (target) {
          pending = { trigger: 'rate-limit', reason };
          stop();
        } else if (!ev.scoped) {
          // Nowhere to go: keep claude alive (the user can still read and scroll) and
          // move as soon as some profile frees up.
          pending = { trigger: 'rate-limit', reason, parked: true };
          lastParkCheck = now;
          const next = nextAvailable(cfg, ctx.pool);
          live(
            ctx,
            prof,
            'parked',
            next
              ? `${next.profile} frees up at ${clock(next.at)}`
              : 'waiting for a profile to free up'
          );
        }
      }
    }

    const failed = takeSignal(pid, 'turn-failed');
    if (failed) retry(failed.message || 'API error');

    const sw = takeSignal(pid, 'switch-requested');
    if (sw && (!pending || pending.parked)) {
      const target = switchTarget(ctx, prof, sw);
      if (target) {
        pending = {
          trigger: sw.trigger,
          reason:
            sw.trigger === 'manual' ? 'switched by hand' : `requested by hook (${sw.trigger})`,
          target: target.name,
          preferred: sw.trigger !== 'manual',
          resumeMessage: sw.resumeMessage
        };
        stop();
      }
    }

    const prompt = takeSignal(pid, 'prompt-submitted');
    if (prompt) {
      lastAt = now;
      turnInFlight = prompt.startsTurn;
    }

    const stopped = takeSignal(pid, 'stopped');
    if (stopped) {
      lastAt = now;
      turnInFlight = false;
      ctx.retries = 0;
      if (!pending && cfg.auto_switch_on_threshold) {
        const target = thresholdMove(ctx, prof);
        if (target) {
          pending = {
            trigger: 'threshold',
            reason: `${prof.name} passed its threshold`,
            target: target.name,
            preferred: true
          };
          stop();
        }
      }
    }

    const pollMs = cfg.poll_interval_seconds * 1000 * scale();
    if (
      !pending &&
      cfg.idle_after_seconds > 0 &&
      cfg.auto_switch_on_threshold &&
      !turnInFlight &&
      now - lastAt >= cfg.idle_after_seconds * 1000 * scale() &&
      now - lastIdleCheck >= pollMs
    ) {
      lastIdleCheck = now;
      const target = thresholdMove(ctx, prof);
      if (target) {
        pending = {
          trigger: 'idle',
          reason: `${prof.name} passed its threshold while idle`,
          target: target.name,
          preferred: true
        };
        stop();
      }
    }

    // While parked the user may still be working; never pull claude out mid-turn.
    if (pending?.parked && !turnInFlight && now - lastParkCheck >= 60_000 * scale()) {
      lastParkCheck = now;
      const target = pickTarget(cfg, { exclude: [prof.name], pool: ctx.pool });
      if (target) {
        Object.assign(pending, { parked: false, target: target.name, preferred: true });
        stop();
      } else if (!isExhausted(headroom(prof.name))) {
        Object.assign(pending, {
          parked: false,
          target: prof.name,
          preferred: false,
          reason: `${prof.name} recovered`
        });
        stop();
      }
    }
  };

  try {
    while (running()) {
      await Bun.sleep(TICK_MS);
      try {
        await tick(Date.now());
      } catch {
        // A ccmx hiccup (a busy lock, a failed `ps`) must never take claude down with it.
      }
    }
    const code = await proc.exited;
    if (stopping) await stopping;
    return { code, pending: pending?.parked ? undefined : pending };
  } finally {
    if (running()) proc.kill('SIGTERM');
    process.off('SIGINT', ignore);
    process.off('SIGTERM', onTerm);
    process.off('SIGHUP', onHup);
  }
}

/** Every profile is full: count down to the first reset, then hand back a profile. */
async function waitForReset(ctx: Ctx, prof: Profile): Promise<Profile | undefined> {
  let aborted = false;
  const onInt = () => {
    aborted = true;
  };
  process.on('SIGINT', onInt);
  try {
    while (!aborted) {
      const target = pickTarget(ctx.cfg, { pool: ctx.pool, forStart: true });
      if (target) {
        if (process.stderr.isTTY) process.stderr.write('\n');
        return target;
      }
      const next = nextAvailable(ctx.cfg, ctx.pool);
      // A minute of slack plus margin past the reset, so the first request is not refused again.
      const wake = next ? next.at + 150_000 * scale() : Date.now() + 60_000 * scale();
      live(
        ctx,
        prof,
        'waiting-reset',
        next ? `${next.profile} at ${clock(next.at)}` : 'no reset time known'
      );
      let lastPrint = 0;
      const recheck = Date.now() + 60_000 * scale();
      while (!aborted && Date.now() < Math.min(wake, recheck)) {
        const left = wake - Date.now();
        const every = left < 600_000 ? 1000 : 60_000;
        if (Date.now() - lastPrint >= every && process.stderr.isTTY) {
          lastPrint = Date.now();
          const m = Math.floor(left / 60_000);
          const s = Math.floor((left % 60_000) / 1000);
          process.stderr.write(
            `\r${pc.dim('ccmx')} every profile is limited; resuming ${next ? `on ${next.profile} ` : ''}in ${m}m ${String(s).padStart(2, '0')}s (Ctrl+C to stop) `
          );
        }
        await Bun.sleep(Math.min(1000, Math.max(10, left)));
      }
    }
    return undefined;
  } finally {
    process.off('SIGINT', onInt);
  }
}

function chooseExplicit(name: string): Profile {
  const p = findProfile(name);
  if (!p) throw new CliError(`no profile "${name}". Run \`ccmx login ${name}\` first.`, 2);
  if (!account(p))
    throw new CliError(`profile "${name}" is not logged in. Run \`ccmx login ${name}\`.`, 2);
  return p;
}

/** Arrow-key picker over this folder's sessions from every profile. */
async function pickSession(
  cwd: string,
  search: string | undefined,
  opensOn: string
): Promise<Session | undefined> {
  let list = listSessions({ cwd, withTitles: true });
  if (search) {
    const q = search.toLowerCase();
    list = list.filter((s) => s.id.startsWith(q) || s.title?.toLowerCase().includes(q));
  }
  if (!list.length) {
    logger.warn(
      search ? `no session in this folder matches "${search}".` : 'no session in this folder yet.'
    );
    return undefined;
  }
  const items = list.map((s) => ({
    value: s,
    columns: [ago(s.mtime), s.profiles.join(','), s.title ?? s.id],
    search: `${s.title ?? ''} ${s.id} ${s.profiles.join(' ')}`
  }));
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      'no terminal to pick from. List sessions with `ccmx sessions --here --json`, then `ccmx --resume <id>`.',
      2
    );
  }
  return pick(items, { title: 'Resume a session', footer: `${pc.dim('opens on')} ${opensOn}` });
}

function envWarnings(cfg: Config) {
  if (!cfg.auto_switch_on_rate_limit) return;
  if (process.env.CLAUDE_CODE_RETRY_WATCHDOG) {
    logger.warn(
      'CLAUDE_CODE_RETRY_WATCHDOG is set: claude waits out limits itself, so ccmx may never see them.'
    );
  }
  if (Number(process.env.CLAUDE_CODE_MAX_RETRIES) >= 10) {
    logger.warn('CLAUDE_CODE_MAX_RETRIES is 10 or more: switching on a limit will be slow.');
  }
}

/** The user's own `--settings` value, pulled out so ccmx's file can carry both. */
function extractSettings(rest: string[]): { rest: string[]; user?: Record<string, unknown> } {
  const out: string[] = [];
  let user: Record<string, unknown> | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest.at(i)!;
    if (a === '--') {
      out.push(...rest.slice(i));
      break;
    }
    const v =
      a === '--settings' ? rest.at(++i) : a.startsWith('--settings=') ? a.slice(11) : undefined;
    if (v === undefined) {
      out.push(a);
      continue;
    }
    try {
      user = JSON.parse(v.trim().startsWith('{') ? v : readFileSync(v, 'utf8'));
    } catch {
      throw new CliError(`could not read --settings ${v}`, 2);
    }
  }
  return { rest: out, user };
}

/** `args` with `--model` set to `model`, placed first so a `--` in args cannot swallow it. */
function withModel(args: string[], model: string | undefined): string[] {
  if (!model) return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args.at(i)!;
    if (a === '--') {
      out.push(...args.slice(i));
      break;
    }
    if (a === '--model') {
      i++;
      continue;
    }
    if (a.startsWith('--model=')) continue;
    out.push(a);
  }
  return ['--model', model, ...out];
}

export async function launch(parsed: Parsed): Promise<number> {
  if (!claudeAvailable()) {
    throw new CliError(`Claude Code CLI not found (\`${claudeBin()}\`). ${CLAUDE_INSTALL_HINT}`);
  }
  const cfg = loadConfig();
  let cwd = process.cwd();
  if (parsed.resume === null && parsed.search) {
    // `-r 3f2a9c1e` with an id prefix from `ccmx sessions` resumes directly.
    const id = resolveSessionId(parsed.search);
    if (id) Object.assign(parsed, { resume: id, search: undefined });
  }

  if (parsed.as) chooseExplicit(parsed.as);
  if (parsed.print) return runPrint(parsed, cfg);

  if (isPassthrough(parsed)) {
    // Subcommands change or read one profile's setup (mcp, plugin, …), so they never pick
    // one at random: the default profile unless --as says otherwise.
    const prof = parsed.as
      ? chooseExplicit(parsed.as)
      : (findProfile('claude') ?? candidates().at(0)?.profile);
    if (!prof) throw new CliError('no logged-in profile. Run `ccmx login <name>`.');
    const extra: string[] = [];
    if (typeof parsed.resume === 'string') {
      const s = findSession(parsed.resume);
      if (s) ensureSessionIn(prof, s, cwd);
      extra.push('--resume', parsed.resume);
    } else if (parsed.cont) extra.push('--continue');
    if (parsed.sessionId) extra.push('--session-id', parsed.sessionId);
    const proc = Bun.spawn([claudeBin(), ...extra, ...parsed.rest], {
      env: profileEnv(prof),
      stdio: ['inherit', 'inherit', 'inherit']
    });
    return proc.exited;
  }

  if (!process.stdin.isTTY && process.env.CCMX_NO_TTY_OK !== '1') {
    // Interactive claude needs a terminal; without one it would hang or fail obscurely.
    throw new CliError(
      'ccmx starts Claude Code interactively, which needs a terminal. For scripts and agents use -p: ccmx -p "<prompt>" --output-format json',
      2
    );
  }
  envWarnings(cfg);
  const { rest, user } = extractSettings(parsed.rest);

  let session: Session | undefined;
  if (typeof parsed.resume === 'string') {
    session = findSession(parsed.resume);
    if (!session) throw new CliError(`session ${parsed.resume} not found in any profile.`, 2);
  } else if (parsed.resume === null) {
    const pool = poolFor(cwd);
    const target = parsed.as ? findProfile(parsed.as) : pickTarget(cfg, { pool, forStart: true });
    const email = target ? account(target)?.email : undefined;
    const opensOn = target
      ? `${pc.bold(target.name)}${email ? pc.dim(` (${email})`) : ''}${parsed.as ? '' : pc.dim(' · most headroom right now')}`
      : pc.yellow('no profile has room; ccmx will wait for the first reset');
    session = await pickSession(cwd, parsed.search, opensOn);
    if (!session) return 130;
  } else if (parsed.cont) {
    // Skip a session another ccmx is running right now: two writers would fork it.
    const busy = new Set(listLive().map((s) => s.sessionId));
    session = listSessions({ cwd }).find((s) => !busy.has(s.id));
    if (!session) logger.info('no previous session here, starting a new one.');
  }
  if (session) {
    // Claude Code looks sessions up by folder, so run it where the session was started.
    const home = sessionCwd(session.file);
    if (home && home !== cwd && existsSync(home)) {
      logger.info(`session belongs to ${home}; running there.`);
      cwd = home;
    }
  }

  const userStatus =
    (user?.statusLine as { type?: string; command?: string } | undefined) ?? undefined;
  const ctx: Ctx = {
    cfg,
    cwd,
    slug: slugFor(cwd),
    pool: poolFor(cwd),
    sessionId: session?.id ?? parsed.sessionId ?? randomUUID(),
    startedAt: Date.now(),
    settings: writeLaunchSettings(cfg, user),
    plugin: writePlugin(),
    userStatusLine: userStatus?.type === 'command' ? userStatus.command : undefined,
    retries: 0,
    triedModels: new Set()
  };

  let prof: Profile | undefined = parsed.as
    ? chooseExplicit(parsed.as)
    : pickTarget(cfg, { pool: ctx.pool, forStart: true });
  if (!prof) {
    const loggedIn = candidates().filter((c) => !ctx.pool || ctx.pool.includes(c.profile.name));
    if (!loggedIn.length) throw new CliError('no logged-in profile. Run `ccmx login <name>`.');
    if (!cfg.wait_for_reset) {
      const next = nextAvailable(cfg, ctx.pool);
      throw new CliError(
        `every profile is limited${next ? `; ${next.profile} frees up at ${clock(next.at)}` : ''}.`
      );
    }
    prof = await waitForReset(ctx, loggedIn.at(0)!.profile);
    if (!prof) return 130;
  }

  let args = session
    ? ['--resume', ctx.sessionId, ...rest]
    : ['--session-id', ctx.sessionId, ...rest];
  if (session) ensureSessionIn(prof, session, cwd);
  let model: string | undefined;
  clearSignals(process.pid);

  try {
    while (true) {
      logger.info(
        `profile ${prof.name}${account(prof)?.email ? pc.dim(` (${account(prof)!.email})`) : ''} · session ${pc.dim(ctx.sessionId)}`
      );
      const launchedAt = Date.now();
      updateProfile(prof.name, { lastUsed: launchedAt });
      live(ctx, prof, 'running');
      const res = await runOnce(ctx, prof, args);
      clearSignals(process.pid);

      const found = sessionFileIn(prof, ctx.sessionId, ctx.slug);
      const ev = found ? limitEvidence(found.file, launchedAt) : null;
      // Remember an enforced account limit even when the user quit on their own; never
      // relaunch claude they chose to leave.
      if (ev?.kind === 'usage' && !ev.scoped) {
        updateProfile(prof.name, { limitedUntil: ev.resetsAt, limitType: ev.type });
      }

      const pending = res.pending;
      if (!pending) return finish(ctx, prof, res.code, !!found);

      const from = prof;
      let next: Profile | undefined;
      let first: string | undefined;

      if (pending.trigger === 'retry') {
        await Bun.sleep(fibDelay(ctx.retries++));
        next = prof;
        first = cfg.auto_message;
      } else if (pending.trigger === 'model-switch') {
        // Only one model is capped: stay on this profile with another model.
        ctx.triedModels.add(pending.model!);
        model = pending.model;
        next = prof;
        first = cfg.auto_message;
      } else if (pending.trigger === 'manual') {
        next = pending.target ? findProfile(pending.target) : undefined;
        if (next) setPin(process.pid, next.name);
        first = pending.resumeMessage;
      } else {
        setPin(process.pid, undefined);
        const want = pending.target ? findProfile(pending.target) : undefined;
        // A target ccmx picked earlier may have filled up since; then pick again.
        if (
          want &&
          (want.name === prof.name || !pending.preferred || hasCapacity(headroom(want.name), cfg))
        )
          next = want;
        next ??= pickTarget(cfg, { exclude: [prof.name], pool: ctx.pool });
        if (!next && pending.trigger === 'rate-limit' && cfg.wait_for_reset) {
          next = await waitForReset(ctx, prof);
        }
        // Only an interrupted turn is nudged on. After a finished turn (threshold, idle)
        // nothing is sent: the model may have just asked the user a question.
        first =
          pending.resumeMessage ??
          (pending.trigger === 'rate-limit' ? cfg.auto_message : undefined);
      }

      if (!next) {
        const n = nextAvailable(cfg, ctx.pool);
        logger.error(
          `nowhere to move this session${n ? `; ${n.profile} frees up at ${clock(n.at)}` : ''}.`
        );
        return finish(ctx, prof, res.code, !!found);
      }
      if (pending.trigger !== 'retry') {
        const usage = (p: Profile) => {
          const h = headroom(p.name);
          return { five: h.five, seven: h.seven };
        };
        appendHistory({
          at: Date.now(),
          from: from.name,
          to: next.name,
          trigger: pending.trigger,
          reason: pending.reason,
          sessionId: ctx.sessionId,
          cwd: ctx.cwd,
          fromUsage: usage(from),
          toUsage: usage(next)
        });
        logger.info(
          next.name === from.name
            ? `${pending.trigger}: staying on ${from.name}${model ? ` with ${model}` : ''}`
            : `${from.name} → ${next.name} (${pending.reason})`
        );
      } else {
        logger.info(`retrying on ${prof.name} after: ${pending.reason}`);
      }
      if (pending.trigger !== 'retry') ctx.retries = 0;

      // The first message goes after `--`, so a prompt starting with "-" stays a prompt.
      const tail = first ? ['--', first] : [];
      if (first) setReplayFlag(process.pid);
      if (found) {
        waitForTranscript(found.file);
        const s = findSession(ctx.sessionId);
        if (s) ensureSessionIn(next, s, ctx.cwd);
        args = [...withModel(carriedArgs(rest), model), '--resume', ctx.sessionId, ...tail];
      } else {
        // Nothing was written yet: start over on the new profile with the same id. A blocked
        // first prompt is sent instead of the command-line one.
        args = first
          ? ['--session-id', ctx.sessionId, ...withModel(carriedArgs(rest), model), ...tail]
          : ['--session-id', ctx.sessionId, ...withModel(rest, model)];
      }
      prof = next;
    }
  } finally {
    clearSignals(process.pid);
    removeLaunchSettings();
  }
}

function finish(ctx: Ctx, prof: Profile, code: number, hasTranscript: boolean): number {
  setPin(process.pid, undefined);
  endLive(
    process.pid,
    hasTranscript ? { sessionId: ctx.sessionId, cwd: ctx.cwd, profile: prof.name } : undefined
  );
  if (hasTranscript) logger.info(`resume with: ccmx --resume ${ctx.sessionId}`);
  return code;
}
