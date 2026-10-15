# ccmx

[![npm](https://img.shields.io/npm/v/ccmx-cli?color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/ccmx-cli)
[![Claude Code](https://img.shields.io/badge/Claude_Code-tested_2.1.300-d97757.svg?logo=claude&logoColor=white)](https://code.claude.com/docs)
[![Bun](https://img.shields.io/badge/Bun-1.1+-fbf0df.svg?logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa.svg?logo=github-sponsors)](https://github.com/sponsors/gadingnst)
[![Trakteer](https://img.shields.io/badge/Trakteer-Dukung%20Kreator-red.svg)](https://trakteer.id/gadingnst)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20a%20Coffee-29abe0.svg?logo=ko-fi)](https://ko-fi.com/gadingnst)

Claude Code multiplexer. Several Claude Code profiles (`~/.claude`, `~/.claude-<name>`)
behind one command: every profile's sessions in one list, launches spread by usage, and
when a profile hits its limit the running session moves to another profile and carries on.

ccmx supervises `claude` instead of replacing it: you get the normal Claude Code UI.
Profiles stay separate (own login, settings, plugins, history). ccmx never reads or copies
credentials and never edits your settings files; its hooks, statusline and slash commands
are passed to `claude` per launch (`--settings`, `--plugin-dir`).

## Requirements

- **Claude Code CLI** (`claude` on your PATH). ccmx drives it and does not replace it.
  Tested with 2.1.300; older versions may lack the hooks ccmx relies on. Install it with the
  official installer, then check `claude --version`:

  ```sh
  curl -fsSL https://claude.ai/install.sh | bash   # macOS, Linux, WSL
  brew install --cask claude-code                  # or with Homebrew
  ```

  Other methods: [Claude Code setup guide](https://code.claude.com/docs/en/setup).
- **A Claude account per profile** with Claude Code access: Pro, Max, Team or Enterprise.
  Console (API key) profiles work too, but have no usage windows for ccmx to switch on. Log
  each profile in with `ccmx login <name>`.
- **[Bun](https://bun.sh) 1.1+** on your PATH; ccmx runs on it.
- **macOS or Linux**, WSL included. Native Windows is not supported: ccmx relies on POSIX
  signals and `ps`. Developed and tested on macOS.

## Install

The package is `ccmx-cli`; the command is `ccmx`.

```sh
npm i -g ccmx-cli      # or: bun add -g ccmx-cli
ccmx version           # ccmx and the claude it drives
```

From source:

```sh
git clone https://github.com/gadingnst/ccmx && cd ccmx
bun install && bun link        # puts `ccmx` on PATH
```

Optional, interactive shells only (build tools keep `/usr/bin/cc`): `alias cc=ccmx`.

## Use

```sh
ccmx login work             # ~/.claude-work (the name "claude" means ~/.claude)
ccmx list                   # accounts, 5h/7d usage, limits
ccmx                        # launch on the profile with the most headroom
ccmx --as personal          # launch on a specific profile
ccmx -r a1b2c3d4 --as work  # resume any profile's session (id, prefix, or search) as work
ccmx -c                     # continue this folder's latest session, any profile
ccmx sessions               # running ccmx sessions and recently ended ones
ccmx status                 # everything at a glance
ccmx --help                 # every command; `ccmx help <command>` for one
```

Every other argument goes to `claude` unchanged. Claude Code subcommands (`mcp`, `plugin`,
`doctor`, …) run on the default profile unless you add `--as`.

Inside a session started with ccmx:

| Command | Does |
|---|---|
| `/ccmx:switch [profile]` | move this session (next profile with room if no name) |
| `/ccmx:list` | profiles with usage |
| `/ccmx:status` | current profile and session |
| `/ccmx:history` | recent switches |

These are answered by a hook before they reach the model, so they work even at a limit.
From another terminal: `ccmx force-switch [profile] [--pid N]`.

## For AI agents

ccmx is built to be driven by agents (Claude Code, Cursor, …) as well as people:

- `ccmx -p "<prompt>" --output-format json` runs one headless turn on the profile with the
  most headroom. If that profile hits its usage limit mid-run, the same session continues
  on the next profile and only the final result is printed (text and json output;
  `stream-json` streams live and is not handed off). Repeated runs rotate across profiles.
- `ccmx -r <id> -p "…"` continues any session, from whichever profile has room.
- Every listing takes `--json`: `status`, `list`, `sessions`, `history`, `config keys`,
  `project list`. `ccmx help --json` describes every command, including which ones are
  interactive or change state.
- Interactive `ccmx` refuses to start without a terminal (exit 2) and points to `-p`.
- Exit codes: `0` ok, `1` error, `2` usage error, `130` cancelled, otherwise claude's own.

The bundled agent guide is [`skills/ccmx/SKILL.md`](skills/ccmx/SKILL.md). Print it with
`ccmx skill`, or install it as a Claude Code skill in every logged-in profile with
`ccmx skill install` (one profile: `--as <name>`). For other agents, copy the file into
their skills or rules folder.

## How switching works

```
claude (profile A) ── hooks ──► ~/.ccmx/runtime/signals/<pid>-* ──► ccmx supervisor
                                                                        │
            stop claude (SIGINT) ◄── limit / threshold / /ccmx:switch ──┘
            CLAUDE_CONFIG_DIR=<profile B> claude --resume <session> "Go continue."
```

| Trigger | When | First message after the switch |
|---|---|---|
| Rate limit | the transcript shows a rejected quota (account limit) | `auto_message` |
| Threshold | a prompt is sent over `thresholds.*` | the blocked prompt, replayed |
| Threshold | a turn ends over `thresholds.*` | none (the model may have asked you something) |
| Idle | idle past `idle_after_seconds` and over a threshold | none |
| `/ccmx:switch` | by hand; that session is pinned against threshold moves until it ends | none |
| Model cap | "Opus limit" and `model_fallback` is set | `auto_message`, same profile |
| Server error | 5xx, overloaded, throttling ("not your usage limit") | retried on the same profile with backoff, at most 5 times |

ccmx only moves to a profile that is under its own thresholds, so a session never bounces
between two full profiles. A cap on one model (weekly Opus) moves the session but does not
mark the whole profile limited.

With nowhere to go, ccmx keeps claude open ("parked") and moves as soon as a profile frees
up; after an exit it can wait for the first reset (`wait_for_reset`).

Usage numbers come from Claude Code's statusline input (`rate_limits.five_hour/seven_day`),
recorded per profile by a statusline shim that then shows your own statusline unchanged.
A profile only updates while it is in use, so readings older than 30 minutes are treated as
unknown: never a reason to leave a profile, never a reason to refuse one. Enforced limits
come from the transcript, which records the reset time.

## Configuration

```sh
ccmx config keys                         # every key with its default
ccmx config set thresholds.five_hour 85  # move at 85% instead of at the limit
ccmx config set strategy.kind drain      # balanced | drain | least-recent | manual
ccmx config set strategy.order work,personal
ccmx config set model_fallback sonnet
```

Per-folder pools, e.g. the work account for work repos:

```sh
ccmx project create acme --dir ~/code/acme
ccmx project assign acme work
```

## Sharing sessions between profiles

Without setup, ccmx copies a session's transcript into the target profile when it resumes
there. To keep one store instead:

```sh
ccmx migrate             # the plan: what would merge, conflicts, problems; changes nothing
ccmx migrate --yes       # apply it (quit every claude session first)
```

Every profile's `projects/` is merged into `~/.ccmx/projects` and replaced with a symlink.
Each original goes to `~/.ccmx/backup/<timestamp>/` first, and any store file that gets
replaced is backed up too. When two copies of a transcript differ and one extends the
other, the longer one wins; otherwise the newer one does. `memory/MEMORY.md` files are
merged line by line and other clashing memory files are kept side by side as
`<name>.from-<profile>.md`.

ccmx refuses to merge when profiles keep transcripts for different times
(`cleanupPeriodDays`): in a shared store, the shortest period would delete the others'
older sessions. It also refuses when `projects/` holds symlinks. `--force` overrides both.

## Notes

- Switching accounts means restarting `claude`; a turn in flight at a hard limit is lost
  and continued by `auto_message`.
- Prompt caching is per account: the first turn on the new profile re-reads the context.
- `CLAUDE_CODE_RETRY_WATCHDOG` makes claude wait out limits itself; ccmx warns about it.

## Layout

```
src/cli.ts        dispatcher: ccmx subcommands, everything else to the supervisor
src/commands/     one handler per subcommand
src/core/         supervisor, headless (-p), hooks, strategy, usage, sessions, migrate
skills/ccmx/      agent guide, bundled into the CLI
src/utils/        logger, errors, table, time
tests/core        unit tests
tests/e2e         CLI runs against a fake claude that executes the hooks for real
```

## Develop

```sh
bun run check     # typecheck + biome + tests
bun run build     # single binary in dist/ccmx
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
