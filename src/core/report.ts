import type { Config } from '@/core/config';
import { readHistory } from '@/core/history';
import { account, discoverProfiles, storeMode } from '@/core/profiles';
import { loadState } from '@/core/state';
import { isExhausted } from '@/core/strategy';
import { headroom, readUsage } from '@/core/usage';
import { ago, clock } from '@/utils/time';
export { formatTable } from '@/utils/table';

const pct = (n?: number) => (n === undefined ? '  -' : `${Math.round(n)}%`.padStart(4));

function bar(n?: number) {
  if (n === undefined) return '·····';
  const filled = Math.min(5, Math.round(n / 20));
  return '█'.repeat(filled) + '·'.repeat(5 - filled);
}

const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : null);

/** One profile as `ccmx list --json` and `ccmx status --json` report it. */
export type ProfileSummary = {
  name: string;
  dir: string;
  default: boolean;
  email: string | null;
  status: 'ready' | 'limited' | 'full' | 'logged-out';
  /** ISO time an enforced limit lifts, when one was recorded. */
  limitedUntil: string | null;
  limitType: string | null;
  /** Percent used per window from the statusline; null when unknown. */
  usage: {
    fiveHour: number | null;
    sevenDay: number | null;
    recordedAt: string | null;
    stale: boolean;
  };
  /** Picked by hand with /ccmx:switch: threshold switching leaves it alone. */
  pinned: boolean;
  lastUsed: string | null;
  sessions: ReturnType<typeof storeMode>;
};

export function profileSummaries(): ProfileSummary[] {
  const st = loadState();
  return discoverProfiles().map((p) => {
    const a = account(p);
    const h = headroom(p.name);
    const status = !a
      ? 'logged-out'
      : h.limitedUntil
        ? 'limited'
        : isExhausted(h)
          ? 'full'
          : 'ready';
    return {
      name: p.name,
      dir: p.dir,
      default: p.isDefault,
      email: a?.email ?? null,
      status,
      limitedUntil: iso(h.limitedUntil),
      limitType: h.limitedUntil ? (st.profiles[p.name]?.limitType ?? null) : null,
      usage: {
        fiveHour: h.five ?? null,
        sevenDay: h.seven ?? null,
        recordedAt: iso(readUsage(p.name).polled_at),
        stale: h.stale
      },
      pinned: Object.values(st.pins).some((x) => x.profile === p.name),
      lastUsed: iso(st.profiles[p.name]?.lastUsed),
      sessions: storeMode(p)
    };
  });
}

/** Plain-text profile table, shared by `ccmx list`, `ccmx status` and `/ccmx:list`. */
export function profileRows(_cfg: Config, current?: string): string[][] {
  const rows = [['', 'PROFILE', 'ACCOUNT', 'STATUS', '5H', '7D', 'SESSIONS', 'LAST USED']];
  for (const s of profileSummaries()) {
    let status: string = s.status === 'logged-out' ? 'logged out' : s.status;
    if (s.status === 'limited' && s.limitedUntil)
      status = `limited → ${clock(Date.parse(s.limitedUntil))}`;
    else if (s.status === 'ready' && s.usage.stale && s.usage.recordedAt) status = 'ready (stale)';
    if (s.pinned) status += ' · pinned';
    const five = s.usage.fiveHour ?? undefined;
    const seven = s.usage.sevenDay ?? undefined;
    rows.push([
      s.name === current ? '▶' : '',
      s.name,
      s.email ?? '-',
      status,
      `${bar(five)} ${pct(five)}`,
      `${bar(seven)} ${pct(seven)}`,
      s.sessions,
      s.lastUsed ? ago(Date.parse(s.lastUsed)) : '-'
    ]);
  }
  return rows;
}

export function historyLines(n: number): string[] {
  const out: string[] = [];
  for (const e of readHistory().slice(0, n)) {
    const u = (x?: { five?: number; seven?: number }) =>
      x ? `5h ${pct(x.five).trim()} 7d ${pct(x.seven).trim()}` : '?';
    out.push(`${new Date(e.at).toLocaleString()}  ${e.from} → ${e.to}  [${e.trigger}]`);
    out.push(`    ${e.reason}`);
    if (e.fromUsage || e.toUsage) out.push(`    usage: ${u(e.fromUsage)} → ${u(e.toUsage)}`);
    if (e.sessionId) out.push(`    session ${e.sessionId.slice(0, 8)} in ${e.cwd}`);
  }
  return out;
}
