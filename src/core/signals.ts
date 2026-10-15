import { readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, runtimeDir, writeJson } from '@/core/runtime';

/**
 * Hooks run inside claude and cannot talk to the wrapper directly, so they drop small
 * JSON files named `<wrapper pid>-<signal>`; the wrapper polls and consumes them. The pid
 * keeps wrappers in different terminals apart.
 */
export type Signals = {
  'session-started': { sessionId: string; cwd?: string; source?: string };
  stopped: { sessionId?: string };
  'rate-limited': { message: string };
  'turn-failed': { message: string };
  'switch-requested': {
    target?: string;
    trigger: 'manual' | 'threshold' | 'rate-limit';
    resumeMessage?: string;
  };
  'prompt-submitted': { startsTurn: boolean };
};

export type SignalName = keyof Signals;

/** Checked in this order every tick: the first that matters decides. */
export const SIGNAL_ORDER: SignalName[] = [
  'session-started',
  'rate-limited',
  'turn-failed',
  'switch-requested',
  'prompt-submitted',
  'stopped'
];

const dir = () => join(runtimeDir(), 'signals');
const path = (pid: number, name: string) => join(dir(), `${pid}-${name}`);

export function sendSignal<K extends SignalName>(pid: number, name: K, payload: Signals[K]) {
  writeJson(path(pid, name), { ...payload, timestamp: Date.now() });
}

export function takeSignal<K extends SignalName>(
  pid: number,
  name: K
): (Signals[K] & { timestamp: number }) | undefined {
  // Move it aside first: a hook writing the same signal again meanwhile lands as a new
  // file instead of being deleted unread.
  const p = path(pid, name);
  const taken = `${p}.${process.pid}.taken`;
  try {
    renameSync(p, taken);
  } catch {
    return undefined;
  }
  const v = readJson<Signals[K] & { timestamp: number }>(taken);
  rmSync(taken, { force: true });
  return v;
}

export function clearSignals(pid: number) {
  let names: string[];
  try {
    names = readdirSync(dir());
  } catch {
    return;
  }
  for (const n of names) if (n.startsWith(`${pid}-`)) rmSync(join(dir(), n), { force: true });
}

const replayFlag = (pid: number) => join(runtimeDir(), `replay-${pid}.flag`);

/** One-shot: the next prompt is a replay after a threshold switch; don't switch again on it. */
export function setReplayFlag(pid: number) {
  writeJson(replayFlag(pid), { at: Date.now() });
}

export function takeReplayFlag(pid: number): boolean {
  const p = replayFlag(pid);
  const had = !!readJson(p);
  if (had) rmSync(p, { force: true });
  return had;
}
