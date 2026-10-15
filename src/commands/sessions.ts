import { listLive, listRecent } from '@/core/registry';
import { findSession, listSessions, sessionCwd, sessionTitle } from '@/core/sessions';
import { formatTable } from '@/utils/table';
import { ago } from '@/utils/time';
import pc from 'picocolors';

const titleOf = (id?: string) => {
  const s = id ? findSession(id) : undefined;
  return (s && sessionTitle(s.file)) ?? '';
};

const iso = (ms: number) => new Date(ms).toISOString();

/** Transcripts on disk, for this folder or all of them. */
function transcripts(all: boolean, json: boolean) {
  const list = listSessions({ cwd: all ? undefined : process.cwd() }).slice(0, 50);
  for (const s of list) s.title = sessionTitle(s.file);
  if (json) {
    const out = list.map((s) => ({
      id: s.id,
      title: s.title ?? null,
      cwd: sessionCwd(s.file) ?? null,
      profiles: s.profiles,
      updatedAt: iso(s.mtime),
      resume: `ccmx --resume ${s.id}`
    }));
    return console.log(JSON.stringify(out, null, 2));
  }
  const rows = [['UPDATED', 'PROFILES', 'ID', 'TITLE']];
  for (const s of list) {
    const where = all ? pc.dim(`${s.slug} `) : '';
    rows.push([ago(s.mtime), s.profiles.join(','), s.id.slice(0, 8), where + (s.title ?? '')]);
  }
  console.log(rows.length === 1 ? pc.dim('no sessions') : formatTable(rows));
}

export function sessionsCommand(flags: string[]) {
  const json = flags.includes('--json');
  if (flags.includes('--here') || flags.includes('--all'))
    return transcripts(flags.includes('--all'), json);

  const running = listLive();
  const recent = listRecent().slice(0, 10);
  if (json) {
    const out = {
      running: running.map((s) => ({
        ...s,
        title: titleOf(s.sessionId) || null,
        startedAt: iso(s.startedAt),
        updatedAt: iso(s.updatedAt)
      })),
      recent: recent.map((r) => ({
        ...r,
        title: titleOf(r.sessionId) || null,
        endedAt: iso(r.endedAt),
        resume: `ccmx --resume ${r.sessionId}`
      }))
    };
    return console.log(JSON.stringify(out, null, 2));
  }

  if (!running.length) console.log(pc.dim('no running ccmx sessions'));
  for (const s of running) {
    const state = `${s.state}${s.detail ? ` (${s.detail})` : ''}`;
    console.log(`[${s.pid}] ${titleOf(s.sessionId).slice(0, 60) || s.cwd}`);
    console.log(`    ${s.cwd}`);
    console.log(`    ${s.profile} · session ${s.sessionId?.slice(0, 8) ?? '?'} · ${state}`);
    console.log(`    up ${ago(s.startedAt).replace(' ago', '')}, last change ${ago(s.updatedAt)}`);
  }
  if (!recent.length) return;
  console.log('\nRecently ended:');
  for (const r of recent) {
    console.log(`  ${titleOf(r.sessionId).slice(0, 60) || r.cwd}`);
    console.log(`    ${r.cwd} · ${r.profile} · ended ${ago(r.endedAt)}`);
    console.log(`    ccmx --resume ${r.sessionId}`);
  }
}
