import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limitEvidence, rateLimitSince, sessionTitle } from '@/core/sessions';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccmx-sessions-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const now = Date.now();
const ts = (ms: number) => new Date(ms).toISOString();
const limit = {
  type: 'assistant',
  error: 'rate_limit',
  isApiErrorMessage: true,
  quotaLimits: {
    status: 'rejected',
    resetsAt: Math.floor(now / 1000) + 600,
    rateLimitType: 'seven_day'
  }
};
const transcript = (lines: object[]) => {
  const f = join(dir, 't.jsonl');
  writeFileSync(f, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return f;
};

describe('rateLimitSince', () => {
  it('finds a limit from this run', () => {
    const hit = rateLimitSince(transcript([{ ...limit, timestamp: ts(now) }]), now - 1000, now);
    expect(hit?.type).toBe('seven_day');
  });

  it('ignores limits from before this run, and ones that have reset', () => {
    expect(
      rateLimitSince(transcript([{ ...limit, timestamp: ts(now - 5000) }]), now - 1000, now)
    ).toBeNull();
    expect(
      rateLimitSince(transcript([{ ...limit, timestamp: ts(now) }]), now - 1000, now + 3600_000)
    ).toBeNull();
  });

  it('treats a later successful turn as the limit clearing', () => {
    const f = transcript([
      { ...limit, timestamp: ts(now) },
      { type: 'assistant', timestamp: ts(now + 1), message: {} }
    ]);
    expect(rateLimitSince(f, now - 1000, now)).toBeNull();
  });
});

describe('sessionTitle', () => {
  it('keeps pasted text without the tags and skips command notes', () => {
    const f = transcript([
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      {
        type: 'user',
        message: { content: '\n<pasted_content id="1">fix the engine bug</pasted_content> please' }
      }
    ]);
    expect(sessionTitle(f)).toBe('fix the engine bug please');
  });
});

describe('transcripts as Claude Code writes them', () => {
  const bookkeeping = [
    { type: 'last-prompt', lastPrompt: 'x' },
    { type: 'ai-title', aiTitle: 'Engine bug hunt' },
    { type: 'mode', mode: 'normal' }
  ];

  it('finds a limit even when untimestamped lines follow it', () => {
    const f = transcript([{ ...limit, timestamp: ts(now) }, ...bookkeeping]);
    expect(rateLimitSince(f, now - 1000, now)?.type).toBe('seven_day');
  });

  it('titles a session with its AI title, else the first prompt', () => {
    expect(
      sessionTitle(transcript([{ type: 'user', message: { content: 'first' } }, ...bookkeeping]))
    ).toBe('Engine bug hunt');
    expect(sessionTitle(transcript([{ type: 'user', message: { content: 'first' } }]))).toBe(
      'first'
    );
  });
});

describe('limit evidence', () => {
  it('treats a rate_limit without a rejected quota as server throttling, not a usage limit', () => {
    const f = transcript([
      { type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, timestamp: ts(now) }
    ]);
    expect(rateLimitSince(f, now - 1000, now)).toBeNull();
    expect(limitEvidence(f, now - 1000, now)?.kind).toBe('transient');
  });

  it('marks a one-model cap as scoped', () => {
    const f = transcript([
      {
        ...limit,
        quotaLimits: { ...limit.quotaLimits, rateLimitType: 'seven_day_opus' },
        timestamp: ts(now)
      }
    ]);
    expect(rateLimitSince(f, now - 1000, now)).toMatchObject({
      scoped: true,
      type: 'seven_day_opus'
    });
  });
});
