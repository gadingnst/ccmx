import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { ccmxDir, storeDir } from '@/core/paths';
import { type Profile, discoverProfiles, storeMode } from '@/core/profiles';

export type MigrateReport = {
  profile: string;
  action: 'linked' | 'already-shared' | 'skipped';
  copied: number;
  replaced: number;
  kept: number;
  /** Files both sides changed differently; the newer one won, the other is in the backup. */
  conflicts: string[];
  /** Memory files combined instead of overwritten. */
  merged: string[];
  note?: string;
};

/** Days claude keeps transcripts before its background cleanup deletes them. */
export function cleanupDays(p: Profile): number {
  try {
    const s = JSON.parse(readFileSync(join(p.dir, 'settings.json'), 'utf8'));
    return typeof s.cleanupPeriodDays === 'number' ? s.cleanupPeriodDays : 30;
  } catch {
    return 30;
  }
}

function* walk(root: string): Generator<{ path: string; link: boolean }> {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, e.name);
    if (e.isSymbolicLink()) yield { path: full, link: true };
    else if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield { path: full, link: false };
  }
}

/**
 * Reasons not to merge. Every profile's claude cleans the shared store by its own
 * cleanupPeriodDays, so the shortest would delete the others' older sessions; symlinks
 * inside projects/ would not survive the move.
 */
export function preflight(): string[] {
  const issues: string[] = [];
  const profiles = discoverProfiles().filter((p) => storeMode(p) === 'separate');
  const days = new Map(discoverProfiles().map((p) => [p.name, cleanupDays(p)]));
  if (new Set(days.values()).size > 1) {
    const list = [...days].map(([n, d]) => `${n}=${d}`).join(', ');
    issues.push(
      `profiles keep transcripts for different times (cleanupPeriodDays: ${list}). In one shared store the shortest would delete the others' older sessions. Set the same cleanupPeriodDays in every profile's settings.json first.`
    );
  }
  for (const p of profiles) {
    for (const f of walk(join(p.dir, 'projects'))) {
      if (f.link) issues.push(`${f.path} is a symlink; move or remove it before migrating.`);
    }
  }
  return issues;
}

type Planned = Map<string, { size: number; mtimeMs: number; from: string }>;

/** How two versions of a file relate. Transcripts only grow, so a prefix is an older copy. */
function relation(a: Buffer, b: Buffer): 'same' | 'a-older' | 'b-older' | 'diverged' {
  if (a.equals(b)) return 'same';
  if (a.length < b.length && b.subarray(0, a.length).equals(a)) return 'a-older';
  if (b.length < a.length && a.subarray(0, b.length).equals(b)) return 'b-older';
  return 'diverged';
}

/** Copy through a temp file and rename, so an interrupted run never leaves half a file. */
function place(src: string, dest: string) {
  const s = statSync(src);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  copyFileSync(src, tmp);
  utimesSync(tmp, s.atime, s.mtime);
  renameSync(tmp, dest);
}

type MergeCtx = { store: string; dryRun: boolean; planned: Planned; storeBackup: string };

/** `planned` stands in for the store during a dry run, so profiles are compared with each other. */
function merge(src: string, r: MigrateReport, m: MergeCtx) {
  for (const { path: file, link } of walk(src)) {
    if (link) continue;
    const rel = relative(src, file);
    const dest = join(m.store, rel);
    const s = statSync(file);
    const known = m.planned.get(rel);
    const existing = known?.from ?? (existsSync(dest) ? dest : undefined);
    const take = () => {
      m.planned.set(rel, { size: s.size, mtimeMs: s.mtimeMs, from: file });
      if (m.dryRun) return;
      // Keep what the store held before overwriting it.
      if (existsSync(dest)) place(dest, join(m.storeBackup, rel));
      place(file, dest);
    };
    if (!existing) {
      r.copied++;
      take();
      continue;
    }
    const mine = readFileSync(file);
    const theirs = readFileSync(existing);
    const rel_ = relation(theirs, mine);
    if (rel_ === 'same') continue;
    if (basename(rel) === 'MEMORY.md') {
      // Each profile's memory index lists its own memories; union the lines so none is orphaned.
      r.merged.push(rel);
      if (!m.dryRun) {
        const have = readFileSync(dest, 'utf8');
        const seen = new Set(have.split('\n').map((l) => l.trim()));
        const extra = mine
          .toString('utf8')
          .split('\n')
          .filter((l) => l.trim() && !seen.has(l.trim()));
        if (extra.length) writeFileSync(dest, `${have.replace(/\n*$/, '\n')}${extra.join('\n')}\n`);
      }
      continue;
    }
    if (rel.split(sep).includes('memory')) {
      // Two profiles wrote different memories under one name: keep both for review.
      const alt = `${rel.replace(/\.md$/, '')}.from-${r.profile}.md`;
      r.merged.push(`${rel} (also kept as ${basename(alt)})`);
      if (!m.dryRun) place(file, join(m.store, alt));
      continue;
    }
    // One copy extends the other: the longer one is the same session with more turns.
    if (rel_ === 'a-older') {
      r.replaced++;
      take();
      continue;
    }
    if (rel_ === 'b-older') {
      r.kept++;
      continue;
    }
    r.conflicts.push(rel);
    const theirMtime = known?.mtimeMs ?? statSync(existing).mtimeMs;
    if (s.mtimeMs > theirMtime) {
      r.replaced++;
      take();
    } else r.kept++;
  }
}

export function claudeRunning(): boolean {
  const r = Bun.spawnSync(['pgrep', '-x', 'claude']);
  return r.exitCode === 0;
}

/**
 * Point every profile's `projects/` at one shared store so any profile can resume any
 * session. Each original folder is copied to a timestamped backup first, and any store
 * file that gets replaced is backed up too.
 */
export function migrate(opts: { dryRun?: boolean } = {}): {
  reports: MigrateReport[];
  backup?: string;
} {
  const dryRun = !!opts.dryRun;
  const store = storeDir();
  const backup = join(ccmxDir(), 'backup', new Date().toISOString().replace(/[:.]/g, '-'));
  const reports: MigrateReport[] = [];
  const m: MergeCtx = { store, dryRun, planned: new Map(), storeBackup: join(backup, '_store') };
  if (!dryRun) mkdirSync(store, { recursive: true });

  for (const p of discoverProfiles()) {
    const r: MigrateReport = {
      profile: p.name,
      action: 'skipped',
      copied: 0,
      replaced: 0,
      kept: 0,
      conflicts: [],
      merged: []
    };
    reports.push(r);
    const projects = join(p.dir, 'projects');
    const mode = storeMode(p);
    if (mode === 'shared') {
      r.action = 'already-shared';
      continue;
    }
    if (mode === 'other-link') {
      r.note = 'projects/ is a symlink to somewhere else; left alone';
      continue;
    }
    if (mode === 'separate') {
      // Back up before touching anything, so every original survives a crash mid-merge.
      if (!dryRun)
        cpSync(projects, join(backup, p.name), { recursive: true, preserveTimestamps: true });
      merge(projects, r, m);
      if (!dryRun) rmSync(projects, { recursive: true, force: true });
    }
    if (!dryRun) {
      // lstat guards against a race where something recreated the folder meanwhile.
      if (existsSync(projects) && !lstatSync(projects).isSymbolicLink())
        throw new Error(`${projects} reappeared; aborting.`);
      symlinkSync(store, projects);
    }
    r.action = 'linked';
  }
  return { reports, backup: dryRun ? undefined : backup };
}
