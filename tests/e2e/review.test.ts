/**
 * Regressions for the bugs found in review (2026-10-15). Each test names the behaviour
 * that used to be wrong.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { CLI, Sandbox } from './helpers';

let sb: Sandbox;
beforeEach(() => {
  sb = new Sandbox();
});
afterEach(() => sb.cleanup());

const state = () => JSON.parse(readFileSync(join(sb.home, '.ccmx', 'state.json'), 'utf8'));
const limited = (p: string) => (state().profiles[p]?.limitedUntil ?? 0) > Date.now();

describe('limits need evidence', () => {
  it('retries server throttling on the same profile and marks nobody limited', () => {
    sb.run(['--as', 'alice'], { FAKE_THROTTLE: '.claude-alice', FAKE_HOLD_MS: '2000' });
    const [a, b] = sb.calls();
    expect(b!.dir).toBe(a!.dir);
    expect(b!.args.slice(-2)).toEqual(['--', 'Go continue.']);
    expect(limited('alice')).toBe(false);
  });

  it('moves a session off a one-model cap without marking the whole profile limited', () => {
    sb.run(['--as', 'alice'], { FAKE_LIMIT: '.claude-alice', FAKE_LIMIT_TYPE: 'seven_day_opus' });
    expect(sb.calls().at(1)!.dir).not.toBe('.claude-alice');
    expect(limited('alice')).toBe(false);
  });
});

describe('thresholds', () => {
  it('never moves onto a profile that is itself over threshold (no ping-pong)', () => {
    sb.config({ wait_for_reset: false, thresholds: { five_hour: 100, seven_day: 80 } });
    sb.usage('alice', 10, 85);
    sb.usage('bob', 10, 90);
    sb.usage('claude', 10, 95);
    sb.run(['--as', 'alice'], { FAKE_STAY_MS: '600' });
    expect(sb.calls()).toHaveLength(1);
  });

  it('sends nothing after a finished turn when moving at a threshold', () => {
    sb.config({ wait_for_reset: false, thresholds: { five_hour: 90, seven_day: 100 } });
    sb.usage('alice', 95);
    sb.usage('claude', 10);
    sb.usage('bob', 50);
    sb.run(['--as', 'alice'], { FAKE_STAY_MS: '600' });
    const [a, b] = sb.calls();
    expect(b).toMatchObject({ dir: '.claude', args: ['--resume', a!.args.at(1)!] });
  });

  it('still starts when every profile is busy (90–99%) but none is limited', () => {
    for (const p of ['claude', 'alice', 'bob']) sb.usage(p, 95);
    expect(sb.run([]).code).toBe(0);
    expect(sb.run(['-p', 'x']).code).toBe(0);
    expect(sb.calls()).toHaveLength(2);
  });

  it('replays a blocked prompt that starts with "-" after --, so it stays a prompt', () => {
    sb.config({ wait_for_reset: false, thresholds: { five_hour: 90, seven_day: 100 } });
    sb.usage('alice', 95);
    sb.usage('claude', 10);
    sb.usage('bob', 50);
    sb.run(['--as', 'alice'], { FAKE_PROMPT: '- fix A\n- fix B' });
    expect(sb.calls().at(1)!.args.slice(-2)).toEqual(['--', '- fix A\n- fix B']);
    // The replayed prompt is not bounced again by the new profile's prompt hook.
    expect(sb.lines().find((l) => l.first)?.blocked).toBe(false);
  });
});

describe('switch requests', () => {
  it('force-switch without a name moves to a profile with room instead of ending the session', async () => {
    const proc = Bun.spawn(['bun', CLI, '--as', 'alice'], {
      cwd: sb.work,
      env: sb.env({ FAKE_STAY_MS: '4000' }),
      stdout: 'pipe',
      stderr: 'pipe'
    });
    const runtime = join(sb.home, '.ccmx', 'runtime', 'sessions');
    for (let i = 0; i < 50 && !(existsSync(runtime) && readdirSync(runtime).length); i++)
      await Bun.sleep(100);
    await Bun.sleep(400);
    expect(sb.run(['force-switch']).code).toBe(0);
    await proc.exited;
    const dirs = sb.calls().map((c) => c.dir);
    expect(dirs.at(0)).toBe('.claude-alice');
    expect(dirs.at(1)).toBeDefined();
    expect(dirs.at(1)).not.toBe('.claude-alice');
  }, 20_000);

  it('leaves a project’s own /switch command alone', () => {
    sb.run(['--as', 'alice'], { FAKE_PROMPT: '/switch main', FAKE_HOLD_MS: '300' });
    expect(sb.lines().some((l) => l.blocked === true || typeof l.blocked === 'string')).toBe(false);
    expect(sb.calls()).toHaveLength(1);
  });
});

describe('sessions and copies', () => {
  it('keeps a diverged copy instead of overwriting it', () => {
    sb.run(['--as', 'alice']);
    const id = sb.calls().at(0)!.args.at(1)!;
    sb.run(['--resume', id, '--as', 'bob']);
    // Both copies grow apart (two terminals), then the session is resumed on bob again.
    const bobFile = join(sb.home, '.claude-bob', 'projects', sb.slug(), `${id}.jsonl`);
    const aliceFile = join(sb.home, '.claude-alice', 'projects', sb.slug(), `${id}.jsonl`);
    writeFileSync(bobFile, `${readFileSync(bobFile, 'utf8')}{"type":"user","note":"bob only"}\n`);
    writeFileSync(
      aliceFile,
      `${readFileSync(aliceFile, 'utf8')}{"type":"user","note":"alice only, longer line"}\n`
    );
    sb.run(['--resume', id, '--as', 'bob']);
    const kept = readdirSync(join(sb.home, '.claude-bob', 'projects', sb.slug())).filter((f) =>
      f.includes('.bak-')
    );
    expect(kept).toHaveLength(1);
    expect(
      readFileSync(join(sb.home, '.claude-bob', 'projects', sb.slug(), kept[0]!), 'utf8')
    ).toContain('bob only');
  });

  it('does not treat ~/.claude-bak style copies as profiles', () => {
    mkdirSync(join(sb.home, '.claude-bak', 'projects'), { recursive: true });
    expect(sb.run(['list']).out).not.toContain('bak');
  });

  it('matches a project pool created through a symlinked folder', () => {
    const link = join(sb.home, 'link-to-work');
    symlinkSync(sb.work, link);
    expect(sb.run(['project', 'create', 'work', '--dir', link]).code).toBe(0);
    expect(sb.run(['project', 'assign', 'work', 'bob']).code).toBe(0);
    sb.run([]);
    expect(sb.calls().at(0)!.dir).toBe('.claude-bob');
  });

  it('clears history on a fresh install', () => {
    expect(sb.run(['history', '--clear']).code).toBe(0);
  });
});

describe('migrate safety', () => {
  it('changes nothing without --yes', () => {
    sb.run(['--as', 'bob']);
    sb.run(['migrate']);
    expect(existsSync(join(sb.home, '.ccmx', 'projects'))).toBe(false);
  });

  it('refuses when profiles clean up transcripts after different periods', () => {
    writeFileSync(
      join(sb.home, '.claude', 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 3650 })
    );
    const r = sb.run(['migrate', '--yes']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('cleanupPeriodDays');
  });

  it('keeps the longer of two copies of a transcript, whatever the timestamps', () => {
    const slug = '-proj';
    const put = (d: string, body: string, mtime: number) => {
      const dir = join(sb.home, d, 'projects', slug);
      mkdirSync(dir, { recursive: true });
      const f = join(dir, '11111111-2222-4333-8444-555555555555.jsonl');
      writeFileSync(f, body);
      const t = new Date(mtime);
      require('node:fs').utimesSync(f, t, t);
    };
    const full = '{"a":1}\n{"a":2}\n{"a":3}\n';
    put('.claude-alice', full, Date.now() - 3600_000);
    put('.claude-bob', '{"a":1}\n', Date.now()); // truncated but newer
    expect(sb.run(['migrate', '--yes', '--force']).code).toBe(0);
    const merged = readFileSync(
      join(sb.home, '.ccmx', 'projects', slug, '11111111-2222-4333-8444-555555555555.jsonl'),
      'utf8'
    );
    expect(merged).toBe(full);
  });
});

describe('statusline', () => {
  it('shows the user’s own statusline from their --settings', () => {
    const r = spawnSync('bun', [CLI, 'statusline'], {
      env: sb.env({ CCMX_PROFILE: 'alice', CCMX_USER_STATUSLINE: 'echo mine' }),
      input: JSON.stringify({
        rate_limits: { five_hour: { used_percentage: 12, resets_at: 9999999999 } }
      })
    });
    expect(r.stdout.toString().trim()).toBe('mine');
    const usage = JSON.parse(
      readFileSync(join(sb.home, '.ccmx', 'runtime', 'usage', 'alice.json'), 'utf8')
    );
    expect(usage.five_hour.used).toBe(12);
  });
});
