import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const home = () => process.env.HOME || homedir();

/** ccmx's own state: registry, limits, shared session store, backups. */
export const ccmxDir = () => process.env.CCMX_HOME || join(home(), '.ccmx');

/** Shared `projects/` store that every profile symlinks to after `ccmx migrate`. */
export const storeDir = () => join(ccmxDir(), 'projects');

export const claudeBin = () => process.env.CCMX_CLAUDE || 'claude';

export const CLAUDE_INSTALL_HINT =
  'Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash (or brew install --cask claude-code). More: https://code.claude.com/docs/en/setup';

/** ccmx drives the Claude Code CLI; say so plainly when it is not there. */
export function claudeAvailable(): boolean {
  return Bun.which(claudeBin()) !== null;
}

/** The string hash Claude Code uses for long project folder names (Java's String.hashCode). */
function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

const MAX_SLUG = 200;

/**
 * Claude Code's project folder name for a working directory, the same way claude 2.1.300
 * computes it: the real path in NFC form, every non-alphanumeric character turned into
 * `-`, and names over 200 characters cut and suffixed with a base-36 hash of the path.
 */
export function slugFor(cwd: string): string {
  let path = cwd;
  try {
    path = realpathSync(cwd);
  } catch {}
  path = path.normalize('NFC');
  const slug = path.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= MAX_SLUG) return slug;
  return `${slug.slice(0, MAX_SLUG)}-${Math.abs(stringHash(path)).toString(36)}`;
}
