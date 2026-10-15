import { loadConfig } from '@/core/config';
import { formatTable, profileRows, profileSummaries } from '@/core/report';

export function listCommand(flags: string[]) {
  if (flags.includes('--json')) return console.log(JSON.stringify(profileSummaries(), null, 2));
  console.log(formatTable(profileRows(loadConfig())));
}
