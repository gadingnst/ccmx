import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '@/core/config';
import { pidAlive, runtimeDir, writeAtomic, writeJson } from '@/core/runtime';

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** How a hook (run by claude through a shell) calls back into this ccmx. */
export function selfCommand(): string {
  if (process.env.CCMX_SELF) return process.env.CCMX_SELF;
  const main = Bun.main;
  return main.endsWith('.ts') || main.endsWith('.js')
    ? `${q(process.execPath)} ${q(main)}`
    : q(process.execPath);
}

/** Settings files of wrappers that were killed before they could clean up. */
function pruneDead(dir: string) {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const pid = Number(n.match(/^settings-(\d+)\.json$/)?.[1]);
    if (pid && !pidAlive(pid)) rmSync(join(dir, n), { force: true });
  }
}

const hook = (sub: string, timeout: number) => [
  { hooks: [{ type: 'command', command: `${selfCommand()} hook ${sub}`, timeout }] }
];

/**
 * Settings passed with `--settings` on every launch. Claude Code merges these hooks with
 * the profile's own (verified), so no user settings file is ever modified.
 */
export function writeLaunchSettings(cfg: Config, user?: Record<string, unknown>): string {
  const ours: Record<string, unknown[]> = {
    SessionStart: hook('session-start', 5),
    UserPromptSubmit: hook('prompt-submit', 20),
    UserPromptExpansion: hook('prompt-expansion', 5),
    Stop: hook('stop', 10),
    StopFailure: hook('rate-limit', 5),
    PostToolUseFailure: hook('rate-limit', 5)
  };
  // A user `--settings` would replace ours (claude reads one), so fold it in: their keys
  // win, hook lists are concatenated.
  const theirs = (user?.hooks ?? {}) as Record<string, unknown[]>;
  const hooks: Record<string, unknown[]> = { ...theirs };
  for (const [event, list] of Object.entries(ours))
    hooks[event] = [...(theirs[event] ?? []), ...list];
  const settings: Record<string, unknown> = { ...user, hooks };
  if (cfg.statusline)
    settings.statusLine = { type: 'command', command: `${selfCommand()} statusline` };
  // One file per wrapper: claude re-reads settings files when they change, so a shared
  // file rewritten by another ccmx would swap this session's settings under it.
  const dir = join(runtimeDir(), 'launch');
  pruneDead(dir);
  const file = join(dir, `settings-${process.pid}.json`);
  writeJson(file, settings);
  return file;
}

const COMMANDS: Record<string, { description: string; hint?: string }> = {
  switch: { description: 'Move this session to another Claude profile', hint: '[profile]' },
  list: { description: 'Show ccmx profiles with usage and status' },
  status: { description: 'Show the profile and session ccmx is running' },
  history: { description: 'Show recent ccmx profile switches' },
  help: { description: 'Show ccmx slash commands' }
};

/**
 * A session-only plugin (`--plugin-dir`) so `/ccmx:*` autocompletes. The prompt hook
 * answers these before they expand; the body only shows if ccmx hooks are not active.
 */
export function writePlugin(): string {
  const dir = join(runtimeDir(), 'plugin');
  writeJson(
    join(dir, '.claude-plugin', 'plugin.json'),
    {
      name: 'ccmx',
      version: '0.1.0',
      description: 'Slash commands for the ccmx Claude Code multiplexer'
    },
    0o644
  );
  for (const [name, c] of Object.entries(COMMANDS)) {
    const front = [`description: ${c.description}`, c.hint ? `argument-hint: ${c.hint}` : '']
      .filter(Boolean)
      .join('\n');
    writeAtomic(
      join(dir, 'commands', `${name}.md`),
      `---\n${front}\n---\nTell the user: "/ccmx:${name} only works in a session started with \`ccmx\`." Do nothing else.\n`,
      0o644
    );
  }
  return dir;
}

export function removeLaunchSettings() {
  rmSync(join(runtimeDir(), 'launch', `settings-${process.pid}.json`), { force: true });
}
