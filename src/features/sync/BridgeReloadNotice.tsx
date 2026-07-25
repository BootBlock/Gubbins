import { useEffect, useMemo, useState } from 'react';
import { Banner, Button } from '@/components/foundry';
import { InfoIcon } from '@/components/icons';
import { toCspOrigin } from '@/csp';
import { useT } from '@/features/i18n';
import {
  documentAllowsBridgeOrigin,
  hasServiceWorkerControl,
  registerBridgeOrigin,
} from '@/lib/bridge-connect-policy';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/**
 * "Reload to connect to this bridge" — the one visible consequence of issue #385's fix.
 *
 * The app may only fetch origins its Content-Security-Policy names, and the bridge lives at an
 * address only the user knows. The service worker adds that origin to the policy (see
 * `src/csp.ts`), but a policy is fixed when the document loads — so a bridge configured *this*
 * session is still blocked until the next one, and a browser reports that block to JavaScript as
 * an indistinguishable network failure. Left alone it reads as "the bridge is offline", which is
 * precisely the misdiagnosis the issue was filed about.
 *
 * So the app checks the policy it is actually running under, and where the address cannot yet be
 * reached says so plainly and offers the reload that fixes it, rather than letting the user go
 * looking for a fault in a bridge that is running perfectly well. It renders nothing at all in
 * the ordinary case: no bridge configured, an origin the policy already covers (including a
 * bridge sharing the app's own origin), or a dev server enforcing no policy.
 */
/** How long the bridge address must sit still before it is worth telling the worker about. */
const REGISTER_DEBOUNCE_MS = 600;

export function BridgeReloadNotice({ className }: { className?: string }) {
  const t = useT();
  const bridgeUrl = usePreferencesStore((s) => s.bridgeUrl);
  const origin = useMemo(() => toCspOrigin(bridgeUrl), [bridgeUrl]);
  const [reloading, setReloading] = useState(false);
  // The policy a document enforces is fixed for its lifetime, so this is settled per origin —
  // no need to re-read the meta tag on every render.
  const blocked = useMemo(
    () => origin !== null && hasServiceWorkerControl() && !documentAllowsBridgeOrigin(origin),
    [origin],
  );

  // Register with the worker as soon as an origin is known, not only when the button is
  // pressed: a user who never sees this notice — because they reload, reopen the app, or the
  // origin was already registered — should simply find the bridge working.
  //
  // Debounced, because the address is a controlled text field: every keystroke past `http://a`
  // parses as a *valid but different* origin, so registering eagerly would post a message and
  // write to CacheStorage once per character typed. The reload button below registers directly,
  // so pressing it never waits on this.
  useEffect(() => {
    const timer = setTimeout(() => void registerBridgeOrigin(origin), REGISTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [origin]);

  // `blocked` already covers "no worker in control": without one no reload would widen the
  // policy, so a notice would be a nag pointing at a fix that does not exist.
  if (origin === null || !blocked) return null;

  const reload = (): void => {
    setReloading(true);
    // Reload only once the worker confirms it has stored the origin — reloading first would
    // serve the old policy and ask for a second reload.
    void registerBridgeOrigin(origin).finally(() => window.location.reload());
  };

  return (
    <Banner
      tone="info"
      className={className}
      icon={<InfoIcon aria-hidden="true" />}
      heading={t('sync.bridge.connect.reload.heading')}
      action={
        <Button variant="outline" onClick={reload} disabled={reloading} data-testid="bridge-reload">
          {t('sync.bridge.connect.reload.action')}
        </Button>
      }
      data-testid="bridge-reload-notice"
    >
      {t('sync.bridge.connect.reload.body', { vars: { origin } })}
    </Banner>
  );
}
