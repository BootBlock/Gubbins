import { Fragment, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import type { Formatters } from '@/lib/format';
import { useFormatters } from '@/lib/useFormatters';
import { COUNT_UP_DURATION_MS, useCountUp, useHasRolled } from './useCountUp';
import { type MediaQueryProvider } from './useReducedMotion';
import { useDecorationMotionReduced } from './decoration-motion';

export interface MoneyProps {
  /** The monetary amount. A non-finite value renders the em-dash placeholder. */
  readonly value: number;
  /**
   * Optional ISO-4217 override — render `value` under *this* currency's own symbol
   * (e.g. a per-supplier `EUR`) rather than the user's base currency. Presentation only,
   * never converted; see {@link Formatters.currency}.
   */
  readonly currency?: string;
  /**
   * Use this formatter bundle instead of the {@link useFormatters} hook. Pass it when the
   * caller already has a bundle in scope (e.g. a report component that receives one via
   * props for dependency-injected testability) so a screen full of prices shares a single
   * bundle rather than each `Money` reaching for the store. Omit it and the hook is used.
   */
  readonly formatters?: Formatters;
  /**
   * Roll the amount up (or down) to `value` like the {@link AnimatedNumber} ticker instead
   * of snapping — the numeric digits animate while the tinted currency symbol stays put,
   * settling with a brief `animate-count-pop`. Use it for **headline/settling totals** (a
   * report or dashboard valuation), never for a price that changes every render (e.g. rows
   * in the virtualised list) where it would be distracting. Default `false` — a plain
   * `<Money>` stays zero-cost with no frame loop. Reduced motion snaps regardless.
   */
  readonly animate?: boolean;
  /** With `animate`, also roll up from 0 on first mount (a "count-in"). Default false. */
  readonly animateOnMount?: boolean;
  /**
   * Roll duration in milliseconds when animating. Defaults to {@link COUNT_UP_DURATION_MS}; pass
   * `COUNT_UP_HEADLINE_DURATION_MS` for a headline total that counts in as its screen loads.
   */
  readonly durationMs?: number;
  /** Injectable reduced-motion provider (test seam), forwarded to the decoration-motion gate. */
  readonly motionProvider?: MediaQueryProvider;
  /** Classes merged onto the wrapping `<span>`. */
  readonly className?: string;
  /** Extra classes merged onto the tinted currency-symbol `<span>`. */
  readonly symbolClassName?: string;
  readonly 'data-testid'?: string;
}

/**
 * Foundry Money — the single, canonical way to render a cost/price anywhere in the app.
 *
 * It formats `value` in the user's base currency (or an optional per-value ISO override)
 * via the shared {@link useFormatters} bundle, then paints the **currency symbol** in its
 * own {@link money-symbol} token colour at 0.8 opacity so it reads as a distinct affordance
 * ahead of the neutral-coloured digits — e.g. a muted `£` before a foreground `4.25`. All
 * the formatting rules (locale, grouping, the override/fallback behaviour) live once in the
 * formatter; this component only owns the split-and-tint presentation, so every price across
 * the app looks and behaves identically without any call site repeating the logic.
 *
 * The value is emitted as plain in-order text spans, so assistive tech and copy-paste read
 * it exactly as the equivalent string (`£4.25`) with no reordering.
 *
 * Pass `animate` to roll the figure up like the {@link AnimatedNumber} ticker (headline
 * totals only) — the digits animate while the symbol stays put. The animated path runs a
 * frame loop, so the default stays a cheap static render for the many prices app-wide.
 */
export function Money({
  value,
  currency,
  formatters,
  animate,
  animateOnMount,
  durationMs,
  motionProvider,
  className,
  symbolClassName,
  'data-testid': testId,
}: MoneyProps) {
  // The hook must run unconditionally (Rules of Hooks); an explicit `formatters` prop simply
  // takes precedence over it. Both resolve to the same store-bound bundle at runtime.
  const hookFormatters = useFormatters();
  const fmt = formatters ?? hookFormatters;

  // Only the animated variant pulls in the reduced-motion listener + frame loop, so a plain
  // `<Money>` (the overwhelming majority, incl. list rows) stays a zero-cost static render.
  // `animate` is fixed per call site, so this branch never changes hook order across renders.
  if (animate) {
    return (
      <AnimatedMoney
        value={value}
        currency={currency}
        fmt={fmt}
        animateOnMount={animateOnMount}
        durationMs={durationMs}
        motionProvider={motionProvider}
        className={className}
        symbolClassName={symbolClassName}
        data-testid={testId}
      />
    );
  }

  return (
    <MoneyParts
      parts={fmt.currencyParts(value, currency)}
      className={className}
      symbolClassName={symbolClassName}
      data-testid={testId}
    />
  );
}

/**
 * The rolling variant of {@link Money}: the amount animates via the shared {@link useCountUp}
 * engine (the same ticker behind {@link AnimatedNumber}), re-deriving the currency parts each
 * frame so the symbol tint is preserved while the digits roll. `key={value}` replays the
 * one-shot settle-pop per target change; reduced motion snaps with no roll and no pop.
 */
function AnimatedMoney({
  value,
  currency,
  fmt,
  animateOnMount,
  durationMs = COUNT_UP_DURATION_MS,
  motionProvider,
  className,
  symbolClassName,
  'data-testid': testId,
}: {
  value: number;
  currency?: string;
  fmt: Formatters;
  animateOnMount?: boolean;
  durationMs?: number;
  motionProvider?: MediaQueryProvider;
  className?: string;
  symbolClassName?: string;
  'data-testid'?: string;
}) {
  const reduced = useDecorationMotionReduced(motionProvider);
  const display = useCountUp(value, { durationMs, animateOnMount, reduced });
  // The pop is a settle, so it belongs only to a roll that actually ran. The hook is called
  // unconditionally — `reduced` gates the result, never the call.
  const rolled = useHasRolled(Boolean(animateOnMount));
  const pop = !reduced && rolled;

  return (
    <MoneyParts
      key={value}
      parts={fmt.currencyParts(display, currency)}
      className={cn('inline-block', pop && 'animate-count-pop', className)}
      // Hold the settle-pop back by the roll duration so it fires as the figure lands rather than
      // while it is still climbing (`animate-count-pop` has no fill mode, so the wait paints nothing).
      style={pop ? { animationDelay: `${durationMs}ms` } : undefined}
      symbolClassName={symbolClassName}
      data-testid={testId}
    />
  );
}

/**
 * Presentational renderer shared by the static and animated paths: emits the Intl parts
 * in order, painting the currency symbol in the tinted `money-symbol` token, or the em-dash
 * placeholder when `parts` is `null` (a non-finite amount).
 */
function MoneyParts({
  parts,
  className,
  style,
  symbolClassName,
  'data-testid': testId,
}: {
  parts: ReturnType<Formatters['currencyParts']>;
  className?: string;
  style?: CSSProperties;
  symbolClassName?: string;
  'data-testid'?: string;
}) {
  if (!parts) {
    return (
      <span className={cn('tabular-nums', className)} style={style} data-testid={testId}>
        —
      </span>
    );
  }

  return (
    <span className={cn('tabular-nums', className)} style={style} data-testid={testId}>
      {parts.map((part, index) =>
        part.type === 'currency' ? (
          <span key={`${part.type}-${index}`} className={cn('text-money-symbol opacity-80', symbolClassName)}>
            {part.value}
          </span>
        ) : (
          <Fragment key={`${part.type}-${index}`}>{part.value}</Fragment>
        ),
      )}
    </span>
  );
}
