import { clearHistory, readHistory } from '@/core/history';
import { historyLines } from '@/core/report';
import pc from 'picocolors';

export function historyCommand(flags: string[]) {
  if (flags.includes('--clear')) return clearHistory();
  const i = flags.indexOf('-n');
  const n = i >= 0 ? Number(flags.at(i + 1)) || 20 : 20;
  if (flags.includes('--json')) console.log(JSON.stringify(readHistory().slice(0, n), null, 2));
  else console.log(historyLines(n).join('\n') || pc.dim('no switches yet'));
}
