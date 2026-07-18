import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { clockOffsetMs, setClockOffsetMs } from '@/lib/clock';
import { useLabStore } from '@/state/stores/useLabStore';
import { startLabClock } from './lab-clock';

const CLEAN = { dateOverride: null, occasionModes: {}, flags: {} } as const;

beforeEach(() => {
  useLabStore.setState(CLEAN);
  setClockOffsetMs(0);
});

afterEach(() => {
  useLabStore.setState(CLEAN);
  setClockOffsetMs(0);
});

describe('startLabClock', () => {
  it('leaves the clock real when no override is stored', () => {
    const stop = startLabClock();
    expect(clockOffsetMs()).toBe(0);
    stop();
  });

  it('applies a stored override immediately, before any subscription fires', () => {
    // The override is applied at call time rather than on the next change — this is what lets
    // main.tsx shift the clock before the first render.
    useLabStore.setState({ dateOverride: '2030-01-01' });
    const stop = startLabClock();
    expect(clockOffsetMs()).not.toBe(0);
    stop();
  });

  it('follows a later change to the override', () => {
    const stop = startLabClock();
    expect(clockOffsetMs()).toBe(0);
    useLabStore.getState().setDateOverride('2030-01-01');
    expect(clockOffsetMs()).not.toBe(0);
    stop();
  });

  it('restores the real clock when the override is cleared', () => {
    useLabStore.setState({ dateOverride: '2030-01-01' });
    const stop = startLabClock();
    useLabStore.getState().setDateOverride(null);
    expect(clockOffsetMs()).toBe(0);
    stop();
  });

  it('stops following once unsubscribed', () => {
    const stop = startLabClock();
    stop();
    useLabStore.getState().setDateOverride('2030-01-01');
    expect(clockOffsetMs()).toBe(0);
  });

  it('ignores unrelated store changes', () => {
    useLabStore.setState({ dateOverride: '2030-01-01' });
    const stop = startLabClock();
    const before = clockOffsetMs();
    useLabStore.getState().setFlag('force-offline', true);
    expect(clockOffsetMs()).toBe(before);
    stop();
  });
});
