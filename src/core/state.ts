import { join } from 'node:path';
import { ccmxDir } from '@/core/paths';
import { pidAlive, readJson, withLock, writeJson } from '@/core/runtime';

export type ProfileState = {
  lastUsed?: number;
  /** ms epoch; the profile is skipped by rotation until then. */
  limitedUntil?: number;
  limitType?: string;
};

export type State = {
  profiles: Record<string, ProfileState>;
  /**
   * Profiles picked by hand with /ccmx:switch, per wrapper pid: threshold switching leaves
   * that session alone. Other sessions are unaffected; the pin ends with its session.
   */
  pins: Record<string, { profile: string; at: number }>;
};

const file = () => join(ccmxDir(), 'state.json');

export function loadState(): State {
  const s = readJson<Partial<State>>(file());
  return { profiles: s?.profiles ?? {}, pins: s?.pins ?? {} };
}

export function saveState(s: State) {
  writeJson(file(), s);
}

export function mutateState(fn: (s: State) => void) {
  withLock(() => {
    const s = loadState();
    fn(s);
    saveState(s);
  });
}

export function updateProfile(name: string, patch: Partial<ProfileState>) {
  mutateState((s) => {
    s.profiles[name] = { ...s.profiles[name], ...patch };
  });
}

/** Pin (or with no profile, unpin) the session run by wrapper `pid`. */
export function setPin(pid: number, profile: string | undefined) {
  mutateState((s) => {
    if (profile) s.pins[pid] = { profile, at: Date.now() };
    else delete s.pins[pid];
    for (const k of Object.keys(s.pins)) if (!pidAlive(Number(k))) delete s.pins[k];
  });
}

export function pinnedTo(pid: number): string | undefined {
  return loadState().pins[pid]?.profile;
}
