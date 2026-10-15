import { runHook } from '@/core/hooks';
import { runStatusline } from '@/core/statusline';

/** Internal: entry points claude calls through the launch settings. */
export function hookCommand(sub: string | undefined): Promise<number> {
  return runHook(sub ?? '');
}

export function statuslineCommand(): Promise<number> {
  return runStatusline();
}
