import type { Config } from '@/core/config';
import { type Profile, account, discoverProfiles } from '@/core/profiles';
import { loadState } from '@/core/state';
import { type Headroom, headroom, readyAt } from '@/core/usage';

export type Candidate = Headroom & { profile: Profile; lastUsed: number; email?: string };

export function candidates(now = Date.now()): Candidate[] {
  const st = loadState().profiles;
  return discoverProfiles()
    .map((p) => ({ p, a: account(p) }))
    .filter(({ a }) => a)
    .map(({ p, a }) => ({
      ...headroom(p.name, now),
      profile: p,
      email: a!.email,
      lastUsed: st[p.name]?.lastUsed ?? 0
    }));
}

/** Below 100 the threshold is the cap; at 100 ("only on a real limit") keep some room anyway. */
const capOf = (thr: number, fallback: number) => (thr < 100 ? thr : fallback);

/**
 * Can a session move onto this profile? Never onto one it would have to leave again at
 * once (that ping-pongs), and unknown readings count as room (fail open).
 */
export function hasCapacity(c: Headroom, cfg: Config): boolean {
  if (c.limitedUntil) return false;
  if (c.stale) return true;
  if (isOverThreshold(c, cfg)) return false;
  return (
    (c.five ?? 0) < capOf(cfg.thresholds.five_hour, 90) &&
    (c.seven ?? 0) < capOf(cfg.thresholds.seven_day, 100)
  );
}

/** Should a session leave this profile? Needs a fresh reading, except for an enforced limit. */
export function isOverThreshold(c: Headroom, cfg: Config): boolean {
  if (c.limitedUntil) return true;
  if (c.stale) return false;
  if ((c.five ?? 0) >= 100 || (c.seven ?? 0) >= 100) return true;
  const t = cfg.thresholds;
  if (t.seven_day < 100 && c.seven !== undefined && c.seven >= t.seven_day) return true;
  return t.five_hour < 100 && c.five !== undefined && c.five >= t.five_hour;
}

/** At a hard limit: nothing more can be sent on this profile right now. */
export function isExhausted(c: Headroom): boolean {
  return !!c.limitedUntil || (!c.stale && ((c.five ?? 0) >= 100 || (c.seven ?? 0) >= 100));
}

const orderIndex = (c: Candidate, order: string[]) => {
  const i = order.findIndex((o) => o === c.profile.name || o === c.email);
  return i < 0 ? order.length : i;
};

export type PickOptions = { exclude?: string[]; pool?: string[]; now?: number; forStart?: boolean };

/**
 * The profile a session should run on next, or undefined when none has room.
 * - balanced: most headroom first (lowest 7-day, then 5-hour), then least recently used.
 * - drain: `strategy.order` first, else the fullest 7-day first, so one profile is used up
 *   before the next is touched.
 * - least-recent: plain rotation by last use.
 * - manual: never switches by itself; at start it takes the first profile in order.
 */
export function pickTarget(cfg: Config, opts: PickOptions = {}): Profile | undefined {
  const now = opts.now ?? Date.now();
  // Starting fresh, any profile that can still answer will do (the roomiest first); moving
  // a session needs real room, or it would bounce straight back.
  const usable = (c: Candidate) => (opts.forStart ? !isExhausted(c) : hasCapacity(c, cfg));
  const list = candidates(now)
    .filter((c) => !opts.exclude?.includes(c.profile.name))
    .filter((c) => !opts.pool || opts.pool.includes(c.profile.name))
    .filter(usable);
  const kind = cfg.strategy.kind;
  if (kind === 'manual' && !opts.forStart) return undefined;
  const order = cfg.strategy.order;
  const byLast = (a: Candidate, b: Candidate) => a.lastUsed - b.lastUsed;
  const roomFirst = (a: Candidate, b: Candidate) =>
    opts.forStart ? Number(!hasCapacity(a, cfg)) - Number(!hasCapacity(b, cfg)) : 0;
  const sorted = [...list].sort((a, b) => {
    const r = roomFirst(a, b);
    if (r) return r;
    if (kind === 'balanced') {
      return (a.seven ?? 0) - (b.seven ?? 0) || (a.five ?? 0) - (b.five ?? 0) || byLast(a, b);
    }
    if (kind === 'drain') {
      const cap7 = capOf(cfg.thresholds.seven_day, 95);
      const roomy = (c: Candidate) => ((c.seven ?? 0) < cap7 ? 0 : 1);
      return (
        roomy(a) - roomy(b) ||
        orderIndex(a, order) - orderIndex(b, order) ||
        (b.seven ?? 0) - (a.seven ?? 0) ||
        byLast(a, b)
      );
    }
    if (kind === 'manual') return orderIndex(a, order) - orderIndex(b, order);
    return byLast(a, b);
  });
  return sorted.at(0)?.profile;
}

/** `/ccmx:switch` without a name: the next profile with room, in listing order after `current`. */
export function rotateFrom(current: string, cfg: Config, pool?: string[]): Profile | undefined {
  const all = candidates().filter((c) => !pool || pool.includes(c.profile.name));
  const i = all.findIndex((c) => c.profile.name === current);
  const ring = [...all.slice(i + 1), ...all.slice(0, Math.max(i, 0))];
  return ring.find((c) => c.profile.name !== current && hasCapacity(c, cfg))?.profile;
}

/** When the first limited profile frees up, for waiting and for messages. */
export function nextAvailable(
  cfg: Config,
  pool?: string[],
  now = Date.now()
): { profile: string; at: number } | undefined {
  return candidates(now)
    .filter((c) => !pool || pool.includes(c.profile.name))
    .map((c) => ({ profile: c.profile.name, at: readyAt(c.profile.name, cfg.thresholds, now) }))
    .filter((r) => r.at > now)
    .sort((a, b) => a.at - b.at)[0];
}
