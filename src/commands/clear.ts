import { findProfile } from '@/core/profiles';
import { updateProfile } from '@/core/state';
import { CliError } from '@/utils/errors';

/** Forget a recorded limit, e.g. after upgrading a plan. */
export function clearCommand(name: string) {
  if (!findProfile(name)) throw new CliError(`no profile "${name}"`);
  updateProfile(name, { limitedUntil: 0, limitType: undefined });
}
