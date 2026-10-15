/**
 * Decide whether a failed-turn or failed-tool hook is about a usage limit, a transient
 * server/network failure, or something else. Tool failures carry arbitrary text (web
 * pages, file contents), so only unambiguous phrases count there.
 */
export type Verdict = 'rate-limited' | 'turn-failed' | undefined;

const FOREIGN = ['url: http', '<!doctype', '<html', '<head', '<body'];

/** Limits that are not usage limits: switching accounts would not help. */
const OTHER_LIMITS = [
  'do not retry',
  'concurrent subagent',
  'context window',
  'context length',
  'maximum context',
  'token limit',
  'output limit',
  'output token',
  'max tokens',
  'character limit',
  'file size',
  'recursion limit'
];

/** Phrases Claude Code shows only for subscription usage limits. */
const USAGE_CAP = [
  'usage limit',
  'session limit',
  'hit your limit',
  'reached your limit',
  'weekly limit',
  'limit will reset',
  'upgrade to increase your usage'
];

const RATE_CODES = ['rate_limit_error', 'rate_limit'];
const RATE_WORDS = ['429', 'too many requests', 'quota exceeded', 'rate limit'];
const RATE_CONTEXT = [
  'api',
  'anthropic',
  'claude',
  'http',
  'status',
  'response',
  'overloaded',
  'retry-after'
];

/** Server capacity and network trouble: another account would not help, a retry might. */
const TRANSIENT = [
  'server_error',
  'overloaded',
  'api_error',
  'internal server error',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'connection refused',
  'connection reset',
  'connection closed',
  'econnrefused',
  'econnreset',
  'etimedout',
  'enotfound',
  'eai_again',
  'timed out',
  'timeout',
  'network error',
  'fetch failed',
  'socket hang up'
];

const text = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as { message?: unknown; type?: unknown };
    return String(o.message ?? o.type ?? '');
  }
  return '';
};

export type HookFailure = {
  hook_event_name?: string;
  tool_name?: string;
  error?: unknown;
  error_details?: unknown;
  last_assistant_message?: unknown;
};

/** Tools that run a model themselves, so their failure can be a Claude usage limit. */
const AGENT_TOOLS = ['Agent', 'Task'];

/**
 * Refusals that are not this account's limit. Claude Code writes them as rate_limit too,
 * so they must be caught before the usage-limit phrases ("not your usage limit" contains
 * one). Throttling and load clear on retry; credits do not change with the account.
 */
const SERVER_SIDE = [
  'not your usage limit',
  'temporarily limiting requests',
  'experiencing high load'
];
const NOT_RETRYABLE = ['usage credits required'];

export function classify(input: HookFailure): Verdict {
  if (input.error === undefined || input.error === null || input.error === '') return undefined;
  // A failing Bash/WebFetch/MCP call can print "usage limit" about some other service;
  // only a subagent's failure can be this account's limit.
  if (
    input.hook_event_name === 'PostToolUseFailure' &&
    !AGENT_TOOLS.includes(input.tool_name ?? '')
  )
    return undefined;
  const structured = `${text(input.error)} ${text(input.error_details)}`.toLowerCase();
  const all = `${structured} ${text(input.last_assistant_message)}`.toLowerCase();
  if (FOREIGN.some((w) => all.includes(w))) return undefined;
  if (NOT_RETRYABLE.some((w) => all.includes(w))) return undefined;
  if (SERVER_SIDE.some((w) => all.includes(w)))
    return input.hook_event_name === 'StopFailure' ? 'turn-failed' : undefined;
  if (OTHER_LIMITS.some((w) => all.includes(w))) return undefined;
  if (USAGE_CAP.some((w) => all.includes(w))) return 'rate-limited';
  if (input.hook_event_name !== 'StopFailure') return undefined;
  if (RATE_CODES.some((w) => structured.includes(w))) return 'rate-limited';
  if (RATE_WORDS.some((w) => all.includes(w)) && RATE_CONTEXT.some((w) => all.includes(w)))
    return 'rate-limited';
  if (TRANSIENT.some((w) => structured.includes(w)) || /\b(500|502|503|504|529)\b/.test(structured))
    return 'turn-failed';
  return undefined;
}

/** "Opus limit" style messages: only one model is capped, not the account. */
export function refusedModel(message: string): string | undefined {
  return message.toLowerCase().match(/\b(opus|sonnet|haiku|fable)\b[^.\n]{0,20}\blimit\b/)?.[1];
}

export const messageOf = (input: HookFailure) =>
  text(input.last_assistant_message) || text(input.error_details) || text(input.error);
