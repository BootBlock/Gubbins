import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { CalculatorIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';
import { evaluateExpression, formatCalcResult, hasCalcExpression } from './evaluate-expression';
import { LiveRegion } from './live-region';
import { Tooltip } from './tooltip';

/**
 * Foundry NumberInput — a numeric field with a built-in **micro-calculator** (issue #93).
 *
 * It looks and behaves like an ordinary number box, but you can *type a sum into it*:
 * enter `500/2` and, on **Enter** or when the field loses focus, it settles to `250`.
 * `+ − × ÷`, `^` powers, a postfix `%` (divide-by-100) and parentheses are all understood
 * — the pure {@link evaluateExpression} seam does the maths (no `eval`, ever). While you
 * type a calculation a live "= result" preview appears at the trailing edge, alongside a
 * calculator glyph whose rich-Markdown {@link Tooltip} documents the feature.
 *
 * This is the control the Foundry {@link Input} delegates to for `type="number"`, so every
 * number field in the app gains the calculator for free. Because the field must hold
 * operator characters (`/`, `*`, …) it is a `type="text"` box with `inputMode="decimal"`,
 * not a native `type="number"` spinbutton.
 *
 * Accessibility (WCAG 2.x): the calculator hint is always exposed to assistive tech via a
 * visually-hidden `aria-describedby` (so it never depends on hovering the glyph), the
 * computed result is announced through a polite {@link LiveRegion} on commit (4.1.3 Status
 * Messages), and any `aria-describedby` / `aria-invalid` a parent {@link FormField} injects
 * is preserved and merged rather than clobbered.
 */
export type NumberInputProps = InputHTMLAttributes<HTMLInputElement>;

/** Write a value into an input via the native setter so React's change tracking fires. */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  {
    className,
    inputMode = 'decimal',
    autoComplete = 'off',
    onChange,
    onBlur,
    onFocus,
    onKeyDown,
    disabled,
    readOnly,
    'aria-describedby': ariaDescribedBy,
    ...props
  },
  forwardedRef,
) {
  const t = useT();
  const hintId = useId();
  const innerRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState<string>(() => String(props.value ?? props.defaultValue ?? ''));
  const [focused, setFocused] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  // Compose the caller's ref (often React Hook Form's `register().ref`) with our own.
  const setRef = useCallback(
    (node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  // Keep the preview mirror in step when a controlled `value` changes from outside.
  useEffect(() => {
    if (props.value !== undefined) setText(String(props.value));
  }, [props.value]);

  /**
   * Evaluate the current text and, if it is a valid calculation, write the result back so
   * downstream `onChange` (RHF / controlled parents) sees the computed number. Returns
   * whether it actually rewrote the field.
   */
  const commit = useCallback((): boolean => {
    const el = innerRef.current;
    if (!el) return false;
    const raw = el.value;
    if (!hasCalcExpression(raw)) return false;
    const result = evaluateExpression(raw);
    if (!result.ok) return false;
    const formatted = formatCalcResult(result.value);
    if (formatted === raw.trim()) return false;
    setNativeValue(el, formatted);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setText(formatted);
    setAnnouncement(t('numberInput.result', { vars: { result: formatted } }));
    return true;
  }, [t]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setText(e.target.value);
      onChange?.(e);
    },
    [onChange],
  );

  const handleFocus = useCallback(
    (e: FocusEvent<HTMLInputElement>) => {
      // Re-sync the mirror from the DOM (covers an external reset while unfocused).
      setText(e.target.value);
      setFocused(true);
      onFocus?.(e);
    },
    [onFocus],
  );

  const handleBlur = useCallback(
    (e: FocusEvent<HTMLInputElement>) => {
      setFocused(false);
      // Evaluate *before* the caller's onBlur so form validation reads the computed value.
      commit();
      onBlur?.(e);
    },
    [commit, onBlur],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // Enter computes the sum in place; swallow it (so it doesn't submit the form) only when
      // there was actually a calculation to work out, leaving plain-number Enter untouched.
      if (e.key === 'Enter' && commit()) e.preventDefault();
      onKeyDown?.(e);
    },
    [commit, onKeyDown],
  );

  const isCalc = hasCalcExpression(text);
  const preview = isCalc ? evaluateExpression(text) : null;
  const showAffordance = focused && isCalc && !disabled && !readOnly;

  return (
    <div className={cn('relative flex h-10 w-full items-stretch text-sm', className)}>
      <input
        {...props}
        ref={setRef}
        type="text"
        inputMode={inputMode}
        autoComplete={autoComplete}
        disabled={disabled}
        readOnly={readOnly}
        aria-describedby={[ariaDescribedBy, hintId].filter(Boolean).join(' ')}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className={cn(
          'h-full w-full rounded-lg border border-border bg-input/40 px-3 text-[length:inherit] text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
          showAffordance && 'pr-16',
        )}
      />

      {/* The visible calculator affordance sits over the field, so it must live inside this
          positioned wrapper. It is `aria-hidden` — assistive tech gets the same help from the
          portaled `srHint` below (referenced by `aria-describedby`) and hears the computed value
          from the live region, so the glyph is a pointer-only nicety and never joins the field's
          accessible name (which the wrapper would otherwise fold it into). */}
      {showAffordance ? (
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1.5">
          {preview?.ok ? (
            <span className="max-w-[6rem] truncate rounded bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
              = {formatCalcResult(preview.value)}
            </span>
          ) : null}
          <Tooltip
            content={t('numberInput.help')}
            size="md"
            triggerTabIndex={-1}
            className="pointer-events-auto"
          >
            <span
              className={cn(
                'grid size-4 cursor-help place-items-center transition-colors ease-emphasized [&_svg]:size-4',
                preview?.ok ? 'text-muted-foreground/70 hover:text-foreground' : 'text-warning',
              )}
            >
              <CalculatorIcon />
            </span>
          </Tooltip>
        </div>
      ) : null}

      {/* Portaled to <body> so neither the always-present calculator hint nor the transient
          result announcement is nested inside a wrapping <label>, where either would be folded
          into the control's accessible name. `aria-describedby` still reaches the hint by id. */}
      {createPortal(
        <>
          <span id={hintId} className="sr-only">
            {t('numberInput.srHint')}
          </span>
          <LiveRegion visuallyHidden>{announcement ? <span>{announcement}</span> : null}</LiveRegion>
        </>,
        document.body,
      )}
    </div>
  );
});
