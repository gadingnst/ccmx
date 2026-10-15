import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { slugFor, storeDir } from '@/core/paths';
import { type Profile, discoverProfiles } from '@/core/profiles';

export type SessionCopy = { profile: string; file: string; mtime: number };

export type Session = {
  id: string;
  slug: string;
  mtime: number;
  /** Newest copy; the one to resume from. */
  file: string;
  /** Every profile that holds a copy (one entry once projects/ is shared). */
  profiles: string[];
  title?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s: string | undefined) => !!s && UUID_RE.test(s);

function readHead(file: string, bytes: number) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function readTail(file: string, bytes: number) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // Drop the partial first line when we started mid-file.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** Tags Claude Code wraps around commands and system notes: not something the user typed. */
const SYSTEM_TAG = /^<(command|local-command|system|bash-|user-memory|task-notification)/;

const clean = (s: string) =>
  s
    // A pasted coloured log must not clear the screen or switch buffers in the picker.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|.)/g, ' ')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/<\/?[a-z_-]+(?:\s[^>]*)?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A session's title for the picker: a name given with /rename, else the title Claude Code
 * generates (rewritten into the transcript over and over, so the newest is near the end),
 * else the first real prompt. Pasted blocks keep their text, minus the tags.
 */
export function sessionTitle(file: string): string | undefined {
  const tail = parseLines(readTail(file, 64 * 1024));
  for (const type of ['custom-title', 'ai-title']) {
    for (let i = tail.length - 1; i >= 0; i--) {
      const r = tail[i];
      const t = r?.type === type ? (r.customTitle ?? r.aiTitle) : undefined;
      if (typeof t === 'string' && clean(t)) return clean(t).slice(0, 120);
    }
  }
  for (const r of parseLines(readHead(file, 64 * 1024))) {
    if (r.type !== 'user' || r.isMeta || r.isSidechain) continue;
    const c = r.message?.content;
    const raw =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.find((x: any) => x?.type === 'text')?.text
          : undefined;
    const text = raw?.trim();
    if (!text || SYSTEM_TAG.test(text)) continue;
    const plain = clean(text);
    if (plain) return plain.slice(0, 120);
  }
}

/** The working directory Claude Code recorded for the session. */
export function sessionCwd(file: string): string | undefined {
  // Read on until a complete line carries a cwd: the first lines can be a huge paste.
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(256 * 1024);
    let carry = '';
    for (let pos = 0; pos < 16 * 1024 * 1024; pos += chunk.length) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n === 0) break;
      const lines = (carry + chunk.subarray(0, n).toString('utf8')).split('\n');
      carry = lines.pop() ?? '';
      for (const r of parseLines(lines.join('\n'))) if (typeof r.cwd === 'string') return r.cwd;
    }
    for (const r of parseLines(carry)) if (typeof r.cwd === 'string') return r.cwd;
  } finally {
    closeSync(fd);
  }
}

/** A full id, or an id prefix (as `ccmx sessions` prints) that names exactly one session. */
export function resolveSessionId(ref: string): string | undefined {
  if (isUuid(ref)) return ref;
  if (!/^[0-9a-f-]{6,}$/i.test(ref)) return undefined;
  const q = ref.toLowerCase();
  const hits = listSessions().filter((s) => s.id.startsWith(q));
  return hits.length === 1 ? hits.at(0)!.id : undefined;
}

export type RateLimitHit = {
  resetsAt: number;
  type?: string;
  at: number;
  /** A cap on one model (weekly Opus, …), not on the whole account. */
  scoped: boolean;
};

/** What the transcript says about a refused turn. */
export type LimitEvidence = ({ kind: 'usage' } & RateLimitHit) | { kind: 'transient'; at: number };

const ACCOUNT_WINDOWS = ['five_hour', 'seven_day'];

function scanForLimit(
  file: string,
  sinceMs: number,
  now: number,
  sidechain: boolean
): LimitEvidence | null {
  if (!existsSync(file)) return null;
  const records = parseLines(readTail(file, 512 * 1024));
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records.at(i);
    // Bookkeeping lines (mode, last-prompt, ai-title, …) carry no timestamp and usually end
    // the file; skip them rather than stopping there.
    const at = Date.parse(r?.timestamp ?? '');
    if (!Number.isFinite(at)) continue;
    if (at < sinceMs) break;
    if (r.isSidechain && !sidechain) continue;
    // A later successful assistant turn means the limit cleared within the run.
    if (r.type === 'assistant' && !r.isApiErrorMessage) return null;
    if (r.error !== 'rate_limit') continue;
    const q = r.quotaLimits;
    const resetsAt = (q?.resetsAt ?? 0) * 1000;
    // Only a rejected quota with a reset time is a usage limit. Server throttling and
    // capacity errors are written as rate_limit too, without one: retry, never park.
    if (q?.status !== 'rejected' || !resetsAt) return { kind: 'transient', at };
    if (resetsAt <= now) return null;
    const type = q.rateLimitType as string | undefined;
    return { kind: 'usage', resetsAt, type, at, scoped: !!type && !ACCOUNT_WINDOWS.includes(type) };
  }
  return null;
}

/**
 * The refusal Claude Code wrote during this run, from the session transcript or, for a
 * limit hit inside a subagent, from the subagent transcripts next to it.
 */
export function limitEvidence(
  file: string,
  sinceMs: number,
  now = Date.now()
): LimitEvidence | null {
  const main = scanForLimit(file, sinceMs, now, false);
  if (main) return main;
  const dir = join(dirname(file), basename(file, '.jsonl'), 'subagents');
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {}
  for (const n of names) {
    const f = join(dir, n);
    if (statSync(f).mtimeMs < sinceMs) continue;
    const hit = scanForLimit(f, sinceMs, now, true);
    if (hit) return hit;
  }
  return null;
}

/** A usage limit enforced during this run, if it still applies. */
export function rateLimitSince(
  file: string,
  sinceMs: number,
  now = Date.now()
): RateLimitHit | null {
  const e = limitEvidence(file, sinceMs, now);
  return e?.kind === 'usage' ? e : null;
}

function projectsRoot(p: Profile) {
  return join(p.dir, 'projects');
}

function realStore(): string | undefined {
  try {
    return realpathSync(storeDir()) + sep;
  } catch {
    return undefined;
  }
}

/**
 * Every copy of every session, grouped by real path so a shared store counts once. Sessions
 * in the shared store belong to no profile in particular and are listed as "shared".
 */
function scan(filter: (slug: string, file: string) => boolean): Map<string, Session> {
  const byId = new Map<string, Session>();
  const seen = new Map<string, Session>();
  const store = realStore();
  for (const p of discoverProfiles()) {
    const root = projectsRoot(p);
    if (!existsSync(root)) continue;
    for (const slug of readdirSync(root)) {
      const dir = join(root, slug);
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const id = f.slice(0, -'.jsonl'.length);
        if (!isUuid(id)) continue;
        const file = join(dir, f);
        if (!filter(slug, file)) continue;
        const real = realpathSync(file);
        const already = seen.get(real);
        if (already) {
          if (!already.profiles.includes(p.name)) already.profiles.push(p.name);
          continue;
        }
        const mtime = statSync(file).mtimeMs;
        const cur = byId.get(id);
        if (!cur) {
          const s: Session = { id, slug, mtime, file, profiles: [p.name] };
          byId.set(id, s);
          seen.set(real, s);
        } else {
          if (!cur.profiles.includes(p.name)) cur.profiles.push(p.name);
          if (mtime > cur.mtime) Object.assign(cur, { mtime, file, slug });
          seen.set(real, cur);
        }
      }
    }
  }
  if (store) {
    for (const s of byId.values())
      if (realpathSync(s.file).startsWith(store)) s.profiles = ['shared'];
  }
  return byId;
}

export function listSessions(opts: { cwd?: string; withTitles?: boolean } = {}): Session[] {
  const slug = opts.cwd ? slugFor(opts.cwd) : undefined;
  const list = [...scan((s) => !slug || s === slug).values()].sort((a, b) => b.mtime - a.mtime);
  if (opts.withTitles) for (const s of list) s.title = sessionTitle(s.file);
  return list;
}

export function findSession(id: string): Session | undefined {
  return scan((_, file) => basename(file) === `${id}.jsonl`).get(id);
}

/**
 * The transcript for `id` as profile `p` sees it. Never guessed from other files: another
 * claude may be writing in the same folder, and its session must not be taken for ours.
 * New ids (--fork-session, /clear) arrive through the SessionStart hook instead.
 */
export function sessionFileIn(
  p: Profile,
  id: string,
  slug: string
): { id: string; file: string } | null {
  const file = join(projectsRoot(p), slug, `${id}.jsonl`);
  return existsSync(file) ? { id, file } : null;
}

/**
 * Make sure profile `p` can resume `s` from `cwd`. With a shared store this is a no-op;
 * otherwise the transcript (and its sidecar folder of subagent/tool output) is copied
 * into `p`'s projects dir under the current directory's slug.
 */
export function ensureSessionIn(p: Profile, s: Session, cwd: string): string {
  const destDir = join(projectsRoot(p), slugFor(cwd));
  const dest = join(destDir, `${s.id}.jsonl`);
  if (existsSync(dest)) {
    if (realpathSync(dest) === realpathSync(s.file)) return dest;
    const src = readFileSync(s.file);
    const have = readFileSync(dest);
    // Transcripts only grow. If ours already holds everything the source has, keep it.
    if (have.length >= src.length && have.subarray(0, src.length).equals(src)) return dest;
    // Two terminals wrote to two copies: keep the one we are about to replace.
    if (!src.subarray(0, have.length).equals(have)) renameSync(dest, `${dest}.bak-${Date.now()}`);
  }
  mkdirSync(destDir, { recursive: true });
  // Fresh timestamps: an old session copied with its old mtime would be fair game for
  // claude's transcript cleanup (cleanupPeriodDays) before it is even resumed.
  const tmp = `${dest}.${process.pid}.tmp`;
  copyFileSync(s.file, tmp);
  renameSync(tmp, dest);
  const sidecar = join(dirname(s.file), s.id);
  if (existsSync(sidecar)) cpSync(sidecar, join(destDir, s.id), { recursive: true });
  return dest;
}
