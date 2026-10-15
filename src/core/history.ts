import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeDir } from '@/core/runtime';

export type HistoryEntry = {
  at: number;
  from: string;
  to: string;
  trigger: 'manual' | 'threshold' | 'rate-limit' | 'model-switch' | 'idle' | 'retry';
  reason: string;
  sessionId?: string;
  cwd: string;
  fromUsage?: { five?: number; seven?: number };
  toUsage?: { five?: number; seven?: number };
};

const historyFile = () => join(runtimeDir(), 'history.jsonl');

/** Append-only, one line per switch: concurrent wrappers never lose each other's entries. */
export function appendHistory(e: HistoryEntry) {
  mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
  appendFileSync(historyFile(), `${JSON.stringify(e)}\n`, { mode: 0o600 });
}

export function readHistory(): HistoryEntry[] {
  try {
    return readFileSync(historyFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l: string) => {
        try {
          return [JSON.parse(l) as HistoryEntry];
        } catch {
          return [];
        }
      })
      .reverse();
  } catch {
    return [];
  }
}

export function clearHistory() {
  mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
  writeFileSync(historyFile(), '');
}
