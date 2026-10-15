import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { account, discoverProfiles, findProfile } from '@/core/profiles';
import { CliError } from '@/utils/errors';
import { logger } from '@/utils/logger';
// Bundled as text so the guide ships inside dist/cli.js and compiled binaries.
import guide from '../../skills/ccmx/SKILL.md' with { type: 'text' };

export const SKILL_TEXT = guide;

/**
 * `ccmx skill` prints the agent guide. `ccmx skill install` copies it into the skills/
 * folder of every logged-in profile (or one with --as), so Claude Code in any of them
 * knows how to drive ccmx.
 */
export function skillCommand(args: string[]) {
  if (args.at(0) !== 'install') return void process.stdout.write(guide);
  const i = args.indexOf('--as');
  const only = i >= 0 ? args.at(i + 1) : undefined;
  if (i >= 0 && !only) throw new CliError('--as needs a profile name', 2);
  const targets = only ? [findProfile(only)] : discoverProfiles().filter((p) => account(p));
  if (only && !targets[0]) throw new CliError(`no profile "${only}"`, 2);
  for (const p of targets) {
    const dir = join(p!.dir, 'skills', 'ccmx');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), guide);
    logger.info(`installed for ${p!.name}: ${join(dir, 'SKILL.md')}`);
  }
}
