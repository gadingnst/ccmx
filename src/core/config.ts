import { join } from 'node:path';
import { ccmxDir } from '@/core/paths';
import { readJson, writeJson } from '@/core/runtime';

export type StrategyKind = 'balanced' | 'drain' | 'least-recent' | 'manual';

export type Config = {
  /** Move the session to another profile when the API refuses a turn for a usage limit. */
  auto_switch_on_rate_limit: boolean;
  /** Move before the limit, once a window passes its threshold (needs statusline data). */
  auto_switch_on_threshold: boolean;
  /** Percent used at which a profile counts as full. 100 = only on a real limit. */
  thresholds: { five_hour: number; seven_day: number };
  strategy: { kind: StrategyKind; order: string[] };
  /** First message sent after an automatic switch, so interrupted work carries on. */
  auto_message: string;
  /** Switch an idle session off a full profile after this many seconds; 0 = never. */
  idle_after_seconds: number;
  poll_interval_seconds: number;
  /** Retry the same profile with backoff when a turn dies on a server or network error. */
  retry_on_api_error: boolean;
  /** When every profile is limited, wait for the first reset instead of exiting. */
  wait_for_reset: boolean;
  /** Models to fall back to (same profile) when only one model's limit is hit. */
  model_fallback: string[];
  /** Install the statusline shim that records usage per profile. */
  statusline: boolean;
};

export const DEFAULTS: Config = {
  auto_switch_on_rate_limit: true,
  auto_switch_on_threshold: true,
  thresholds: { five_hour: 100, seven_day: 100 },
  strategy: { kind: 'balanced', order: [] },
  auto_message: 'Go continue.',
  idle_after_seconds: 900,
  poll_interval_seconds: 60,
  retry_on_api_error: true,
  wait_for_reset: true,
  model_fallback: [],
  statusline: true
};

const file = () => join(ccmxDir(), 'config.json');

export function loadConfig(): Config {
  const c = readJson<Partial<Config>>(file()) ?? {};
  return {
    ...DEFAULTS,
    ...c,
    thresholds: { ...DEFAULTS.thresholds, ...c.thresholds },
    strategy: { ...DEFAULTS.strategy, ...c.strategy }
  };
}

/** Every settable key in dotted form with its default, for `ccmx config keys`. */
export function configKeys(): [string, unknown][] {
  const out: [string, unknown][] = [];
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v))
        walk(v as Record<string, unknown>, `${prefix}${k}.`);
      else out.push([`${prefix}${k}`, v]);
    }
  };
  walk(DEFAULTS as unknown as Record<string, unknown>, '');
  return out;
}

const KINDS: StrategyKind[] = ['balanced', 'drain', 'least-recent', 'manual'];

export function setConfig(key: string, raw: string): Config {
  const def = configKeys().find(([k]) => k === key);
  if (!def) throw new Error(`unknown key "${key}". See \`ccmx config keys\`.`);
  const [, sample] = def;
  let value: unknown;
  if (typeof sample === 'boolean') {
    if (!/^(true|false|yes|no|on|off|1|0)$/i.test(raw))
      throw new Error(`${key} takes true or false`);
    value = /^(true|yes|on|1)$/i.test(raw);
  } else if (typeof sample === 'number') {
    value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${key} takes a number`);
    if (key.startsWith('thresholds.') && ((value as number) < 0 || (value as number) > 100)) {
      throw new Error(`${key} takes 0 to 100`);
    }
  } else if (Array.isArray(sample)) {
    value = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    value = raw;
    if (key === 'strategy.kind' && !KINDS.includes(raw as StrategyKind)) {
      throw new Error(`strategy.kind takes ${KINDS.join(', ')}`);
    }
  }
  const c = loadConfig() as unknown as Record<string, Record<string, unknown>>;
  const [a, b] = key.split('.');
  if (b) c[a!]![b] = value;
  else (c as Record<string, unknown>)[a!] = value;
  writeJson(file(), c, 0o644);
  return c as unknown as Config;
}
