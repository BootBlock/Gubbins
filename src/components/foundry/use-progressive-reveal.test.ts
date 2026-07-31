import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useProgressiveReveal } from './use-progressive-reveal';

describe('useProgressiveReveal', () => {
  it('opens on the initial slice and reports what is held back', () => {
    const { result } = renderHook(() => useProgressiveReveal(40, { initial: 12 }));
    expect(result.current.limit).toBe(12);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.expanded).toBe(false);
  });

  it('reveals a step at a time, then stops at the total', () => {
    const { result } = renderHook(() => useProgressiveReveal(30, { initial: 12 }));
    act(() => result.current.showMore());
    expect(result.current.limit).toBe(24);
    expect(result.current.expanded).toBe(true);
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.showMore());
    // The step overshoots the total; the limit is clamped to it and nothing is left over.
    expect(result.current.limit).toBe(30);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.expanded).toBe(true);
  });

  it('honours a step that differs from the initial slice', () => {
    const { result } = renderHook(() => useProgressiveReveal(100, { initial: 20, step: 5 }));
    act(() => result.current.showMore());
    expect(result.current.limit).toBe(25);
  });

  it('collapses back to the initial slice', () => {
    const { result } = renderHook(() => useProgressiveReveal(40, { initial: 12 }));
    act(() => result.current.showMore());
    act(() => result.current.showLess());
    expect(result.current.limit).toBe(12);
    expect(result.current.expanded).toBe(false);
  });

  it('never claims more rows than the set holds', () => {
    const { result } = renderHook(() => useProgressiveReveal(5, { initial: 12 }));
    expect(result.current.limit).toBe(5);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.expanded).toBe(false);
  });

  it('re-clamps when the set shrinks under an expanded view, and steps from there', () => {
    // A refetch (a narrower window, a deleted category) can shrink the set while the user has
    // it expanded — the visible count follows the data down rather than claiming absent rows.
    const { result, rerender } = renderHook(({ total }) => useProgressiveReveal(total, { initial: 4 }), {
      initialProps: { total: 40 },
    });
    act(() => result.current.showMore()); // 8 of 40
    expect(result.current.limit).toBe(8);

    rerender({ total: 6 });
    expect(result.current.limit).toBe(6);
    expect(result.current.hasMore).toBe(false);

    // Stepping again continues from the clamped view, not from the stale 8.
    act(() => result.current.showMore());
    expect(result.current.limit).toBe(6);
  });

  it('treats a non-positive total as an empty set', () => {
    const { result } = renderHook(() => useProgressiveReveal(0, { initial: 12 }));
    expect(result.current.limit).toBe(0);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.expanded).toBe(false);
  });
});
