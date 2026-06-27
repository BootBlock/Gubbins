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
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

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
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
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
            className={cn(toastVariants({ tone: t.tone }), 'w-full max-w-sm')}
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
