import { lazy, Suspense } from 'react';
import { useShortcutsOverlay } from './useShortcutsOverlay';

/**
 * Lazy chunk boundary for the keyboard-shortcuts cheat sheet, mirroring `SettingsDialogHost`.
 *
 * The sheet is opened occasionally — to learn a key, or to remind yourself of one — so its control
 * tree (a Modal, the registry rendering, the scope registry subscription) has no business sitting
 * in the critical path of every app load. Splitting it here means nothing is fetched or parsed
 * until the first `?`.
 */
const ShortcutsOverlayBody = lazy(() => import('./ShortcutsOverlay'));

/**
 * Mounts the app-wide cheat sheet. Rendered once from the root layout, it watches the shared
 * {@link useShortcutsOverlay} switch and renders nothing at all until the sheet is open — so while
 * closed there is no dialog subtree, no store subscriptions and no loaded chunk.
 */
export function ShortcutsOverlayHost() {
  const open = useShortcutsOverlay((s) => s.open);
  const setOpen = useShortcutsOverlay((s) => s.setOpen);

  if (!open) return null;

  return (
    <Suspense fallback={null}>
      <ShortcutsOverlayBody onClose={() => setOpen(false)} />
    </Suspense>
  );
}
