import { loadConfig } from '@/core/config';
import { ccmxDir, claudeBin } from '@/core/paths';
import { poolFor } from '@/core/projects';
import { listLive } from '@/core/registry';
import { formatTable, profileRows, profileSummaries } from '@/core/report';
import { pickTarget } from '@/core/strategy';
import { ago } from '@/utils/time';
import { VERSION } from '@/version';
import pc from 'picocolors';

function claudeVersion(): string | null {
  try {
    const r = Bun.spawnSync([claudeBin(), '--version']);
    return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
  } catch {
    return null;
  }
}

/** Version, profiles, running sessions and settings in one answer. */
export function statusCommand(flags: string[]) {
  const cfg = loadConfig();
  const next = pickTarget(cfg, { pool: poolFor(process.cwd()), forStart: true })?.name ?? null;
  const running = listLive();
  if (flags.includes('--json')) {
    const iso = (ms: number) => new Date(ms).toISOString();
    return console.log(
      JSON.stringify(
        {
          version: VERSION,
          claude: claudeVersion(),
          home: ccmxDir(),
          nextProfile: next,
          profiles: profileSummaries(),
          running: running.map((s) => ({
            ...s,
            startedAt: iso(s.startedAt),
            updatedAt: iso(s.updatedAt)
          })),
          config: cfg
        },
        null,
        2
      )
    );
  }
  console.log(`ccmx ${VERSION}${pc.dim(` · claude ${claudeVersion() ?? 'not found'}`)}`);
  console.log(
    `next launch here: ${next ? pc.bold(next) : pc.yellow('none has room')} ${pc.dim(`(${cfg.strategy.kind}; switch on limit ${cfg.auto_switch_on_rate_limit ? 'on' : 'off'}; thresholds 5h ${cfg.thresholds.five_hour}% · 7d ${cfg.thresholds.seven_day}%)`)}`
  );
  console.log(`\n${formatTable(profileRows(cfg))}`);
  if (running.length) {
    console.log('\nRunning');
    for (const s of running) {
      console.log(
        `  [${s.pid}] ${s.profile} · ${s.state}${s.detail ? ` (${s.detail})` : ''} · ${s.cwd} · since ${ago(s.startedAt)}`
      );
    }
  }
}
