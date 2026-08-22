import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/features/i18n';
import { TEXT_LIMITS, textLength } from '@/lib/text-limits';

/**
 * How a text control tells the {@link FormField} around it how full it is (issue #346).
 *
 * The controls themselves are bare `<input>` / `<textarea>` elements with no wrapper — call
 * sites style them directly, so growing one would move a couple of hundred fields around the
 * app. There is nowhere inside the control to draw a counter. The field *around* it already
 * owns a slot under the control for its validation message, so the control reports upwards and
 * the field draws it there.
 *
 * A control with no `FormField` around it still marks itself `aria-invalid` when it overflows;
 * it simply has nowhere to put a counter. That is the same trade the number field makes with an
 * out-of-range value.
 */

/** What a text control publishes about its own length. */
export interface TextLimitState {
  /** The ceiling the control is applying, in code points. */
  readonly limit: number;
  /** The length of what the control currently holds, in code points. */
  readonly length: number;
  /** Whether the control holds more than `limit` allows. */
  readonly over: boolean;
}

/**
 * The reporting channel a {@link FormField} provides. `null` outside one, in which case a
 * control reports nowhere and simply keeps its own `aria-invalid`.
 */
export const TextLimitReport = createContext<((state: TextLimitState | null) => void) | null>(null);

/**
 * The default ceiling for an `<input type={type}>`, or `undefined` for a type that holds no
 * typed text at all (a checkbox, a colour, a date, a file). Numbers are absent too: they go to
 * `NumberInput`, which bounds a *value* rather than a length.
 *
 * A web address gets the roomier {@link TEXT_LIMITS.url} because a real one routinely runs past
 * the single-line tier — a tracking or preview link with a signed query string is often over a
 * thousand characters, and refusing to store a link the user can paste into a browser would be
 * the limit getting in the way rather than catching a runaway.
 */
export function defaultTextLimit(type: string): number | undefined {
  if (type === 'url') return TEXT_LIMITS.url;
  if (type === 'text' || type === 'search' || type === 'email' || type === 'tel' || type === 'password') {
    return TEXT_LIMITS.line;
  }
  return undefined;
}

/**
 * Whether a control is close enough to its ceiling for the field to start counting down.
 *
 * The last tenth of the allowance, capped at two hundred characters: a twenty-thousand-character
 * note box that began counting two thousand characters out would be showing a number that is
 * noise rather than a warning.
 *
 * It is also what keeps a field quiet. A control only reports itself while this is true (or while
 * it has actually overflowed), so ordinary typing updates nothing outside the control — the
 * alternative was a re-render of the surrounding field on every keystroke of every text box in
 * the app, to redraw a counter that was not on screen.
 */
export function isNearTextLimit(length: number, limit: number): boolean {
  return length >= limit - Math.min(limit / 10, 200);
}

/** The two messages a field draws for the control inside it, and the channel it listens on. */
export interface TextLimitSlot {
  /** Give this to a {@link TextLimitReport} provider wrapped around the control. */
  readonly report: (state: TextLimitState | null) => void;
  /** The validation sentence for an entry past the limit, or `undefined` while it fits. */
  readonly tooLong?: string;
  /** The countdown to show under the control, or `undefined` when there is nothing to say. */
  readonly remaining?: string;
}

/**
 * The field's half of the arrangement: listen to the control inside, and turn what it reports
 * into the two pieces of copy a field can draw.
 *
 * Shared by {@link FormField} and {@link AutocompleteField} — the two labelled wrappers in the
 * Foundry — so the wording, the precedence and the moment a countdown appears cannot drift
 * between a plain text field and a type-ahead one.
 */
export function useTextLimitSlot(): TextLimitSlot {
  const t = useT();
  const [state, setState] = useState<TextLimitState | null>(null);
  if (state === null) return { report: setState };
  return {
    report: setState,
    tooLong: state.over
      ? t('field.tooLong', { vars: { count: state.length - state.limit, limit: state.limit } })
      : undefined,
    remaining: state.over
      ? undefined
      : t('field.charactersLeft', { vars: { count: state.limit - state.length } }),
  };
}

/** What {@link useTextLimit} hands back to the control that called it. */
export interface TextLimitBinding<E extends HTMLInputElement | HTMLTextAreaElement> {
  /** Whether the control currently holds more than the limit allows. */
  readonly over: boolean;
  /** Note the control's current text. Call from the control's own change handler. */
  readonly noteText: (text: string) => void;
  /** Re-read the control's text from the DOM. Call on mount and on focus. */
  readonly syncFrom: (element: E | null) => void;
}

/**
 * Track how full a text control is against `limit`, and report it to the field around it.
 *
 * The length is read from the element rather than from a `value` prop because most of the app's
 * fields are uncontrolled: React Hook Form's `register()` writes into the node through a ref and
 * never re-renders the control, so a props-only reading would sit at zero until the first
 * keystroke and miss an over-long value that was already stored. Hence `syncFrom`, called at
 * mount and at focus — the two moments a value can have arrived from outside without passing
 * through `noteText`.
 *
 * Passing `undefined` for `limit` disables the whole thing: nothing is measured, and nothing is
 * reported.
 */
export function useTextLimit<E extends HTMLInputElement | HTMLTextAreaElement>(
  limit: number | undefined,
  controlledValue: unknown,
): TextLimitBinding<E> {
  const report = useContext(TextLimitReport);
  const [text, setText] = useState('');

  const noteText = useCallback((next: string) => setText(next), []);
  const syncFrom = useCallback((element: E | null) => {
    if (element) setText(element.value);
  }, []);

  // A controlled control does re-render, so its prop is the freshest reading there is — and the
  // only one available when the value changes while the box is neither focused nor typed into.
  useEffect(() => {
    if (controlledValue !== undefined && controlledValue !== null) setText(String(controlledValue));
  }, [controlledValue]);

  const length = limit === undefined ? 0 : textLength(text);
  const over = limit !== undefined && length > limit;

  // Layout-timed so the counter and the field's message paint in the same frame as the keystroke
  // that caused them, rather than a frame behind the character the user just typed. `null` while
  // the box is nowhere near full, which is what keeps the field around it from re-rendering on
  // every keystroke — React bails out of a state write that is `null` again.
  useLayoutEffect(() => {
    if (!report || limit === undefined) return;
    report(over || isNearTextLimit(length, limit) ? { limit, length, over } : null);
  }, [report, limit, length, over]);

  // Withdrawn on unmount only, so a field that swaps its control does not keep drawing a counter
  // for a control that has gone. Kept out of the effect above, whose deps change on every
  // keystroke and would otherwise clear and re-report the state each time.
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => () => reportRef.current?.(null), []);

  return { over, noteText, syncFrom };
}
