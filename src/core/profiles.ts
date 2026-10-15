import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { home, storeDir } from '@/core/paths';

export type Profile = { name: string; dir: string; isDefault: boolean };

export type Account = { email?: string; org?: string };

export const DEFAULT_PROFILE = 'claude';

const BACKUP_NAME = /(^|[-_.])(bak|backup|old|orig|copy|tmp)\d*$/i;

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export function validName(name: string) {
  return NAME_RE.test(name);
}

export function profileFor(name: string): Profile {
  const isDefault = name === DEFAULT_PROFILE;
  return { name, isDefault, dir: join(home(), isDefault ? '.claude' : `.claude-${name}`) };
}

/** `~/.claude` and every `~/.claude-<name>` directory that looks like a Claude Code config dir. */
export function discoverProfiles(): Profile[] {
  const out: Profile[] = [];
  for (const entry of readdirSync(home())) {
    if (entry !== '.claude' && !entry.startsWith('.claude-')) continue;
    const name = entry === '.claude' ? DEFAULT_PROFILE : entry.slice('.claude-'.length);
    if (!validName(name)) continue;
    // `cp -R ~/.claude ~/.claude-bak` and the like are copies, not accounts to manage.
    if (BACKUP_NAME.test(name)) continue;
    const p = profileFor(name);
    try {
      if (!statSync(p.dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(configFile(p)) && !existsSync(join(p.dir, 'projects'))) continue;
    out.push(p);
  }
  return out.sort((a, b) => (a.isDefault ? -1 : b.isDefault ? 1 : a.name.localeCompare(b.name)));
}

export function findProfile(name: string): Profile | undefined {
  return discoverProfiles().find((p) => p.name === name);
}

/** The default profile keeps its state in `~/.claude.json`, others inside their own dir. */
export function configFile(p: Profile) {
  return p.isDefault ? join(home(), '.claude.json') : join(p.dir, '.claude.json');
}

/** Account metadata Claude Code caches after login. Never touches credentials. */
export function account(p: Profile): Account | null {
  try {
    const a = JSON.parse(readFileSync(configFile(p), 'utf8')).oauthAccount;
    if (!a) return null;
    return { email: a.emailAddress, org: a.organizationName };
  } catch {
    return null;
  }
}

export function profileEnv(p: Profile): Record<string, string | undefined> {
  // Setting CLAUDE_CONFIG_DIR even to ~/.claude moves the state file and keychain entry,
  // so the default profile must run with it unset.
  // CCMX_* belong to the wrapper that launched *this* process (an agent may run ccmx from
  // inside a ccmx session); the child gets fresh ones from its own wrapper, or none.
  const {
    CLAUDE_CONFIG_DIR: _,
    CCMX_WRAPPED,
    CCMX_WRAPPER_PID,
    CCMX_PROFILE,
    ...env
  } = process.env;
  return p.isDefault ? env : { ...env, CLAUDE_CONFIG_DIR: p.dir };
}

export type StoreMode = 'shared' | 'separate' | 'other-link' | 'none';

export function storeMode(p: Profile): StoreMode {
  const dir = join(p.dir, 'projects');
  try {
    const st = lstatSync(dir);
    if (!st.isSymbolicLink()) return 'separate';
    return resolve(p.dir, readlinkSync(dir)) === resolve(storeDir()) ? 'shared' : 'other-link';
  } catch {
    return 'none';
  }
}
