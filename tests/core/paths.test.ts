import { describe, expect, it } from 'bun:test';
import { slugFor } from '@/core/paths';

describe('slugFor matches Claude Code’s project folder names', () => {
  it('replaces every non-alphanumeric character', () => {
    expect(slugFor('/home/me/code/my.app')).toBe('-home-me-code-my-app');
  });

  // Expected value computed separately (Python port of claude 2.1.300's j0 + string hash).
  const long = `/tmp/${Array.from({ length: 8 }, (_, i) => `very-long-folder-name-for-testing-${i}`).join('/')}/café`;
  const expected =
    '-tmp-very-long-folder-name-for-testing-0-very-long-folder-name-for-testing-1-very-long-folder-name-for-testing-2-very-long-folder-name-for-testing-3-very-long-folder-name-for-testing-4-very-long-folde-mmkvvw';

  it('cuts names over 200 characters and appends the hash claude uses', () => {
    expect(slugFor(long)).toBe(expected);
  });

  it('normalises to NFC first, as claude does', () => {
    expect(slugFor(long.replace('café', 'café'))).toBe(expected);
  });
});
