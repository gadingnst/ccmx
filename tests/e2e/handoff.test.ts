import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sandbox } from './helpers';

let sb: Sandbox;
beforeEach(() => {
  sb = new Sandbox();
});
afterEach(() => sb.cleanup());

const AUTO = 'Go continue.';

describe('hand-off on a rate limit', () => {
  it('moves the live session to another profile without the user quitting', () => {
    const r = sb.run(['--as', 'alice', '--model', 'opus', 'build it'], {
      FAKE_LIMIT: '.claude-alice'
    });
    expect(r.code).toBe(0);
    const [first, second] = sb.calls();
    const id = first!.args.at(1)!;
    expect(first!.dir).toBe('.claude-alice');
    expect(second!.dir).not.toBe('.claude-alice');
    // Same session, flags kept, first prompt not re-sent, work nudged to continue.
    expect(second!.args).toEqual(['--model', 'opus', '--resume', id, '--', AUTO]);
    expect(existsSync(join(sb.home, second!.dir, 'projects', sb.slug(), `${id}.jsonl`))).toBe(true);
    expect(sb.run(['list']).out).toMatch(/alice\s+alice@example.com\s+limited/);
    expect(sb.run(['history', '--json']).out).toContain('"trigger": "rate-limit"');
  });

  it('hands off profile to profile, then parks on the last and never relaunches after exit', () => {
    const r = sb.run([], { FAKE_LIMIT: '.claude,.claude-alice,.claude-bob', FAKE_HOLD_MS: '400' });
    expect(r.code).toBe(0);
    expect(sb.calls().map((c) => c.dir)).toEqual(['.claude', '.claude-alice', '.claude-bob']);
    const list = sb.run(['list']).out;
    for (const p of ['claude', 'alice', 'bob'])
      expect(list).toMatch(new RegExp(`${p}\\s+\\S+\\s+limited`));
  });

  it('records the reset time from the transcript, not a guess', () => {
    sb.run(['--as', 'alice'], { FAKE_LIMIT: '.claude-alice' });
    const state = JSON.parse(readFileSync(join(sb.home, '.ccmx', 'state.json'), 'utf8'));
    const until = state.profiles.alice.limitedUntil - Date.now();
    // The fake's quotaLimits say one hour; the fallback guess would be 15 minutes.
    expect(until).toBeGreaterThan(50 * 60_000);
    expect(state.profiles.alice.limitType).toBe('five_hour');
  });

  it('stays put when auto switching is off', () => {
    sb.config({ wait_for_reset: false, auto_switch_on_rate_limit: false });
    sb.run(['--as', 'alice'], { FAKE_LIMIT: '.claude-alice', FAKE_HOLD_MS: '300' });
    expect(sb.calls()).toHaveLength(1);
  });
});

describe('/ccmx:switch inside a session', () => {
  it('moves to the named profile with no automatic first message', () => {
    sb.run(['--as', 'alice'], { FAKE_PROMPT: '/ccmx:switch bob' });
    const [first, second] = sb.calls();
    const id = first!.args.at(1)!;
    expect(sb.lines().find((l) => l.blocked)?.blocked).toContain('switching to bob');
    expect(second).toMatchObject({ dir: '.claude-bob', args: ['--resume', id] });
    expect(sb.run(['history', '--json']).out).toContain('"trigger": "manual"');
    // The pin belongs to that session and ends with it.
    expect(sb.run(['list']).out).not.toContain('pinned');
  });

  it('refuses an unknown profile and keeps the session where it is', () => {
    sb.run(['--as', 'alice'], { FAKE_PROMPT: '/ccmx:switch ghost', FAKE_HOLD_MS: '300' });
    expect(sb.lines().find((l) => l.blocked)?.blocked).toContain('no profile "ghost"');
    expect(sb.calls()).toHaveLength(1);
  });

  it('answers /ccmx:list without reaching the model', () => {
    sb.run(['--as', 'alice'], { FAKE_PROMPT: '/ccmx:list', FAKE_HOLD_MS: '300' });
    expect(sb.lines().find((l) => l.blocked)?.blocked).toContain('bob@example.com');
  });
});

describe('threshold switching', () => {
  it('moves before the limit and replays the blocked prompt on the new profile', () => {
    sb.config({ wait_for_reset: false, thresholds: { five_hour: 90, seven_day: 100 } });
    sb.usage('alice', 95);
    sb.usage('claude', 10);
    sb.usage('bob', 50);
    sb.run(['--as', 'alice'], { FAKE_PROMPT: 'refactor the parser' });
    const [first, second] = sb.calls();
    expect(second).toMatchObject({
      dir: '.claude',
      args: ['--resume', first!.args.at(1)!, '--', 'refactor the parser']
    });
  });

  it('leaves the prompt alone under the threshold', () => {
    sb.config({ wait_for_reset: false, thresholds: { five_hour: 90, seven_day: 100 } });
    sb.usage('alice', 40);
    sb.run(['--as', 'alice'], { FAKE_PROMPT: 'refactor the parser' });
    expect(sb.calls()).toHaveLength(1);
    expect(sb.lines().some((l) => l.blocked)).toBe(false);
  });
});

describe('force-switch from another terminal', () => {
  it('fails when no ccmx session is running', () => {
    const r = sb.run(['force-switch', 'bob']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no running ccmx session');
  });
});
