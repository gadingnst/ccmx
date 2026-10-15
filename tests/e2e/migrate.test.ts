import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sandbox } from './helpers';

let sb: Sandbox;
beforeEach(() => {
  sb = new Sandbox();
});
afterEach(() => sb.cleanup());

describe('ccmx migrate', () => {
  it('links every profile to one store and backs up the originals', () => {
    sb.run(['--as', 'bob']);
    sb.run(['--as', 'alice']);
    expect(sb.run(['migrate']).out).toContain('would link');
    expect(lstatSync(join(sb.home, '.claude-bob', 'projects')).isSymbolicLink()).toBe(false);

    expect(sb.run(['migrate', '--yes', '--force']).code).toBe(0);
    for (const d of ['.claude', '.claude-alice', '.claude-bob']) {
      expect(lstatSync(join(sb.home, d, 'projects')).isSymbolicLink()).toBe(true);
    }
    const out = sb.run(['sessions', '--here']).out.trim().split('\n');
    expect(out).toHaveLength(3); // header + both sessions, each once
    expect(out.at(1)).toContain('shared');
    expect(existsSync(join(sb.home, '.ccmx', 'backup'))).toBe(true);
  });

  it('unions MEMORY.md and keeps both versions of a clashing memory', () => {
    const mem = (d: string, files: Record<string, string>) => {
      const dir = join(sb.home, d, 'projects', '-proj', 'memory');
      mkdirSync(dir, { recursive: true });
      for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
    };
    mem('.claude-alice', { 'MEMORY.md': '- [A](a.md) — from alice\n', 'x.md': "alice's x" });
    mem('.claude-bob', { 'MEMORY.md': '- [B](b.md) — from bob\n', 'x.md': "bob's x, longer" });
    expect(sb.run(['migrate', '--yes', '--force']).code).toBe(0);
    const dir = join(sb.home, '.ccmx', 'projects', '-proj', 'memory');
    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
    expect(index).toContain('from alice');
    expect(index).toContain('from bob');
    expect(readFileSync(join(dir, 'x.md'), 'utf8')).toBe("alice's x");
    expect(readFileSync(join(dir, 'x.from-bob.md'), 'utf8')).toBe("bob's x, longer");
  });
});
