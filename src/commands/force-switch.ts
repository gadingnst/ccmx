import { findProfile } from '@/core/profiles';
import { listLive } from '@/core/registry';
import { sendSignal } from '@/core/signals';
import { CliError } from '@/utils/errors';
import { logger } from '@/utils/logger';

/** Move a running session from another terminal, e.g. one stuck at a limit. */
export function forceSwitchCommand(args: string[]) {
  const pidIx = args.indexOf('--pid');
  const pid = pidIx >= 0 ? Number(args.at(pidIx + 1)) : undefined;
  const target = args.find((a, i) => !a.startsWith('-') && (pidIx < 0 || i !== pidIx + 1));
  const running = listLive();
  const s = pid ? running.find((r) => r.pid === pid) : running.at(0);
  if (!s)
    throw new CliError(pid ? `no running ccmx session with pid ${pid}` : 'no running ccmx session');
  if (!pid && running.length > 1) {
    logger.info(
      `${running.length} sessions running; moving the most recently active (pid ${s.pid}). Use --pid to pick.`
    );
  }
  if (target && !findProfile(target)) throw new CliError(`no profile "${target}"`);
  sendSignal(s.pid, 'switch-requested', { target, trigger: 'manual' });
  logger.info(`asked pid ${s.pid} to switch${target ? ` to ${target}` : ''}`);
}
