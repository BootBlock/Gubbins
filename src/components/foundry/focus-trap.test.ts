import { describe, it, expect } from 'vitest';
import { nextTrapIndex, trapFocusables, FOCUSABLE_SELECTOR } from './focus-trap';

describe('nextTrapIndex', () => {
  it('steps forward within the set', () => {
    expect(nextTrapIndex(4, 0, false)).toBe(1);
    expect(nextTrapIndex(4, 2, false)).toBe(3);
  });

  it('wraps forward off the last element to the first', () => {
    expect(nextTrapIndex(4, 3, false)).toBe(0);
  });

  it('steps backward within the set', () => {
    expect(nextTrapIndex(4, 3, true)).toBe(2);
    expect(nextTrapIndex(4, 1, true)).toBe(0);
  });

  it('wraps backward off the first element to the last', () => {
    expect(nextTrapIndex(4, 0, true)).toBe(3);
  });

  it('enters at the first element when focus is outside the set (Tab)', () => {
    expect(nextTrapIndex(4, -1, false)).toBe(0);
  });

  it('enters at the last element when focus is outside the set (Shift+Tab)', () => {
    expect(nextTrapIndex(4, -1, true)).toBe(3);
  });

  it('returns null when there is nothing focusable', () => {
    expect(nextTrapIndex(0, -1, false)).toBeNull();
    expect(nextTrapIndex(0, 0, true)).toBeNull();
  });

  it('keeps focus on the sole element when only one is focusable', () => {
    expect(nextTrapIndex(1, 0, false)).toBe(0);
    expect(nextTrapIndex(1, 0, true)).toBe(0);
    expect(nextTrapIndex(1, -1, false)).toBe(0);
  });

  it('excludes negative-tabindex and disabled controls from the selector', () => {
    // Every clause carries both exclusions — so a natively-focusable element that opts out
    // of the tab order with tabindex="-1" (e.g. an unchecked roving radio) is skipped too.
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled]):not([tabindex="-1"])');
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([disabled]):not([tabindex="-1"])');
    expect(FOCUSABLE_SELECTOR).not.toMatch(/button:not\(\[disabled\]\),/);
  });
});

describe('trapFocusables', () => {
  /** Build a detached dialog subtree from HTML and collect what a trap would cycle through. */
  function collect(html: string): string[] {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.append(root);
    try {
      return trapFocusables(root).map((el) => el.textContent ?? '');
    } finally {
      root.remove();
    }
  }

  it('collects the ordinary focusable controls', () => {
    expect(collect('<button>a</button><input aria-label="b" /><button>c</button>')).toEqual(['a', '', 'c']);
  });

  it('skips anything inside an inert subtree', () => {
    // A dialog that *hides* a region rather than unmounting it (the Settings search does)
    // marks it inert; `.focus()` on a display:none control does nothing, so a trap that
    // cycled onto one would leave Tab a dead key with no way out but Escape.
    expect(
      collect('<button>keep</button><div inert><button>hidden</button></div><button>also</button>'),
    ).toEqual(['keep', 'also']);
  });

  it('skips an inert element that is itself focusable', () => {
    expect(collect('<button>keep</button><button inert>gone</button>')).toEqual(['keep']);
  });
});
