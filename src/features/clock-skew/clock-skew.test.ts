/**
 * Covers the boot wiring's judgement calls — which readings are allowed to change the stored
 * correction, and when a measurement is taken at all. The arithmetic itself lives in `skew.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clockSkewMs, setClockSkewMs } from '@/lib/clock';
import { useClockSkewStore } from '@/state/stores/useClockSkewStore';
import { SKEW_SANITY_LIMIT_MS } from './skew';
import { recordMeasuredSkew, startClockSkew } from './clock-skew';

const A_WEEK = 7 * 86_400_000;

/** Unsubscribes returned by `startClockSkew`, torn down between tests. */
let stops: (() => void)[] = [];

function start(): void {
  stops.push(startClockSkew());
}

beforeEach(() => {
  useClockSkewStore.setState({ skewMs: 0, measuredAt: 0 });
  setClockSkewMs(0);
});

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  setClockSkewMs(0);
  vi.restoreAllMocks();
});

describe('recordMeasuredSkew', () => {
  it('stores a plausible reading, quantised to the source granularity', () => {
    start();
    expect(recordMeasuredSkew(-7_600)).toBe(true);
    expect(useClockSkewStore.getState().skewMs).toBe(-8_000);
  });

  it('pushes the stored value onto the evaluation clock through the subscription', () => {
    start();
    recordMeasuredSkew(-A_WEEK);
    expect(clockSkewMs()).toBe(-A_WEEK);
  });

  it('clears a stale correction when the clocks now agree', () => {
    useClockSkewStore.setState({ skewMs: -A_WEEK, measuredAt: 1 });
    start();
    expect(clockSkewMs()).toBe(-A_WEEK);
    expect(recordMeasuredSkew(120)).toBe(true); // inside the deadband → genuinely no skew
    expect(useClockSkewStore.getState().skewMs).toBe(0);
    expect(clockSkewMs()).toBe(0);
  });

  it('leaves a good correction alone when a reading is implausible', () => {
    // The distinction that matters: one garbage `Date` header from a broken proxy must not
    // discard a correct, known correction and send the app back to the wrong clock.
    useClockSkewStore.setState({ skewMs: -A_WEEK, measuredAt: 1 });
    start();
    expect(recordMeasuredSkew(SKEW_SANITY_LIMIT_MS + 1)).toBe(false);
    expect(useClockSkewStore.getState().skewMs).toBe(-A_WEEK);
    expect(clockSkewMs()).toBe(-A_WEEK);
  });
});

describe('startClockSkew', () => {
  it('applies the persisted correction synchronously, before any measurement', () => {
    useClockSkewStore.setState({ skewMs: -A_WEEK, measuredAt: Date.now() });
    start();
    expect(clockSkewMs()).toBe(-A_WEEK);
  });

  it('skips the network measurement while the stored reading is fresh', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    useClockSkewStore.setState({ skewMs: -A_WEEK, measuredAt: Date.now() });
    start();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops tracking the store once unsubscribed', () => {
    const stop = startClockSkew();
    stop();
    useClockSkewStore.getState().recordSkew(-A_WEEK, Date.now());
    expect(clockSkewMs()).toBe(0);
  });
});
