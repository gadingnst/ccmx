import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CLI = join(import.meta.dir, '..', '..', 'src', 'cli.ts');
const FAKE = join(import.meta.dir, 'fake-claude.ts');

export type Call = { dir: string; args: string[]; cwd: string };

/**
 * A throwaway HOME with three logged-in profiles (claude, alice, bob), a fake claude,
 * and fast timers. Nothing touches the real ~/.claude*.
 */
export class Sandbox {
  readonly home = realpathSync(mkdtempSync(join(tmpdir(), 'ccmx-')));
  readonly work = join(this.home, 'work', 'my.app');
  readonly log = join(this.home, 'calls.log');

  constructor() {
    mkdirSync(this.work, { recursive: true });
    chmodSync(FAKE, 0o755);
    this.account('claude', 'main@example.com');
    this.account('alice', 'alice@example.com');
    this.account('bob', 'bob@example.com');
    mkdirSync(join(this.home, '.claude-empty')); // not a profile: no state file, no projects
    this.config({ wait_for_reset: false });
  }

  account(name: string, email: string) {
    const dir = join(this.home, name === 'claude' ? '.claude' : `.claude-${name}`);
    mkdirSync(dir, { recursive: true });
    const state = name === 'claude' ? join(this.home, '.claude.json') : join(dir, '.claude.json');
    writeFileSync(state, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  }

  config(c: object) {
    mkdirSync(join(this.home, '.ccmx'), { recursive: true });
    writeFileSync(join(this.home, '.ccmx', 'config.json'), JSON.stringify(c));
  }

  /** Percent used per window, as the statusline shim would record it. */
  usage(profile: string, five: number, seven = 0) {
    const dir = join(this.home, '.ccmx', 'runtime', 'usage');
    mkdirSync(dir, { recursive: true });
    const resets = Date.now() + 3600_000;
    writeFileSync(
      join(dir, `${profile}.json`),
      JSON.stringify({
        polled_at: Date.now(),
        five_hour: { used: five, resets_at: resets },
        seven_day: { used: seven, resets_at: resets }
      })
    );
  }

  env(extra: Record<string, string> = {}) {
    // Never inherit the developer's CCMX_* (a real CCMX_HOME would let migrate tests touch
    // their actual store) or an outer ccmx wrapper's variables.
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('CCMX_'))
    );
    return {
      ...base,
      HOME: this.home,
      CCMX_HOME: join(this.home, '.ccmx'),
      CCMX_CLAUDE: FAKE,
      CCMX_TIME_SCALE: '0.001',
      // Tests launch "interactive" claude without a terminal; the fake does not need one.
      CCMX_NO_TTY_OK: '1',
      FAKE_LOG: this.log,
      FAKE_HOLD_MS: '3000',
      CLAUDE_CONFIG_DIR: '',
      NO_COLOR: '1',
      ...extra
    };
  }

  run(args: string[], extra: Record<string, string> = {}, cwd = this.work) {
    const r = Bun.spawnSync(['bun', CLI, ...args], {
      cwd,
      env: this.env(extra),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  lines(): any[] {
    if (!existsSync(this.log)) return [];
    return readFileSync(this.log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  }

  calls(): Call[] {
    return this.lines().filter((l) => l.dir);
  }

  slug(cwd = this.work) {
    return cwd.replace(/[^a-zA-Z0-9]/g, '-');
  }

  cleanup() {
    rmSync(this.home, { recursive: true, force: true });
  }
}
