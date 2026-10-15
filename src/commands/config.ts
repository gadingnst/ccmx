import { configKeys, loadConfig, setConfig } from '@/core/config';
import { CliError } from '@/utils/errors';
import { logger } from '@/utils/logger';
import { formatTable } from '@/utils/table';

export function configCommand(sub: string | undefined, args: string[]) {
  if (sub === 'set') {
    const [key, value] = args;
    if (!key || value === undefined) throw new CliError('usage: ccmx config set <key> <value>');
    try {
      setConfig(key, value);
    } catch (e) {
      throw new CliError((e as Error).message);
    }
    logger.info(`${key} = ${value}`);
  } else if (sub === 'keys') {
    if (args.includes('--json'))
      return console.log(JSON.stringify(Object.fromEntries(configKeys()), null, 2));
    const rows = configKeys().map(([k, v]) => [k, JSON.stringify(v)]);
    console.log(formatTable([['KEY', 'DEFAULT'], ...rows]));
  } else {
    console.log(JSON.stringify(loadConfig(), null, 2));
  }
}
