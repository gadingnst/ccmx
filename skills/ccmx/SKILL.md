---
name: ccmx
description: Run Claude Code across several Claude accounts (profiles) with ccmx, the Claude Code multiplexer. Use when the user wants work done on whichever Claude account still has usage left, wants a headless Claude run that survives a usage limit, asks which account or profile has room, wants to resume or continue a Claude session from another account, or mentions ccmx, profiles like ~/.claude-<name>, rotating accounts, or usage limits.
---

# ccmx: Claude Code across several accounts

ccmx runs Claude Code (`claude`) on one of several profiles: `~/.claude` (profile
`claude`) and `~/.claude-<name>` (profile `<name>`), each logged in to its own account.
It picks the profile with the most usage left, and when a profile hits its usage limit
it moves the session to another profile and carries on.

Everything that is not a ccmx command is passed to `claude` unchanged, so any claude
flag works after `ccmx`.

## Before anything: check it is there

```bash
ccmx version        # ccmx and claude versions
ccmx status --json  # profiles, usage, limits, running sessions, settings
```

If `ccmx` is not found, it installs with `npm i -g ccmx-cli` (needs Bun on PATH;
the command is still `ccmx`). Ask the user before installing.

## Doing work: headless runs

Use `-p` (print mode). Interactive `ccmx` needs a person at a terminal and refuses to
start without one.

```bash
ccmx -p "summarise the open TODOs in src/" --output-format json
```

- The run goes to the profile with the most headroom right now.
- With `--output-format text` or `json`, if that profile hits its usage limit mid-run,
  ccmx resumes the same session on the next profile and prints only the final result.
  A note goes to stderr: `ccmx <a> hit its usage limit; continuing this turn on <b>`.
- With `--output-format stream-json` the output streams live and is never handed off.
- `--as <profile>` pins the profile; then there is no hand-off.
- Exit code is claude's. If every profile is limited, ccmx exits 1 and stderr says
  which profile frees up first and when; do not retry before that time.

Continue a session (from any profile) by id:

```bash
ccmx sessions --here --json            # sessions for this folder: id, title, profiles, updatedAt
ccmx -r <id> -p "now add tests for it" --output-format json
ccmx -c -p "continue" --output-format json   # latest session in this folder
```

The json result from `claude -p --output-format json` includes `session_id`; keep it to
continue the same conversation later.

## Reading state (all safe)

| Command | Gives |
|---|---|
| `ccmx status --json` | `version`, `claude`, `nextProfile` (where a run would start now), `profiles[]`, `running[]`, `config` |
| `ccmx list --json` | `profiles[]`: `name`, `email`, `status` (`ready` · `limited` · `full` · `logged-out`), `limitedUntil` (ISO), `usage.fiveHour`/`sevenDay` (percent or null), `usage.stale`, `pinned`, `lastUsed` |
| `ccmx sessions --json` | `running[]` ccmx sessions and `recent[]` ended ones, each with a `resume` command |
| `ccmx sessions --here --json` / `--all --json` | transcripts for this folder / every folder |
| `ccmx history --json [-n 20]` | recent profile switches with trigger and reason |
| `ccmx config show` | settings as JSON; `ccmx config keys --json` for defaults |
| `ccmx help --json` | every command with usage, flags, and whether it is interactive or mutating |

Usage percentages come from Claude Code's own statusline while a profile is in use; a
reading older than 30 minutes is marked `stale` and should be treated as unknown.

## Ask the user first

These change accounts, settings or files. Run them only when the user asked:

- `ccmx login <profile>` (opens a browser; needs the user) and `ccmx logout <profile>`
- `ccmx config set <key> <value>`, `ccmx project …`, `ccmx clear <profile>`
- `ccmx migrate --yes` (merges every profile's sessions into one shared store; claude must be closed). Plain `ccmx migrate` only prints the plan and is safe.
- `ccmx skill install`, `ccmx history --clear`, `ccmx force-switch`

## Inside an interactive ccmx session

A person can type these in Claude Code; they are answered without reaching the model:
`/ccmx:switch [profile]`, `/ccmx:list`, `/ccmx:status`, `/ccmx:history`, `/ccmx:help`.

## Exit codes

`0` success · `1` error (stderr says why) · `2` usage error (unknown profile, missing
argument, no terminal for an interactive launch) · `130` cancelled · anything else is
claude's own exit code.

## Troubleshooting

- "every profile is limited": wait until the time given, or ask the user whether another
  account should be added with `ccmx login <name>`.
- "needs a terminal": you ran interactive `ccmx`; use `-p`.
- "no profile …": check names with `ccmx list --json`.
- A run seems to ignore a limit: `ccmx history --json` shows whether a switch happened.
