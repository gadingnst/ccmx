import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProfile } from '@/core/profiles';
import { headroom, recordStatusline } from '@/core/usage';

function statusLineIn(file: string): string | undefined {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return s.statusLine?.type === 'command' ? s.statusLine.command : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The statusline the user would see without ccmx, in Claude Code's order of precedence:
 * their own --settings, the project's local and shared settings, then the profile's.
 */
function userStatusline(profile: string, projectDir: string | undefined): string | undefined {
  if (process.env.CCMX_USER_STATUSLINE) return process.env.CCMX_USER_STATUSLINE;
  if (projectDir) {
    const local = statusLineIn(join(projectDir, '.claude', 'settings.local.json'));
    const shared = statusLineIn(join(projectDir, '.claude', 'settings.json'));
    if (local || shared) return local ?? shared;
  }
  const p = findProfile(profile);
  return p ? statusLineIn(join(p.dir, 'settings.json')) : undefined;
}

/**
 * Statusline shim: record this profile's usage from Claude Code's `rate_limits`, then show
 * the user's own statusline unchanged (or a short ccmx line when they have none).
 */
export async function runStatusline(): Promise<number> {
  try {
    await statusline();
  } catch {}
  return 0;
}

async function statusline() {
  const raw = await Bun.stdin.text();
  const profile = process.env.CCMX_PROFILE ?? '';
  let input: any = {};
  try {
    input = JSON.parse(raw);
  } catch {}
  if (profile) recordStatusline(profile, input.rate_limits);
  const cmd = userStatusline(profile, input.workspace?.project_dir ?? input.cwd);
  if (cmd) {
    const r = spawnSync('sh', ['-c', cmd], {
      input: raw,
      cwd: input.cwd || process.cwd(),
      env: process.env,
      timeout: 5000
    });
    process.stdout.write(r.stdout ?? '');
    return;
  }
  const h = headroom(profile);
  const usage = [
    h.five !== undefined && `5h ${Math.round(h.five)}%`,
    h.seven !== undefined && `7d ${Math.round(h.seven)}%`
  ].filter(Boolean);
  process.stdout.write(['ccmx', profile, ...usage].join(' · '));
}
