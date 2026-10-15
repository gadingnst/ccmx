import { findProfile } from '@/core/profiles';
import { assignProfiles, createProject, loadProjects, removeProject } from '@/core/projects';
import { CliError } from '@/utils/errors';
import { formatTable } from '@/utils/table';
import pc from 'picocolors';

/** Per-folder profile pools: sessions under a project's folder only use its profiles. */
export function projectCommand(sub: string | undefined, args: string[]) {
  const [name, ...rest] = args;
  try {
    if (sub === 'create') {
      const d = rest.indexOf('--dir');
      return createProject(name ?? '', d >= 0 ? (rest.at(d + 1) ?? process.cwd()) : process.cwd());
    }
    if (sub === 'assign' || sub === 'unassign') {
      if (!name || !rest.length) throw new Error(`usage: ccmx project ${sub} <name> <profiles..>`);
      for (const p of rest) if (!findProfile(p)) throw new Error(`no profile "${p}"`);
      return assignProfiles(name, rest, sub === 'assign');
    }
    if (sub === 'remove') return removeProject(name ?? '');
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  const list = loadProjects();
  if (args.includes('--json') || sub === '--json')
    return console.log(JSON.stringify(list, null, 2));
  if (!list.length) return console.log(pc.dim('no projects'));
  const rows = list.map((p) => [p.name, p.dir, p.profiles.join(',') || '(all)']);
  console.log(formatTable([['PROJECT', 'DIR', 'PROFILES'], ...rows]));
}
