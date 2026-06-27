import type { FallbackProps } from 'react-error-boundary';
import { Surface, Button } from '@/components/foundry';
import { CriticalIcon } from '@/components/icons';
import { RescueActions } from './RescueActions';

/**
 * The top-level Safe Mode fallback (spec §3 — "Unbricking").
 *
 * Rendered by the global ErrorBoundary when React state or local data is
 * hopelessly corrupted, so the user is never trapped in a white-screen loop. It
 * surfaces the emergency data-rescue actions plus a chance to recover in place.
 */
export function SafeMode({ error, resetErrorBoundary }: FallbackProps) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div className="grid min-h-dvh place-items-center bg-background p-6">
      <Surface className="w-full max-w-md p-7">
        <div className="flex items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-destructive/15 text-destructive [&_svg]:size-6">
            <CriticalIcon />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Safe Mode</h1>
            <p className="text-sm text-muted-foreground">Gubbins hit an unexpected error.</p>
          </div>
        </div>

        <p className="mt-4 max-h-32 overflow-auto rounded-lg bg-secondary/50 p-3 font-mono text-xs break-words text-muted-foreground">
          {message}
        </p>

        <p className="mt-4 text-sm text-muted-foreground">
          Your inventory is stored locally on this device. Rescue it before resetting:
        </p>
        <div className="mt-3">
          <RescueActions />
        </div>

        <Button className="mt-5 w-full" onClick={resetErrorBoundary}>
          Try again
        </Button>
      </Surface>
    </div>
  );
}
