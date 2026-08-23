/**
 * The Settings row that names the companion extension the app is actually talking to
 * (issue #664).
 *
 * The extension has always put its version on the wire and the app has always thrown it away, so
 * a report of "the lookup button does nothing" had nothing to reach the cause with: an extension
 * a generation behind is silent by design (§9.1 drops an unrecognised message without logging),
 * which is indistinguishable from no extension at all. This is where the negotiated numbers
 * become visible — the build version for a bug report, the wire generation for the capability
 * gating, and a plain instruction when the peer is too old to work with.
 */
import { Banner } from '@/components/foundry';
import { WarningIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { useScrapeBridgeStatus } from '@/features/scraping';
import { SettingRow } from './SettingsSection';

export function CompanionExtensionStatus() {
  const t = useT();
  const { ready, peer, peerOutdated } = useScrapeBridgeStatus();

  const status = !ready
    ? t('scraping.extension.status.absent')
    : peerOutdated
      ? t('scraping.extension.status.outdated')
      : t('scraping.extension.status.connected');

  // The version is the extension's own build number; the generation is the wire contract it
  // speaks. Both are shown because they answer different questions — "which build have I got"
  // and "which capabilities does this app get from it".
  const description = !ready
    ? t('scraping.extension.description.absent')
    : t('scraping.extension.description.connected', {
        vars: {
          version: peer?.version ?? t('scraping.extension.unknownVersion'),
          protocol: String(peer?.protocol ?? ''),
        },
      });

  return (
    <>
      <SettingRow
        label={t('scraping.extension.label')}
        description={description}
        hintSize="md"
        hint={t('scraping.extension.hint')}
      >
        <span
          data-testid="companion-extension-status"
          className={
            peerOutdated
              ? 'rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning'
              : ready
                ? 'rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success'
                : 'rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground'
          }
        >
          {status}
        </span>
      </SettingRow>
      {peerOutdated ? (
        <Banner
          tone="warning"
          className="mt-3"
          icon={<WarningIcon className="size-4" aria-hidden />}
          heading={t('scraping.extension.outdated.heading')}
        >
          {t('scraping.extension.outdated.body')}
        </Banner>
      ) : null}
    </>
  );
}
