import { join } from 'node:path';
import { readJson, runtimeDir, writeJson } from '@/core/runtime';
import { loadState } from '@/core/state';

/** One rate-limit window as Claude Code reports it: percent used and when it resets (ms). */
export type Window = { used: number; resets_at?: number };

export type Usage = { five_hour?: Window; seven_day?: Window; polled_at?: number };

/** A reading older than this is not trusted to move a session off a profile. */
export const STALE_MS = 30 * 60_000;

const file = (profile: string) => join(runtimeDir(), 'usage', `${profile}.json`);

export function readUsage(profile: string): Usage {
  return readJson<Usage>(file(profile)) ?? {};
}

const toWindow = (w: any): Window | undefined => {
  if (!w || typeof w.used_percentage !== 'number') return undefined;
  return {
    used: w.used_percentage,
    resets_at: typeof w.resets_at === 'number' ? w.resets_at * 1000 : undefined
  };
};

/** Record the `rate_limits` block of Claude Code's statusline input for a profile. */
export function recordStatusline(profile: string, rateLimits: any, now = Date.now()) {
  if (!rateLimits || typeof rateLimits !== 'object') return;
  const u: Usage = { polled_at: now };
  const five = toWindow(rateLimits.five_hour);
  const seven = toWindow(rateLimits.seven_day);
  if (five) u.five_hour = five;
  if (seven) u.seven_day = seven;
  if (!five && !seven) return;
  writeJson(file(profile), u);
}

/** What strategy code needs to know about a profile right now. */
export type Headroom = {
  five?: number;
  seven?: number;
  /** No fresh reading: never move a session off on these numbers alone. */
  stale: boolean;
  /** A limit the API actually enforced, recorded from the transcript. Ground truth. */
  limitedUntil: number;
};

/** Windows whose reset has passed are unknown again, not their old percentage. */
export function headroom(profile: string, now = Date.now()): Headroom {
  const u = readUsage(profile);
  const live = (w?: Window) => (w && (!w.resets_at || w.resets_at > now) ? w.used : undefined);
  const limitedUntil = loadState().profiles[profile]?.limitedUntil ?? 0;
  return {
    five: live(u.five_hour),
    seven: live(u.seven_day),
    stale: !u.polled_at || now - u.polled_at >= STALE_MS,
    limitedUntil: limitedUntil > now ? limitedUntil : 0
  };
}

/** Earliest time a profile's full windows reset, if any are full. */
export function readyAt(
  profile: string,
  thresholds: { five_hour: number; seven_day: number },
  now = Date.now()
) {
  const u = readUsage(profile);
  const h = headroom(profile, now);
  let at = h.limitedUntil;
  const full = (w: Window | undefined, thr: number) =>
    w?.resets_at && w.resets_at > now && w.used >= Math.min(thr, 100);
  if (!h.stale) {
    if (full(u.five_hour, thresholds.five_hour)) at = Math.max(at, u.five_hour!.resets_at!);
    if (full(u.seven_day, thresholds.seven_day)) at = Math.max(at, u.seven_day!.resets_at!);
  }
  return at > now ? at : 0;
}
