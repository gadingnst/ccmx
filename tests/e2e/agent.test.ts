import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS } from '@/cli';
import { COMMAND_SPECS } from '@/commands/help';
import { Sandbox } from './helpers';

let sb: Sandbox;
beforeEach(() => {
  sb = new Sandbox();
});
afterEach(() => sb.cleanup());

const json = (out: string) => JSON.parse(out);

describe('help for agents', () => {
  it('describes every command in help --json, and every described command exists', () => {
    const manifest = json(sb.run(['help', '--json']).out);
    const described = manifest.commands
      .map((c: any) => c.name)
      .filter((n: string) => n && n !== '-p');
    const aliases = ['--help', '-h', '--version', '-v', 'ls', 'hook', 'statusline'];
    const real = Object.keys(COMMANDS).filter((k) => !aliases.includes(k));
    expect(described.sort()).toEqual(real.sort());
    for (const c of manifest.commands) {
      expect(c.usage).toStartWith('ccmx');
      expect(typeof c.mutates).toBe('boolean');
    }
    expect(manifest.exitCodes['2']).toContain('usage');
  });

  it('marks what an agent must not run on its own', () => {
    const spec = (n: string) => COMMAND_SPECS.find((s) => s.name === n)!;
    expect(spec('').interactive).toBe(true);
    expect(spec('login').interactive).toBe(true);
    for (const n of ['logout', 'migrate', 'clear', 'skill']) expect(spec(n).mutates).toBe(true);
    expect(spec('status').mutates).toBeFalsy();
  });

  it('prints the agent guide and installs it as a skill', () => {
    expect(sb.run(['skill']).out).toStartWith('---\nname: ccmx');
    expect(sb.run(['skill', 'install', '--as', 'bob']).code).toBe(0);
    const file = join(sb.home, '.claude-bob', 'skills', 'ccmx', 'SKILL.md');
    expect(readFileSync(file, 'utf8')).toContain('ccmx -p');
    expect(existsSync(join(sb.home, '.claude-alice', 'skills', 'ccmx', 'SKILL.md'))).toBe(false);
  });
});

describe('state as JSON', () => {
  it('status --json reports profiles, the next profile and settings', () => {
    sb.usage('alice', 10, 5);
    const s = json(sb.run(['status', '--json']).out);
    expect(s.profiles.map((p: any) => p.name)).toEqual(['claude', 'alice', 'bob']);
    expect(s.profiles.find((p: any) => p.name === 'alice').usage.fiveHour).toBe(10);
    expect(typeof s.nextProfile).toBe('string');
    expect(s.config.strategy.kind).toBe('balanced');
    expect(s.running).toEqual([]);
  });

  it('sessions --json lists recently ended sessions with a resume command', () => {
    sb.run(['--as', 'alice']);
    const s = json(sb.run(['sessions', '--json']).out);
    expect(s.recent[0].profile).toBe('alice');
    expect(s.recent[0].resume).toStartWith('ccmx --resume ');
    expect(s.recent[0].title).toBe('Relay builder');
    const here = json(sb.run(['sessions', '--here', '--json']).out);
    expect(here[0].cwd).toBe(sb.work);
  });

  it('refuses an interactive launch without a terminal, pointing at -p', () => {
    const r = sb.run([], { CCMX_NO_TTY_OK: '' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('ccmx -p');
    expect(sb.calls()).toHaveLength(0);
  });
});

describe('headless -p', () => {
  it('rotates repeated runs across profiles', () => {
    sb.run(['-p', 'one']);
    sb.run(['-p', 'two']);
    sb.run(['-p', 'three']);
    expect(sb.calls().map((c) => c.dir)).toEqual(['.claude', '.claude-alice', '.claude-bob']);
  });

  it('finishes the turn on the next profile after a limit and prints one result', () => {
    const r = sb.run(['-p', 'summarise', '--output-format', 'json'], { FAKE_LIMIT: '.claude' });
    expect(r.code).toBe(0);
    const lines = r.out.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(json(lines[0]!)).toMatchObject({ is_error: false, result: 'done on .claude-alice' });
    const [first, second] = sb.calls();
    const id = first!.args.at(1)!;
    expect(second!.args).toEqual([
      '--resume',
      id,
      '-p',
      '--output-format',
      'json',
      '--',
      'Go continue.'
    ]);
    expect(r.err).toContain('continuing this turn on alice');
    expect(sb.run(['list', '--json']).out).toContain('"status": "limited"');
  });

  it('streams stream-json straight through and never hands off', () => {
    const r = sb.run(['-p', 'go', '--output-format', 'stream-json'], { FAKE_LIMIT: '.claude' });
    expect(r.code).toBe(1);
    expect(sb.calls()).toHaveLength(1);
  });

  it('stays on a pinned profile and reports the limit', () => {
    const r = sb.run(['-p', 'go', '--as', 'alice'], { FAKE_LIMIT: '.claude-alice' });
    expect(r.code).toBe(1);
    expect(sb.calls()).toHaveLength(1);
    expect(r.err).toContain('alice hit its usage limit');
  });

  it('continues an earlier session by id on whichever profile has room', () => {
    sb.run(['-p', 'first', '--as', 'bob']);
    const id = sb.calls().at(0)!.args.at(1)!;
    const r = sb.run(['-r', id, '-p', 'more']);
    expect(r.code).toBe(0);
    expect(sb.calls().at(1)!.args.slice(0, 2)).toEqual(['--resume', id]);
  });

  it('exits 1 with the first reset when every profile is limited', () => {
    sb.run(['-p', 'x'], { FAKE_LIMIT: '.claude,.claude-alice,.claude-bob' });
    const r = sb.run(['-p', 'again']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('every profile is limited');
  });
});

describe('without the Claude Code CLI', () => {
  it('says so plainly, with how to install it, instead of a spawn error', () => {
    for (const args of [['-p', 'x'], ['login', 'alice'], []]) {
      const r = sb.run(args, { CCMX_CLAUDE: '/nonexistent/claude' });
      expect(r.code).toBe(1);
      expect(r.err).toContain('Claude Code CLI not found');
      expect(r.err).toContain('claude.ai/install.sh');
    }
    expect(json(sb.run(['help', '--json']).out).requires[0]).toContain('Claude Code CLI');
  });
});
