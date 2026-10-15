import { classify, messageOf } from '@/core/classify';
import { type Config, loadConfig } from '@/core/config';
import { account, discoverProfiles, findProfile } from '@/core/profiles';
import { poolFor } from '@/core/projects';
import { formatTable, historyLines, profileRows } from '@/core/report';
import { sendSignal, takeReplayFlag } from '@/core/signals';
import { pinnedTo } from '@/core/state';
import {
  isExhausted,
  isOverThreshold,
  nextAvailable,
  pickTarget,
  rotateFrom
} from '@/core/strategy';
import { headroom } from '@/core/usage';
import { clock } from '@/utils/time';

const block = (reason: string) =>
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));

const SLASH_HELP = `ccmx slash commands
  /ccmx:switch [profile]   move this session to another profile (next one with room if omitted)
  /ccmx:list               profiles with 5-hour and 7-day usage
  /ccmx:status             the profile and session ccmx is running
  /ccmx:history            recent switches`;

function resolveTarget(ref: string) {
  const byName = findProfile(ref);
  if (byName) return byName;
  return discoverProfiles().find((p) => account(p)?.email?.toLowerCase() === ref.toLowerCase());
}

function describe(h: ReturnType<typeof headroom>) {
  if (h.limitedUntil) return `at its limit until ${clock(h.limitedUntil)}`;
  const parts = [
    h.five !== undefined && `5h ${Math.round(h.five)}%`,
    h.seven !== undefined && `7d ${Math.round(h.seven)}%`
  ];
  return `at ${parts.filter(Boolean).join(', ')}`;
}

function slashCommand(
  prompt: string,
  pid: number,
  profile: string,
  sessionId: string | undefined,
  cfg: Config,
  pool?: string[]
) {
  // Only ccmx's own namespace: a project's `/switch` command is none of ccmx's business.
  const m = prompt.match(/^\/ccmx:(switch|list|status|history|help)(?:\s+(.*))?$/s);
  if (!m) return false;
  const cmd = m[1]!;
  const arg = m[2]?.trim();
  sendSignal(pid, 'prompt-submitted', { startsTurn: false });
  if (cmd === 'switch') {
    // An explicit name ignores project pools: the user knows what they asked for.
    const target = arg ? resolveTarget(arg) : rotateFrom(profile, cfg, pool);
    if (!target) {
      block(
        arg
          ? `ccmx: no profile "${arg}".`
          : `ccmx: no other profile has room.\n\n${formatTable(profileRows(cfg, profile))}`
      );
    } else if (!account(target)) {
      block(`ccmx: profile "${target.name}" is not logged in. Run \`ccmx login ${target.name}\`.`);
    } else if (target.name === profile) {
      block(`ccmx: already on ${profile}.`);
    } else {
      sendSignal(pid, 'switch-requested', { target: target.name, trigger: 'manual' });
      block(`ccmx: switching to ${target.name}; this session resumes there in a moment.`);
    }
  } else if (cmd === 'list') block(formatTable(profileRows(cfg, profile)));
  else if (cmd === 'status') {
    const email = account(
      findProfile(profile) ?? { name: profile, dir: '', isDefault: false }
    )?.email;
    block(
      `ccmx: profile ${profile}${email ? ` (${email})` : ''} · session ${sessionId ?? '?'} · wrapper pid ${pid}`
    );
  } else if (cmd === 'history') block(historyLines(10).join('\n') || 'ccmx: no switches yet.');
  else block(SLASH_HELP);
  return true;
}

function promptSubmit(input: any, pid: number, profile: string) {
  const prompt = String(input.prompt ?? '').trim();
  const cfg = loadConfig();
  const pool = poolFor(input.cwd ?? process.cwd());
  if (slashCommand(prompt, pid, profile, input.session_id, cfg, pool)) return;

  // A prompt replayed right after a threshold switch must not trigger another one.
  const replay = takeReplayFlag(pid);
  if (!replay && profile && cfg.auto_switch_on_threshold) {
    const h = headroom(profile);
    const hard = isExhausted(h);
    const pinned = pinnedTo(pid) === profile;
    // At a hard limit this is a limit switch; respect turning those off.
    const allowed = hard ? cfg.auto_switch_on_rate_limit : true;
    if (allowed && (!pinned || hard) && isOverThreshold(h, cfg)) {
      const target = pickTarget(cfg, { exclude: [profile], pool });
      if (target) {
        sendSignal(pid, 'switch-requested', {
          target: target.name,
          trigger: hard ? 'rate-limit' : 'threshold',
          resumeMessage: prompt
        });
        sendSignal(pid, 'prompt-submitted', { startsTurn: false });
        block(
          `ccmx: ${profile} is ${describe(h)}. Moving this session to ${target.name} and sending your message there.`
        );
        return;
      }
      // Nowhere to go: let the prompt through. Claude reports a real limit itself, and a
      // limit ccmx only guessed must never stop the user from trying.
    }
  }
  sendSignal(pid, 'prompt-submitted', { startsTurn: true });
}

/** Claude Code issues /rate-limit-options itself when a limit hits mid-turn. */
function promptExpansion(input: any, pid: number, profile: string) {
  const isLimitMenu =
    input.command_name === 'rate-limit-options' ||
    String(input.prompt ?? '')
      .trim()
      .startsWith('/rate-limit-options');
  if (!isLimitMenu) return;
  const cfg = loadConfig();
  if (!cfg.auto_switch_on_rate_limit) return;
  const pool = poolFor(input.cwd ?? process.cwd());
  const target = pickTarget(cfg, { exclude: [profile], pool });
  // With nowhere to go, leave Claude Code's own limit menu alone.
  if (!target) return;
  sendSignal(pid, 'switch-requested', { target: target.name, trigger: 'rate-limit' });
  block(`ccmx: ${profile} hit its limit. Switching to ${target.name} and resuming.`);
}

/**
 * Entry point claude runs for every hook. It always exits 0 with nothing on stdout unless
 * it means to block: a ccmx problem must never break or hold up the user's session.
 */
export async function runHook(sub: string): Promise<number> {
  try {
    await handleHook(sub);
  } catch {}
  return 0;
}

async function handleHook(sub: string): Promise<void> {
  const raw = await Bun.stdin.text();
  // Hooks are installed per launch, but stay inert if somehow run outside a ccmx wrapper.
  if (process.env.CCMX_WRAPPED !== '1') return;
  const pid = Number(process.env.CCMX_WRAPPER_PID);
  if (!pid) return;
  const profile = process.env.CCMX_PROFILE ?? '';
  let input: any = {};
  try {
    input = JSON.parse(raw);
  } catch {}
  switch (sub) {
    case 'session-start':
      if (input.session_id)
        sendSignal(pid, 'session-started', {
          sessionId: input.session_id,
          cwd: input.cwd,
          source: input.source
        });
      break;
    case 'stop':
      sendSignal(pid, 'stopped', { sessionId: input.session_id });
      break;
    case 'rate-limit': {
      const v = classify(input);
      if (v) sendSignal(pid, v, { message: messageOf(input) });
      break;
    }
    case 'prompt-submit':
      promptSubmit(input, pid, profile);
      break;
    case 'prompt-expansion':
      promptExpansion(input, pid, profile);
      break;
  }
}
