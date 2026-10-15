import { describe, expect, it } from 'bun:test';
import { DEFAULTS } from '@/core/config';
import { hasCapacity, isExhausted, isOverThreshold } from '@/core/strategy';
import type { Headroom } from '@/core/usage';

const h = (over: Partial<Headroom>): Headroom => ({ stale: false, limitedUntil: 0, ...over });
const cfg = (five = 100, seven = 100) => ({
  ...DEFAULTS,
  thresholds: { five_hour: five, seven_day: seven }
});

describe('isOverThreshold', () => {
  it('always leaves a profile at 100% or with an enforced limit', () => {
    expect(isOverThreshold(h({ five: 100 }), cfg())).toBe(true);
    expect(isOverThreshold(h({ limitedUntil: Date.now() + 1000, stale: true }), cfg())).toBe(true);
  });

  it('compares against thresholds below 100 only', () => {
    expect(isOverThreshold(h({ five: 95 }), cfg())).toBe(false);
    expect(isOverThreshold(h({ five: 95 }), cfg(90))).toBe(true);
    expect(isOverThreshold(h({ seven: 85 }), cfg(100, 80))).toBe(true);
  });

  it('never moves on a stale reading', () => {
    expect(isOverThreshold(h({ five: 99, stale: true }), cfg(90))).toBe(false);
  });
});

describe('hasCapacity', () => {
  it('fails open on unknown or stale readings', () => {
    expect(hasCapacity(h({ stale: true }), cfg())).toBe(true);
    expect(hasCapacity(h({ five: 99, stale: true }), cfg())).toBe(true);
  });

  it('keeps headroom as a target even when the threshold is 100', () => {
    expect(hasCapacity(h({ five: 92 }), cfg())).toBe(false);
    expect(hasCapacity(h({ five: 50 }), cfg())).toBe(true);
    expect(hasCapacity(h({ seven: 100 }), cfg())).toBe(false);
  });

  it('refuses a profile with an enforced limit', () => {
    expect(hasCapacity(h({ limitedUntil: Date.now() + 1000 }), cfg())).toBe(false);
  });
});

describe('isExhausted', () => {
  it('is true only at a hard limit', () => {
    expect(isExhausted(h({ five: 100 }))).toBe(true);
    expect(isExhausted(h({ five: 100, stale: true }))).toBe(false);
    expect(isExhausted(h({ five: 80 }))).toBe(false);
  });
});
