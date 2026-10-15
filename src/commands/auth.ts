import { mkdirSync } from 'node:fs';
import { CLAUDE_INSTALL_HINT, claudeAvailable, claudeBin } from '@/core/paths';
import { account, findProfile, profileEnv, profileFor } from '@/core/profiles';
import { CliError } from '@/utils/errors';
import { logger } from '@/utils/logger';

async function runAuth(name: string, verb: 'login' | 'logout') {
  if (!claudeAvailable()) {
    throw new CliError(`Claude Code CLI not found (\`${claudeBin()}\`). ${CLAUDE_INSTALL_HINT}`);
  }
  const p = profileFor(name);
  mkdirSync(p.dir, { recursive: true });
  const proc = Bun.spawn([claudeBin(), 'auth', verb], {
    env: profileEnv(p),
    stdio: ['inherit', 'inherit', 'inherit']
  });
  return proc.exited;
}

export async function loginCommand(name: string): Promise<number> {
  const code = await runAuth(name, 'login');
  if (code === 0) {
    const a = account(profileFor(name));
    logger.info(a?.email ? `${name} logged in as ${a.email}` : `${name} login finished`);
  }
  return code;
}

export function logoutCommand(name: string): Promise<number> {
  if (!findProfile(name)) throw new CliError(`no profile "${name}"`);
  return runAuth(name, 'logout');
}
