import { describe, expect, it } from 'bun:test';
import { carriedArgs, parseArgs } from '@/core/args';

const UUID = '11111111-2222-4333-8444-555555555555';

describe('parseArgs', () => {
  it("pulls out ccmx's flags and keeps the rest in order", () => {
    const p = parseArgs(['--as', 'bob', '--model', 'opus', '-r', UUID, 'fix it']);
    expect(p).toMatchObject({ as: 'bob', resume: UUID, rest: ['--model', 'opus', 'fix it'] });
  });

  it('opens the picker for --resume without an id, with a search term', () => {
    expect(parseArgs(['-r']).resume).toBeNull();
    expect(parseArgs(['--resume', 'relay'])).toMatchObject({
      resume: null,
      search: 'relay',
      rest: []
    });
  });
});

describe('carriedArgs', () => {
  it('keeps flags on a relaunch but never re-sends the first prompt', () => {
    const rest = ['--model', 'opus', 'build it', '--verbose', '-w', 'tree', '--fork-session'];
    expect(carriedArgs(rest)).toEqual(['--model', 'opus', '--verbose']);
  });
});

describe('carriedArgs against claude --help', () => {
  it('keeps single-value flags with their value', () => {
    expect(carriedArgs(['--effort', 'high', 'go', '--output-format', 'json'])).toEqual([
      '--effort',
      'high',
      '--output-format',
      'json'
    ]);
  });

  it('keeps every value of a variadic flag, as claude itself reads them', () => {
    expect(carriedArgs(['--add-dir', 'a', 'b', '--model', 'opus'])).toEqual([
      '--add-dir',
      'a',
      'b',
      '--model',
      'opus'
    ]);
  });

  it('keeps an optional-value flag bare, since its next word may be the prompt', () => {
    expect(carriedArgs(['--debug', 'fix the parser'])).toEqual(['--debug']);
    expect(carriedArgs(['--debug=api', 'x'])).toEqual(['--debug=api']);
  });

  it('drops flags that would fork, detach or open a new worktree', () => {
    expect(carriedArgs(['--fork-session', '--bg', '-w', 'tree', '--verbose'])).toEqual([
      '--verbose'
    ]);
  });
});
