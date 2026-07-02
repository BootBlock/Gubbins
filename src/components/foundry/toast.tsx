/**
 * Foundry Toast — the passive, auto-dismissing notification surface (spec §4 default
 * "Passive Toast Notification", and the §9.4.3 actionable degradation toast).
 *
 * A lean, dependency-free implementation: {@link ToastProvider} holds the live queue
 * and renders a fixed glassy viewport; {@link useToast} exposes `show`/`dismiss`. Like
 * the rest of the Foundry it is icon-library-agnostic (the icon is passed in from the
 * central registry) and never uses the native `title` attribute. Toasts auto-dismiss
 * after `duration` ms (default 5000); an optional action button stays clickable.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { prefersReducedMotion } from '@/lib/env/motion';

/**
 * How long the exit animation (`animate-toast-out`, ~0.2s) plays before the toast is
 * removed from React state. Kept marginally above the CSS duration so the final frame
 * is painted. Skipped entirely under reduced motion (see {@link prefersReducedMotion}).
 */
export const TOAST_EXIT_MS = 200;

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastOptions {
  readonly tone?: ToastTone;
  readonly icon?: ReactNode;
  readonly heading?: ReactNode;
  readonly message: ReactNode;
  /** An optional action (e.g. "Enter manually") rendered as a button. */
  readonly action?: { readonly label: string; readonly onClick: () => void };
  /** Auto-dismiss delay in ms; `0` keeps it until dismissed. Default 5000. */
  readonly duration?: number;
}

interface ActiveToast extends ToastOptions {
  readonly id: string;
  /** Set while the exit animation plays, just before the toast unmounts (two-phase dismiss). */
  readonly exiting?: boolean;
}

interface ToastContextValue {
  /** Enqueue a toast; returns its id. */
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const toastVariants = cva(
  'pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-md transition-all',
  {
    variants: {
      tone: {
        info: 'border-primary/30 bg-primary/15',
        success: 'border-success/30 bg-success/15',
        warning: 'border-warning/40 bg-warning/15',
        danger: 'border-destructive/40 bg-destructive/15',
      },
    },
    defaultVariants: { tone: 'info' },
  },
);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ActiveToast[]>([]);
  // Auto-dismiss `duration` timers, keyed by toast id.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Pending exit-animation removal timers, keyed by toast id (two-phase dismiss).
  const exitTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /** Remove a toast from state immediately and clear any timers it owns. */
  const remove = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    const exitTimer = exitTimers.current.get(id);
    if (exitTimer) {
      clearTimeout(exitTimer);
      exitTimers.current.delete(id);
    }
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  /**
   * Begin dismissing a toast. Under full motion this is a two-phase exit: flag the toast
   * as `exiting` so the exit animation plays, then remove it once the animation has run.
   * Under reduced motion (or where it can't be observed) we remove immediately so an
   * assistive-tech user never waits on a timeout for the toast to leave the live region.
   */
  const dismiss = useCallback(
    (id: string) => {
      // Cancel the auto-dismiss timer regardless of which phase we take.
      const timer = timers.current.get(id);
      if (timer) {
        clearTimeout(timer);
        timers.current.delete(id);
      }

      if (prefersReducedMotion()) {
        remove(id);
        return;
      }

      // Already exiting? The removal timer is in flight; nothing more to do. (This also
      // makes the dispatch below idempotent under React StrictMode's double-invocation.)
      if (exitTimers.current.has(id)) return;

      setToasts((current) => current.map((t) => (t.id === id && !t.exiting ? { ...t, exiting: true } : t)));

      exitTimers.current.set(
        id,
        setTimeout(() => {
          exitTimers.current.delete(id);
          remove(id);
        }, TOAST_EXIT_MS),
      );
    },
    [remove],
  );

  const show = useCallback(
    (options: ToastOptions): string => {
      const id = crypto.randomUUID();
      setToasts((current) => [...current, { ...options, id }]);
      const duration = options.duration ?? 5000;
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const auto = timers.current;
    const exit = exitTimers.current;
    return () => {
      for (const timer of auto.values()) clearTimeout(timer);
      auto.clear();
      for (const timer of exit.values()) clearTimeout(timer);
      exit.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            data-testid="toast"
            data-exiting={t.exiting ? '' : undefined}
            className={cn(
              toastVariants({ tone: t.tone }),
              'w-full max-w-sm',
              t.exiting ? 'animate-toast-out' : 'animate-rise',
            )}
          >
            {t.icon ? <span className="mt-0.5 shrink-0 [&_svg]:size-5">{t.icon}</span> : null}
            <div className="min-w-0 flex-1">
              {t.heading ? <p className="leading-tight font-semibold">{t.heading}</p> : null}
              <div className={cn('text-muted-foreground', t.heading && 'mt-0.5')}>{t.message}</div>
              {t.action ? (
                <button
                  type="button"
                  onClick={() => {
                    t.action!.onClick();
                    dismiss(t.id);
                  }}
                  className="mt-2 text-xs font-semibold text-primary underline-offset-2 hover:underline"
                >
                  {t.action.label}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
              className="-mr-1 shrink-0 rounded-md px-1 text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used within a ToastProvider.');
  return value;
}
