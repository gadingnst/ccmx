import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive, readJson, runtimeDir, writeJson } from '@/core/runtime';

export type SessionState = 'running' | 'switching' | 'retrying' | 'waiting-reset' | 'parked';

export type LiveSession = {
  pid: number;
  cwd: string;
  sessionId?: string;
  profile: string;
  state: SessionState;
  detail?: string;
  startedAt: number;
  updatedAt: number;
};

export type EndedSession = {
  pid: number;
  sessionId: string;
  cwd: string;
  profile: string;
  endedAt: number;
};

const liveDir = () => join(runtimeDir(), 'sessions');
const recentDir = () => join(runtimeDir(), 'recent');

const RECENT_DAYS = 30;
const RECENT_MAX = 50;

export function writeLive(s: LiveSession) {
  writeJson(join(liveDir(), `${s.pid}.json`), { ...s, updatedAt: Date.now() });
}

export function endLive(pid: number, record?: Omit<EndedSession, 'pid' | 'endedAt'>) {
  rmSync(join(liveDir(), `${pid}.json`), { force: true });
  if (record?.sessionId)
    writeJson(join(recentDir(), `${pid}.json`), { ...record, pid, endedAt: Date.now() });
}

function readDir<T>(dir: string): { file: string; value: T }[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const value = readJson<T>(join(dir, n));
    return value ? [{ file: join(dir, n), value }] : [];
  });
}

/** Running wrappers. A dead one (killed terminal) is turned into a recent record, not lost. */
export function listLive(): LiveSession[] {
  const out: LiveSession[] = [];
  for (const { value } of readDir<LiveSession>(liveDir())) {
    if (pidAlive(value.pid)) out.push(value);
    else
      endLive(
        value.pid,
        value.sessionId
          ? { sessionId: value.sessionId, cwd: value.cwd, profile: value.profile }
          : undefined
      );
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listRecent(now = Date.now()): EndedSession[] {
  const all = readDir<EndedSession>(recentDir()).sort((a, b) => b.value.endedAt - a.value.endedAt);
  const keep: EndedSession[] = [];
  all.forEach(({ file, value }, i) => {
    if (i >= RECENT_MAX || now - value.endedAt > RECENT_DAYS * 86_400_000)
      rmSync(file, { force: true });
    else keep.push(value);
  });
  return keep;
}
