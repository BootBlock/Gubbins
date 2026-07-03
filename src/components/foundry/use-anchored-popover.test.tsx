import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useAnchoredPopover } from './use-anchored-popover';

afterEach(cleanup);

function anchorRef() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return { current: el };
}

describe('useAnchoredPopover — portal positioning', () => {
  it('returns no style while closed (nothing to position)', () => {
    const ref = anchorRef();
    const { result } = renderHook(() => useAnchoredPopover(ref, false));
    expect(result.current.style).toBeUndefined();
  });

  it('returns a viewport-fixed style anchored to the trigger while open', () => {
    const ref = anchorRef();
    const { result } = renderHook(() => useAnchoredPopover(ref, true));
    const style = result.current.style!;
    expect(style).toBeDefined();
    // Fixed positioning is what lets the popover escape the dialog's overflow clip.
    expect(style.position).toBe('fixed');
    expect(style).toHaveProperty('width');
    expect(style).toHaveProperty('maxHeight');
    // With ample room below (jsdom viewport), it drops below the anchor rather than flipping up.
    expect(style).toHaveProperty('top');
    expect(style).not.toHaveProperty('bottom');
  });

  it('drops the style again when it closes', () => {
    const ref = anchorRef();
    const { result, rerender } = renderHook(({ open }) => useAnchoredPopover(ref, open), {
      initialProps: { open: true },
    });
    expect(result.current.style).toBeDefined();
    rerender({ open: false });
    expect(result.current.style).toBeUndefined();
  });
});
