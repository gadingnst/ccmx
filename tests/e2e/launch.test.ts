import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sandbox } from './helpers';

let sb: Sandbox;
beforeEach(() => {
  sb = new Sandbox();
});
afterEach(() => sb.cleanup());

describe('ccmx list', () => {
  it('shows logged-in profiles and skips unrelated dirs', () => {
    const { out } = sb.run(['list']);
    expect(out).toContain('main@example.com');
    expect(out).toContain('alice');
    expect(out).not.toContain('empty');
  });
});

describe('launching', () => {
  it('gives a new session an id ccmx controls, on the default profile without CLAUDE_CONFIG_DIR', () => {
    expect(sb.run([]).code).toBe(0);
    const [call] = sb.calls();
    expect(call!.dir).toBe('.claude');
    expect(call!.args.at(0)).toBe('--session-id');
  });

  it('spreads launches across profiles when none has usage data', () => {
    sb.run([]);
    sb.run([]);
    sb.run([]);
    expect(sb.calls().map((c) => c.dir)).toEqual(['.claude', '.claude-alice', '.claude-bob']);
  });

  it('starts on the profile with the most headroom', () => {
    sb.usage('claude', 80, 70);
    sb.usage('alice', 10, 20);
    sb.usage('bob', 10, 50);
    sb.run([]);
    expect(sb.calls().at(0)!.dir).toBe('.claude-alice');
  });

  it('fails clearly for an unknown --as profile', () => {
    const r = sb.run(['--as', 'ghost']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('no profile "ghost"');
  });

  it('passes subcommands and print mode straight through', () => {
    sb.run(['mcp', 'list']);
    sb.run(['-p', 'hi']);
    const [mcp, print] = sb.calls();
    expect(mcp!.args).toEqual(['mcp', 'list']);
    // -p gets a session id from ccmx so a limit can be followed up on another profile.
    expect(print!.args.slice(2)).toEqual(['-p', 'hi']);
    expect(print!.args.at(0)).toBe('--session-id');
  });
});

describe('resuming across profiles', () => {
  const firstId = () => sb.calls().at(0)!.args.at(1)!;

  it('--resume <id> --as <profile> continues another profile’s session under that profile', () => {
    sb.run(['--as', 'alice']);
    const id = firstId();
    sb.run(['--resume', id, '--as', 'bob']);
    expect(sb.calls().at(1)).toMatchObject({ dir: '.claude-bob', args: ['--resume', id] });
    expect(existsSync(join(sb.home, '.claude-bob', 'projects', sb.slug(), `${id}.jsonl`))).toBe(
      true
    );
  });

  it('accepts an id prefix as `ccmx sessions --here` prints it', () => {
    sb.run(['--as', 'alice']);
    const id = firstId();
    sb.run(['-r', id.slice(0, 8), '--as', 'bob']);
    expect(sb.calls().at(1)).toMatchObject({ dir: '.claude-bob', args: ['--resume', id] });
  });

  it('-c continues the folder’s latest session from another profile', () => {
    sb.run(['--as', 'bob']);
    const id = firstId();
    sb.run(['-c', '--as', 'alice']);
    expect(sb.calls().at(1)).toMatchObject({ dir: '.claude-alice', args: ['--resume', id] });
  });

  it('runs a session from another folder in that folder', () => {
    sb.run(['--as', 'alice']);
    const id = firstId();
    const elsewhere = join(sb.home, 'elsewhere');
    mkdirSync(elsewhere);
    expect(sb.run(['-r', id, '--as', 'bob'], {}, elsewhere).code).toBe(0);
    expect(sb.calls().at(1)).toMatchObject({ dir: '.claude-bob', cwd: sb.work });
  });
});

describe('ccmx sessions', () => {
  it('lists recently ended sessions with a resume line', () => {
    sb.run(['--as', 'alice']);
    const id = sb.calls().at(0)!.args.at(1)!;
    const { out } = sb.run(['sessions']);
    expect(out).toContain('Recently ended');
    expect(out).toContain(`ccmx --resume ${id}`);
  });
});

describe('which profile a passthrough runs on', () => {
  it('runs subcommands on the default profile and -p where there is room', () => {
    sb.usage('claude', 80, 70);
    sb.usage('alice', 5, 5);
    sb.usage('bob', 50, 50);
    sb.run(['mcp', 'list']);
    sb.run(['-p', 'hi']);
    expect(sb.calls().map((c) => c.dir)).toEqual(['.claude', '.claude-alice']);
  });
});

describe('ccmx itself', () => {
  it('shows its own help for --help and refuses --as without a name', () => {
    expect(sb.run(['--help']).out).toContain('Claude Code multiplexer');
    const r = sb.run(['--as']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--as needs a profile name');
  });

  it('waits for the first reset when every profile is limited, then launches', () => {
    sb.config({ wait_for_reset: true });
    const until = Date.now() + 1500;
    const profiles = Object.fromEntries(
      ['claude', 'alice', 'bob'].map((p) => [p, { limitedUntil: until, limitType: 'five_hour' }])
    );
    writeFileSync(join(sb.home, '.ccmx', 'state.json'), JSON.stringify({ profiles }));
    const started = Date.now();
    expect(sb.run([]).code).toBe(0);
    expect(Date.now() - started).toBeGreaterThan(1000);
    expect(sb.calls()).toHaveLength(1);
  });
});
