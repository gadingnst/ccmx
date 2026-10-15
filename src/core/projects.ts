import { realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ccmxDir } from '@/core/paths';
import { readJson, writeJson } from '@/core/runtime';

/** A folder whose sessions may only use some profiles (say, the work account for work repos). */
export type Project = { name: string; dir: string; profiles: string[] };

const file = () => join(ccmxDir(), 'projects.json');

export function loadProjects(): Project[] {
  return readJson<Project[]>(file()) ?? [];
}

function save(list: Project[]) {
  writeJson(file(), list, 0o644);
}

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Physical path, so a symlinked --dir still matches the folder the shell reports. */
function real(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

const within = (cwd: string, dir: string) =>
  cwd === dir || cwd.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The project with the longest folder containing `cwd`. */
export function projectFor(cwd: string): Project | undefined {
  const here = real(cwd);
  return loadProjects()
    .filter((p) => within(here, real(p.dir)))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

/** Profiles allowed in `cwd`, or undefined for all of them. */
export function poolFor(cwd: string): string[] | undefined {
  const p = projectFor(cwd);
  return p?.profiles.length ? p.profiles : undefined;
}

export function createProject(name: string, dir: string) {
  if (!NAME_RE.test(name))
    throw new Error('project names are lowercase letters, digits and -, up to 32');
  const list = loadProjects();
  if (list.some((p) => p.name === name)) throw new Error(`project "${name}" exists`);
  list.push({ name, dir: real(dir), profiles: [] });
  save(list);
}

export function assignProfiles(name: string, profiles: string[], add: boolean) {
  const list = loadProjects();
  const p = list.find((x) => x.name === name);
  if (!p) throw new Error(`no project "${name}"`);
  p.profiles = add
    ? [...new Set([...p.profiles, ...profiles])]
    : p.profiles.filter((x) => !profiles.includes(x));
  save(list);
}

export function removeProject(name: string) {
  const list = loadProjects();
  if (!list.some((p) => p.name === name)) throw new Error(`no project "${name}"`);
  save(list.filter((p) => p.name !== name));
}
