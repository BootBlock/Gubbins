import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEXTAREA_SIZES_KEY } from '@/lib/storage-keys';
import { Textarea } from './textarea';
import { readRememberedHeight, rememberHeight } from './textarea-size';

/**
 * happy-dom does no layout, so `offsetHeight` / `scrollHeight` are always 0 and the component
 * would read every box as unmeasurable. These stubs stand in for the layout engine, modelling
 * the three things the component actually reads:
 *
 *  - an inline `height` wins, exactly as it does in a browser (which is also how the browser
 *    records a resize-handle drag), so clearing it really does reveal the default height;
 *  - `defaultBoxHeight` is what the box's own CSS gives it;
 *  - `laidOut` false is a box with no layout at all — mounted inside something collapsed,
 *    hidden or off-screen — where every measurement reads zero.
 *
 * `getComputedStyle` reports nothing useful here either (no stylesheet is processed), so the
 * box reads as `content-box` with no padding or border; a test that cares about the
 * border-box correction states those as inline styles.
 */
let defaultBoxHeight = 100;
let contentHeight = 0;
let laidOut = true;

beforeEach(() => {
  defaultBoxHeight = 100;
  contentHeight = 0;
  laidOut = true;
  localStorage.removeItem(TEXTAREA_SIZES_KEY);
  Object.defineProperty(HTMLTextAreaElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      if (!laidOut) return 0;
      const inline = Number.parseFloat(this.style.height);
      return Number.isFinite(inline) ? inline : defaultBoxHeight;
    },
  });
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => (laidOut ? contentHeight : 0),
  });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'offsetHeight');
  Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight');
});

/** Drag the resize handle to `to` pixels — the browser applies the height, we react to it. */
function dragResizeTo(box: HTMLElement, to: number): void {
  fireEvent.pointerDown(box);
  box.style.height = `${to}px`;
  fireEvent.pointerUp(window);
}

/** Click into the box to place the caret — the same pointer gesture, resizing nothing. */
function clickInto(box: HTMLElement): void {
  fireEvent.pointerDown(box);
  fireEvent.pointerUp(window);
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText('Notes') as HTMLTextAreaElement;
}

describe('Textarea size memory', () => {
  it('stores nothing for a box the user has not resized', () => {
    render(<Textarea aria-label="Notes" sizeKey="item.notes" />);

    expect(textarea().style.height).toBe('');
    expect(localStorage.getItem(TEXTAREA_SIZES_KEY)).toBeNull();
  });

  it('remembers a height the user dragged to', () => {
    render(<Textarea aria-label="Notes" sizeKey="item.notes" />);

    dragResizeTo(textarea(), 260);

    expect(textarea().style.height).toBe('260px');
    expect(readRememberedHeight('item.notes')).toBe(260);
  });

  it('restores a remembered height when the box mounts again', () => {
    rememberHeight('item.notes', 260);

    render(<Textarea aria-label="Notes" sizeKey="item.notes" />);

    expect(textarea().style.height).toBe('260px');
  });

  it('ignores a click that places the caret rather than resizing', () => {
    render(<Textarea aria-label="Notes" sizeKey="item.notes" />);

    clickInto(textarea());

    expect(textarea().style.height).toBe('');
    expect(localStorage.getItem(TEXTAREA_SIZES_KEY)).toBeNull();
  });

  it('does not mistake a click into an auto-grown box for a choice about its size', () => {
    // The case that makes the click/drag distinction load-bearing: this box is taller than its
    // default because of what it holds, not because anyone asked. Treating the click as a
    // resize would pin that incidental height and remember it for good.
    contentHeight = 180;
    render(
      <Textarea aria-label="Notes" sizeKey="item.notes" autoGrow value="a long note" onChange={vi.fn()} />,
    );
    expect(textarea().style.height).toBe('180px');

    clickInto(textarea());

    expect(localStorage.getItem(TEXTAREA_SIZES_KEY)).toBeNull();
    // Still following its content rather than frozen at the height it happened to be.
    contentHeight = 120;
    fireEvent.change(textarea(), { target: { value: 'shorter' } });
    expect(textarea().style.height).toBe('120px');
  });

  it('forgets the box once it is dragged back to its default height', () => {
    rememberHeight('item.notes', 260);
    render(<Textarea aria-label="Notes" sizeKey="item.notes" />);

    dragResizeTo(textarea(), 100);

    expect(textarea().style.height).toBe('');
    expect(readRememberedHeight('item.notes')).toBeNull();
  });

  it('forgets the box when it is shrunk past the default rather than onto it exactly', () => {
    // Nobody can land a drag on an exact pixel, so shrinking it as far as it will go has to
    // count as "put it back to normal" — otherwise the escape hatch is unreachable by hand.
    rememberHeight('item.notes', 260);
    render(<Textarea aria-label="Notes" sizeKey="item.notes" />);

    dragResizeTo(textarea(), 72);

    expect(textarea().style.height).toBe('');
    expect(readRememberedHeight('item.notes')).toBeNull();
  });

  it('still recognises the default height for a box that had no layout at mount', () => {
    // The default height is measured when the drag ends, not when the box mounts. A box that
    // was unmeasurable at mount would otherwise have recorded a zero and lost the "shrink it
    // back down and it is forgotten" rule for the rest of its life.
    rememberHeight('item.notes', 260);
    laidOut = false;
    render(<Textarea aria-label="Notes" sizeKey="item.notes" />);
    expect(textarea().style.height).toBe('260px');

    laidOut = true;
    dragResizeTo(textarea(), 100);

    expect(textarea().style.height).toBe('');
    expect(readRememberedHeight('item.notes')).toBeNull();
  });

  it('applies a drag but stores nothing when the box has no sizeKey', () => {
    render(<Textarea aria-label="Notes" />);

    dragResizeTo(textarea(), 260);

    expect(textarea().style.height).toBe('260px');
    expect(localStorage.getItem(TEXTAREA_SIZES_KEY)).toBeNull();
  });

  it('keeps two boxes independent', () => {
    const { unmount } = render(<Textarea aria-label="Notes" sizeKey="item.notes" />);
    dragResizeTo(textarea(), 260);
    unmount();

    render(<Textarea aria-label="Notes" sizeKey="item.description" />);

    expect(textarea().style.height).toBe('');
    expect(readRememberedHeight('item.notes')).toBe(260);
  });
});

describe('Textarea auto-grow', () => {
  it('fits itself to content taller than the default height', () => {
    contentHeight = 180;

    render(<Textarea aria-label="Notes" autoGrow readOnly value="a long note" />);

    expect(textarea().style.height).toBe('180px');
  });

  it('adds the border back when the box is border-box, so the content still fits', () => {
    // `scrollHeight` counts content + padding but not the border, while a border-box `height`
    // counts all three. Assign one to the other unadjusted and the box lands short by its own
    // border, leaving a scrollbar on the very box that grew to avoid one.
    contentHeight = 180;

    render(
      <Textarea
        aria-label="Notes"
        autoGrow
        style={{ boxSizing: 'border-box', borderTopWidth: '1px', borderBottomWidth: '1px' }}
        value="a long note"
        onChange={vi.fn()}
      />,
    );

    expect(textarea().style.height).toBe('182px');
  });

  it('takes the padding off instead when the box is content-box', () => {
    // The mirror of the case above: a content-box `height` is the content alone, so the
    // padding `scrollHeight` includes has to come back off — and the default height, which
    // was measured as an `offsetHeight`, has to be converted before it can act as the floor.
    contentHeight = 180;

    render(
      <Textarea
        aria-label="Notes"
        autoGrow
        style={{ boxSizing: 'content-box', paddingTop: '8px', paddingBottom: '8px' }}
        value="a long note"
        onChange={vi.fn()}
      />,
    );

    expect(textarea().style.height).toBe('164px');
  });

  it('converts the default height into the same units before using it as the floor', () => {
    // Content shorter than the default, so the floor is what decides the height. The default
    // was measured as an `offsetHeight` (100, border-box); left unconverted it would set a
    // content height of 100 here and render the box 16px taller than its own default.
    contentHeight = 50;

    render(
      <Textarea
        aria-label="Notes"
        autoGrow
        style={{ boxSizing: 'content-box', paddingTop: '8px', paddingBottom: '8px' }}
        value="short"
        onChange={vi.fn()}
      />,
    );

    expect(textarea().style.height).toBe('84px');
  });

  it('stops at the maxRows ceiling', () => {
    contentHeight = 5000;

    render(
      // An explicit line height, since the test environment processes no stylesheet and the
      // ceiling is measured in lines.
      <Textarea
        aria-label="Notes"
        autoGrow
        maxRows={2}
        style={{ lineHeight: '20px' }}
        readOnly
        value="an enormous note"
      />,
    );

    expect(textarea().style.height).toBe('40px');
  });

  it('re-fits as the user types, and still reports the change to the caller', () => {
    const onChange = vi.fn();
    render(<Textarea aria-label="Notes" autoGrow value="" onChange={onChange} />);

    contentHeight = 200;
    fireEvent.change(textarea(), { target: { value: 'typed' } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(textarea().style.height).toBe('200px');
  });

  it('leaves the height alone once the user has chosen one', () => {
    contentHeight = 180;
    render(
      <Textarea aria-label="Notes" autoGrow sizeKey="item.notes" value="a long note" onChange={vi.fn()} />,
    );

    dragResizeTo(textarea(), 300);
    contentHeight = 120;
    fireEvent.change(textarea(), { target: { value: 'shorter' } });

    expect(textarea().style.height).toBe('300px');
  });

  it('resumes fitting to content after the box is dragged back to its default', () => {
    contentHeight = 180;
    render(<Textarea aria-label="Notes" autoGrow sizeKey="item.notes" readOnly value="a long note" />);

    dragResizeTo(textarea(), 300);
    dragResizeTo(textarea(), 100);

    expect(textarea().style.height).toBe('180px');
    expect(readRememberedHeight('item.notes')).toBeNull();
  });

  it('leaves the height to CSS when there is no layout to measure', () => {
    contentHeight = 0;

    render(<Textarea aria-label="Notes" autoGrow readOnly value="a long note" />);

    expect(textarea().style.height).toBe('');
  });
});

describe('Textarea plumbing', () => {
  it('forwards its ref to the element', () => {
    const ref = createRef<HTMLTextAreaElement>();

    render(<Textarea aria-label="Notes" ref={ref} />);

    expect(ref.current).toBe(textarea());
  });

  it("passes the caller's own props straight through", () => {
    render(<Textarea aria-label="Notes" rows={6} placeholder="Anything worth remembering" />);

    expect(textarea()).toHaveAttribute('rows', '6');
    expect(textarea()).toHaveAttribute('placeholder', 'Anything worth remembering');
  });

  it('keeps the caller onChange untouched without autoGrow', () => {
    const onChange = vi.fn();
    render(<Textarea aria-label="Notes" value="" onChange={onChange} />);

    fireEvent.change(textarea(), { target: { value: 'typed' } });

    expect(onChange).toHaveBeenCalledOnce();
  });
});
