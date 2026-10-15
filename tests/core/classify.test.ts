import { describe, expect, it } from 'bun:test';
import { classify, refusedModel } from '@/core/classify';

const stopFailure = (error: unknown, msg?: string) =>
  classify({ hook_event_name: 'StopFailure', error, last_assistant_message: msg });
const toolFailure = (error: unknown, tool_name = 'Agent') =>
  classify({ hook_event_name: 'PostToolUseFailure', tool_name, error });

describe('classify', () => {
  it('recognises usage limits on any event', () => {
    expect(stopFailure('rate_limit', "You've hit your session limit · resets 5pm")).toBe(
      'rate-limited'
    );
    expect(toolFailure('Claude usage limit reached, limit will reset at 5pm')).toBe('rate-limited');
  });

  it('ignores "usage limit" from tools that are not subagents', () => {
    expect(toolFailure('Error: usage limit exceeded for the maps API', 'Bash')).toBeUndefined();
    expect(toolFailure("You've hit your session limit", 'WebFetch')).toBeUndefined();
  });

  it('only trusts API rate-limit codes on StopFailure', () => {
    expect(stopFailure('rate_limit')).toBe('rate-limited');
    expect(toolFailure('rate_limit')).toBeUndefined();
    expect(stopFailure('429 Too Many Requests from the API')).toBe('rate-limited');
  });

  it('ignores other kinds of limits and fetched web pages', () => {
    expect(stopFailure('invalid_request', 'context window exceeded')).toBeUndefined();
    expect(toolFailure('<html><body>usage limit</body></html>')).toBeUndefined();
  });

  it('calls server and network errors transient', () => {
    expect(stopFailure('server_error', '503 Service Unavailable')).toBe('turn-failed');
    expect(stopFailure({ type: 'api_error', message: 'socket hang up' })).toBe('turn-failed');
  });

  it('does nothing without an error', () => {
    expect(classify({ hook_event_name: 'StopFailure' })).toBeUndefined();
  });
});

describe('refusedModel', () => {
  it('finds a single-model cap', () => {
    expect(refusedModel("You've reached your Opus limit")).toBe('opus');
    expect(refusedModel("You've hit your session limit")).toBeUndefined();
  });
});

describe('overloaded', () => {
  it('retries instead of switching, since every account shares the same servers', () => {
    expect(stopFailure('overloaded', 'API Error: Overloaded')).toBe('turn-failed');
  });
});

describe('server-side refusals that are not this account’s limit', () => {
  it('retries throttling and load instead of switching accounts', () => {
    expect(
      stopFailure(
        'rate_limit',
        'Server is temporarily limiting requests (not your usage limit) · this may be a temporary capacity issue'
      )
    ).toBe('turn-failed');
    expect(
      stopFailure(
        'rate_limit',
        'Opus is experiencing high load, please use /model to switch to Sonnet'
      )
    ).toBe('turn-failed');
  });

  it('leaves a credits error alone', () => {
    expect(stopFailure('rate_limit', 'Usage credits required for 1M context')).toBeUndefined();
  });
});
