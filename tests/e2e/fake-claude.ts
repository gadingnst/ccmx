#!/usr/bin/env bun
/**
 * Stand-in for `claude`. Logs each launch, writes transcripts the way Claude Code does,
 * and runs the hooks from `--settings` so the ccmx hook → signal → supervisor path runs
 * for real.
 *
 *   FAKE_LOG       file to append one JSON line per launch to
 *   FAKE_LIMIT     config-dir basenames whose turn hits a 5-hour limit
 *   FAKE_PROMPT    a prompt to submit after the first exchange, once per test
 *   FAKE_HOLD_MS   how long to stay open after a blocked prompt or a limit (default 5000)
 *   FAKE_STAY_MS   stay open this long after a finished turn, as a real session does
 *   FAKE_THROTTLE  config-dir basenames refused once by server throttling (rate_limit
 *                  with no quotaLimits, which is not a usage limit)
 *   FAKE_LIMIT_TYPE rateLimitType for FAKE_LIMIT (default five_hour; e.g. seven_day_opus)
 *
 * A first message after `--` (how ccmx sends "Go continue." or a replayed prompt) goes
 * through UserPromptSubmit like a typed one, and is logged as {first}.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME!, '.claude');
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.at(i + 1) : undefined;
};
const settingsFile = flag('--settings');
// Strip the per-launch plumbing ccmx adds so tests compare only what matters.
const shown: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--settings' || args[i] === '--plugin-dir') i++;
  else shown.push(args[i]!);
}
appendFileSync(
  process.env.FAKE_LOG!,
  `${JSON.stringify({ dir: basename(dir), args: shown, cwd: process.cwd() })}\n`
);

const id = flag('--session-id') ?? flag('--resume');
if (!id) process.exit(0);

const settings = settingsFile ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
function hook(event: string, input: object): string {
  let out = '';
  for (const group of settings.hooks?.[event] ?? []) {
    for (const h of group.hooks ?? []) {
      const r = spawnSync('sh', ['-c', h.command], {
        input: JSON.stringify({
          hook_event_name: event,
          session_id: id,
          cwd: process.cwd(),
          ...input
        })
      });
      out += r.stdout?.toString() ?? '';
    }
  }
  return out;
}

const file = join(dir, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
mkdirSync(dirname(file), { recursive: true });
const write = (r: object) => {
  appendFileSync(
    file,
    `${JSON.stringify({ sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), ...r })}\n`
  );
  // Real transcripts end with untimestamped bookkeeping lines after every turn.
  appendFileSync(
    file,
    `${JSON.stringify({ type: 'last-prompt', lastPrompt: 'build the relay', sessionId: id })}\n`
  );
  appendFileSync(
    file,
    `${JSON.stringify({ type: 'ai-title', aiTitle: 'Relay builder', sessionId: id })}\n`
  );
};

const hold = async () => {
  process.on('SIGINT', () => process.exit(0));
  await Bun.sleep(Number(process.env.FAKE_HOLD_MS ?? 5000));
  process.exit(0);
};

hook('SessionStart', { source: args.includes('--resume') ? 'resume' : 'startup' });

const sep = args.indexOf('--');
const first = sep >= 0 ? args.slice(sep + 1).join(' ') : undefined;
if (first !== undefined) {
  const out = hook('UserPromptSubmit', { prompt: first });
  appendFileSync(
    process.env.FAKE_LOG!,
    `${JSON.stringify({ first, blocked: out.includes('"block"') })}\n`
  );
}
write({ type: 'user', message: { role: 'user', content: first ?? 'build the relay' } });

const throttleOnce = join(process.env.HOME!, `fake-throttled-${basename(dir)}`);
if (
  (process.env.FAKE_THROTTLE ?? '').split(',').includes(basename(dir)) &&
  !existsSync(throttleOnce)
) {
  writeFileSync(throttleOnce, '');
  const message = 'Server is temporarily limiting requests (not your usage limit) · Rate limited';
  write({
    type: 'assistant',
    error: 'rate_limit',
    isApiErrorMessage: true,
    message: { role: 'assistant', content: [{ type: 'text', text: message }] }
  });
  hook('StopFailure', { error: 'rate_limit', last_assistant_message: message });
  await (async () => {
    process.on('SIGINT', () => process.exit(0));
    await Bun.sleep(Number(process.env.FAKE_HOLD_MS ?? 5000));
    process.exit(0);
  })();
}

const limitedHere = (process.env.FAKE_LIMIT ?? '').split(',').includes(basename(dir));
if (args.includes('-p') || args.includes('--print')) {
  // Print mode: one turn, result on stdout, exit 1 on a usage limit (as claude -p does).
  const json = flag('--output-format') === 'json';
  const text = limitedHere
    ? "You've hit your session limit · resets 5pm"
    : `done on ${basename(dir)}`;
  if (limitedHere) {
    write({
      type: 'assistant',
      error: 'rate_limit',
      isApiErrorMessage: true,
      quotaLimits: {
        status: 'rejected',
        resetsAt: Math.floor(Date.now() / 1000) + 3600,
        rateLimitType: 'five_hour'
      },
      message: { role: 'assistant', content: [{ type: 'text', text }] }
    });
  } else {
    write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  }
  process.stdout.write(
    json
      ? `${JSON.stringify({ type: 'result', is_error: limitedHere, result: text, session_id: id })}\n`
      : `${text}\n`
  );
  process.exit(limitedHere ? 1 : 0);
}

if (limitedHere) {
  const message = "You've hit your session limit · resets 5pm";
  write({
    type: 'assistant',
    error: 'rate_limit',
    isApiErrorMessage: true,
    quotaLimits: {
      status: 'rejected',
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
      rateLimitType: process.env.FAKE_LIMIT_TYPE ?? 'five_hour'
    },
    message: { role: 'assistant', content: [{ type: 'text', text: message }] }
  });
  hook('StopFailure', { error: 'rate_limit', last_assistant_message: message });
  await hold();
}

write({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
});
hook('Stop', {});
if (process.env.FAKE_STAY_MS) {
  process.on('SIGINT', () => process.exit(0));
  await Bun.sleep(Number(process.env.FAKE_STAY_MS));
}

const once = join(process.env.HOME!, 'fake-prompt-sent');
if (process.env.FAKE_PROMPT && !existsSync(once)) {
  writeFileSync(once, '');
  const out = hook('UserPromptSubmit', { prompt: process.env.FAKE_PROMPT });
  if (out.includes('"block"')) {
    appendFileSync(
      process.env.FAKE_LOG!,
      `${JSON.stringify({ blocked: JSON.parse(out).reason })}\n`
    );
    await hold();
  }
}
