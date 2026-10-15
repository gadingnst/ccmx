import { CliError } from '@/utils/errors';
import { VERSION } from '@/version';

export type CommandSpec = {
  /** What follows `ccmx`; empty for a plain launch. */
  name: string;
  group: 'Run' | 'Profiles' | 'Sessions' | 'Setup' | 'Help';
  usage: string;
  summary: string;
  options?: { flag: string; description: string }[];
  /** Prints JSON with --json (or always, for `config show`). */
  json?: boolean;
  /** Needs a person at a terminal; agents should not run it. */
  interactive?: boolean;
  /** Changes files or accounts; agents should ask the user first. */
  mutates?: boolean;
  examples?: string[];
};

/**
 * Every ccmx command, described once. `ccmx --help`, `ccmx help <command>` and
 * `ccmx help --json` (for agents) are all rendered from this list.
 */
export const COMMAND_SPECS: CommandSpec[] = [
  {
    name: '',
    group: 'Run',
    usage: 'ccmx [--as <profile>] [claude args…]',
    summary:
      'Start Claude Code on the profile with the most headroom. When that profile hits its usage limit, ccmx restarts claude on another profile, resumes the same session and sends "Go continue.".',
    interactive: true,
    options: [
      { flag: '--as <profile>', description: 'use this profile; ccmx will still move on a limit' },
      {
        flag: '-r, --resume [id|prefix|term]',
        description: 'resume a session from any profile; no value opens a picker'
      },
      {
        flag: '-c, --continue',
        description: "continue this folder's latest session, whichever profile ran it"
      },
      { flag: '--session-id <uuid>', description: 'id for a new session' }
    ],
    examples: ['ccmx', 'ccmx --as work', 'ccmx -r a1b2c3d4', 'ccmx -c --model opus']
  },
  {
    name: '-p',
    group: 'Run',
    usage:
      'ccmx -p "<prompt>" [--output-format text|json|stream-json] [--as <profile>] [-r <id>|-c]',
    summary:
      'Headless run for scripts and agents: one turn, result on stdout. Picks the profile with the most headroom. With text or json output, a usage limit is handed to the next profile and the turn finishes there; stream-json is passed through live and not handed off.',
    options: [
      { flag: '--as <profile>', description: 'pin the profile; no hand-off on a limit' },
      { flag: '-r <id>, -c', description: 'continue an earlier session, from any profile' }
    ],
    examples: [
      'ccmx -p "summarise README.md" --output-format json',
      'ccmx -r a1b2c3d4 -p "now write the tests" --output-format json'
    ]
  },
  {
    name: 'force-switch',
    group: 'Run',
    usage: 'ccmx force-switch [profile] [--pid <n>]',
    summary: 'Move a running ccmx session to another profile from a different terminal.',
    mutates: true
  },
  {
    name: 'status',
    group: 'Profiles',
    usage: 'ccmx status [--json]',
    summary:
      'Everything at a glance: version, profiles with usage and limits, running sessions, settings.',
    json: true
  },
  {
    name: 'list',
    group: 'Profiles',
    usage: 'ccmx list [--json]',
    summary:
      'Profiles with account, status (ready, limited, full), 5-hour and 7-day usage, last use.',
    json: true
  },
  {
    name: 'login',
    group: 'Profiles',
    usage: 'ccmx login <profile>',
    summary:
      'Log a profile in through the browser. "claude" means ~/.claude; any other name ~/.claude-<name>.',
    interactive: true,
    mutates: true
  },
  {
    name: 'logout',
    group: 'Profiles',
    usage: 'ccmx logout <profile>',
    summary: 'Log a profile out. Its folder and sessions stay.',
    mutates: true
  },
  {
    name: 'clear',
    group: 'Profiles',
    usage: 'ccmx clear <profile>',
    summary: 'Forget the usage limit ccmx recorded for a profile.',
    mutates: true
  },
  {
    name: 'sessions',
    group: 'Sessions',
    usage: 'ccmx sessions [--here | --all] [--json]',
    summary:
      'Running ccmx sessions and recently ended ones, with the command to resume each. --here lists the transcripts for this folder, --all for every folder.',
    json: true
  },
  {
    name: 'history',
    group: 'Sessions',
    usage: 'ccmx history [-n <count>] [--json] [--clear]',
    summary: 'Recent profile switches: when, from, to, why, usage on both sides.',
    json: true
  },
  {
    name: 'config',
    group: 'Setup',
    usage: 'ccmx config [show | keys [--json] | set <key> <value>]',
    summary:
      'Show settings (JSON), list every key with its default, or change one (thresholds, strategy, auto_message, …).',
    json: true,
    examples: ['ccmx config set thresholds.five_hour 85', 'ccmx config set strategy.kind drain']
  },
  {
    name: 'project',
    group: 'Setup',
    usage:
      'ccmx project [list [--json] | create <name> [--dir <d>] | assign|unassign <name> <profiles…> | remove <name>]',
    summary: 'Folder pools: sessions under a project folder only use the profiles assigned to it.',
    json: true
  },
  {
    name: 'migrate',
    group: 'Setup',
    usage: 'ccmx migrate [--yes] [--force]',
    summary:
      "Plan (default) or, with --yes, merge every profile's projects/ into one shared store (~/.ccmx/projects) and link each profile to it. Backs up first. Refuses if profiles have different cleanupPeriodDays or claude is running, unless --force.",
    mutates: true
  },
  {
    name: 'skill',
    group: 'Setup',
    usage: 'ccmx skill [install [--as <profile>]]',
    summary:
      "Print the agent guide for ccmx, or install it as a Claude Code skill into every logged-in profile's skills/ folder (or one with --as).",
    mutates: true
  },
  {
    name: 'help',
    group: 'Help',
    usage: 'ccmx help [<command>] [--json]',
    summary: 'This help. --json describes every command for agents.',
    json: true
  },
  {
    name: 'version',
    group: 'Help',
    usage: 'ccmx version',
    summary: 'ccmx version and the claude version it drives.'
  }
];

export const EXIT_CODES: Record<string, string> = {
  '0': 'success',
  '1': 'error (message on stderr)',
  '2': 'usage error (unknown profile, missing argument)',
  '130': 'cancelled (picker closed, or waiting for a reset interrupted)',
  other: "a launch exits with claude's own exit code"
};

const ENV = [
  {
    name: 'CCMX_HOME',
    description: 'state, usage, history and the shared store (default ~/.ccmx)'
  },
  { name: 'CCMX_CLAUDE', description: 'the claude binary to run (default: claude on PATH)' }
];

const SPLIT = 30;
const WIDTH = 90;

/** Break prose into lines of at most WIDTH columns, each starting with `indent`. */
function wrap(text: string, indent: string): string[] {
  const lines: string[] = [];
  let line = indent;
  for (const word of text.split(' ')) {
    if (line.length + word.length + 1 > WIDTH && line.trim()) {
      lines.push(line.trimEnd());
      line = indent;
    }
    line += `${word} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

function render(spec: CommandSpec): string {
  const lines = [`  ${spec.usage}`, ...wrap(spec.summary, '      ')];
  for (const o of spec.options ?? []) lines.push(`      ${o.flag.padEnd(SPLIT)} ${o.description}`);
  return lines.join('\n');
}

export function helpText(): string {
  const out = [
    `ccmx ${VERSION}: Claude Code multiplexer, several Claude Code profiles behind one command`,
    '',
    "Arguments that are not a ccmx command go to claude unchanged. Claude Code's own",
    'subcommands (mcp, plugin, doctor, …) run on the default profile unless --as is given.',
    'Profiles are ~/.claude ("claude") and ~/.claude-<name>.'
  ];
  for (const group of ['Run', 'Profiles', 'Sessions', 'Setup', 'Help'] as const) {
    out.push('', group);
    for (const spec of COMMAND_SPECS.filter((s) => s.group === group)) out.push(render(spec));
  }
  out.push(
    '',
    'Inside a ccmx session: /ccmx:switch [profile], /ccmx:list, /ccmx:status, /ccmx:history',
    'For agents: ccmx help --json, ccmx status --json, ccmx skill'
  );
  return out.join('\n');
}

function commandHelp(name: string): string {
  const spec = COMMAND_SPECS.find((s) => s.name === name);
  if (!spec) throw new CliError(`no command "${name}". See: ccmx help`, 2);
  const out = [render(spec)];
  if (spec.examples?.length) out.push('', '  Examples', ...spec.examples.map((e) => `    ${e}`));
  return out.join('\n');
}

export function manifest() {
  return {
    name: 'ccmx',
    version: VERSION,
    description:
      'Claude Code multiplexer: runs Claude Code across several profiles (accounts), shares their sessions, and moves a session to another profile when one hits its usage limit.',
    usage: 'ccmx <command> [options] | ccmx [claude args…]',
    passthrough:
      "Arguments that are not a ccmx command go to claude unchanged. Claude Code's subcommands run on the default profile unless --as is given; -p runs on the profile with the most headroom.",
    agentNotes: [
      'Use `ccmx -p "<prompt>" --output-format json` for work; interactive `ccmx` needs a terminal and is refused without one.',
      'Read state with `ccmx status --json`; every listing takes --json.',
      'Commands marked mutates change accounts or files: ask the user before running them.',
      'The full guide is printed by `ccmx skill`.'
    ],
    commands: COMMAND_SPECS.map((s) => ({
      command: s.name ? `ccmx ${s.name}` : 'ccmx',
      ...s,
      json: !!s.json,
      interactive: !!s.interactive,
      mutates: !!s.mutates
    })),
    slashCommands: [
      '/ccmx:switch [profile]',
      '/ccmx:list',
      '/ccmx:status',
      '/ccmx:history',
      '/ccmx:help'
    ],
    exitCodes: EXIT_CODES,
    env: ENV
  };
}

export function helpCommand(args: string[]) {
  if (args.includes('--json')) return console.log(JSON.stringify(manifest(), null, 2));
  const name = args.find((a) => a !== '--json');
  console.log(name ? commandHelp(name) : helpText());
}
