import { type MigrateReport, claudeRunning, migrate, preflight } from '@/core/migrate';
import { CliError } from '@/utils/errors';
import { logger } from '@/utils/logger';

function print(reports: MigrateReport[], backup: string | undefined, dryRun: boolean) {
  for (const r of reports) {
    const verb = dryRun && r.action === 'linked' ? 'would link' : r.action;
    const counts = `+${r.copied} new, ${r.replaced} replaced, ${r.kept} kept`;
    logger.info(
      `${r.profile.padEnd(12)} ${verb.padEnd(15)} ${counts}${r.note ? ` · ${r.note}` : ''}`
    );
    for (const c of r.conflicts.slice(0, 5)) logger.warn(`  conflict: ${c} (newer copy wins)`);
    if (r.conflicts.length > 5) logger.warn(`  …and ${r.conflicts.length - 5} more conflicts`);
    for (const m of r.merged) logger.info(`  memory merged: ${m}`);
  }
  if (backup) logger.info(`originals backed up to ${backup}`);
}

/**
 * Share one projects/ store between every profile so any of them can resume any session.
 * Without --yes it only shows the plan.
 */
export function migrateCommand(flags: string[]) {
  const apply = flags.includes('--yes');
  const force = flags.includes('--force');
  const issues = preflight();
  for (const i of issues) logger.warn(i);
  if (apply && issues.length && !force) {
    throw new CliError('not migrating; fix the above, or pass --force to merge anyway.');
  }
  if (apply && claudeRunning() && !force) {
    throw new CliError(
      'claude is running. Quit every Claude Code session first (or pass --force).'
    );
  }
  const res = migrate({ dryRun: !apply });
  print(res.reports, res.backup, !apply);
  if (!apply) logger.info('nothing changed. Run `ccmx migrate --yes` to apply.');
}
