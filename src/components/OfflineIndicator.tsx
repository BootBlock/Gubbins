import { useEffect, useRef, useState } from 'react';
import { LiveRegion } from '@/components/foundry';
import { useOnlineStatus, type OnlineStatusApi } from '@/components/foundry/useOnlineStatus';
import { OfflineIcon } from '@/components/icons';

/**
 * Global connectivity indicator (spec §2 local-first / offline-first PWA). Gubbins
 * works fully offline, so this is *reassurance*, not a gate: when the browser loses
 * connectivity a subtle pill confirms that edits are still being saved locally, and
 * the transition is announced to assistive tech via an always-mounted
 * {@link LiveRegion} (the silent-status surface WCAG 4.1.3 wants covered). When
 * online — the normal state — nothing visible is shown, so the chrome stays quiet.
 *
 * Connectivity is read through the injectable {@link OnlineStatusApi} seam so this
 * is component-testable with a fake; production mounts it bare in the root layout.
 */
export function OfflineIndicator({ api }: { api?: OnlineStatusApi }) {
  const online = useOnlineStatus(api);
  // Only announce "Back online" if we were actually offline — never on first load.
  const wasOffline = useRef(false);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setAnnouncement('You’re offline. Your changes are saved locally and will sync when you reconnect.');
    } else if (wasOffline.current) {
      setAnnouncement('Back online.');
    }
  }, [online]);

  return (
    <>
      {online ? null : (
        <div
          data-testid="offline-indicator"
          className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full border border-warning/40 bg-warning/15 px-3 py-1.5 text-xs font-medium text-warning shadow-lg backdrop-blur [&_svg]:size-4"
        >
          <OfflineIcon aria-hidden="true" />
          <span>Offline — changes saved locally</span>
        </div>
      )}
      {/* Pre-mounted so a later connectivity change is actually announced (see LiveRegion). */}
      <LiveRegion visuallyHidden>{announcement ? <p>{announcement}</p> : null}</LiveRegion>
    </>
  );
}
