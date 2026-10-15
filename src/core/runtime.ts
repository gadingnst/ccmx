import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ccmxDir } from '@/core/paths';

export const runtimeDir = () => join(ccmxDir(), 'runtime');

export function writeAtomic(file: string, data: string, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, file);
}

export function writeJson(file: string, value: unknown, mode = 0o600) {
  writeAtomic(file, JSON.stringify(value, null, 2), mode);
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Writes under the lock take milliseconds; a lock this old was left by a crashed process. */
const LOCK_STALE_MS = 5_000;

/**
 * Cross-process lock for read-modify-write of shared files. `mkdir` is atomic, so the
 * directory is the lock; one left behind by a crashed process expires after 30 s.
 */
export function withLock<T>(fn: () => T, timeoutMs = 10_000): T {
  const lock = join(runtimeDir(), '.lock');
  mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS)
          rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error('timed out waiting for the ccmx state lock');
      Bun.sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
