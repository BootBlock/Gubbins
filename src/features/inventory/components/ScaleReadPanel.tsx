import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, FormField, Select } from '@/components/foundry';
import { RefreshIcon, ScaleIcon, WarningIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { fetchScaleEntities, fetchScaleReading, type ScaleEntity } from '../scale-reading';
import { getCachedScaleEntities, setCachedScaleEntities } from '../scale-entity-cache';

/**
 * "Read the scale" — the Home Assistant half of counting by weight (issue #122).
 *
 * Sits above the manual weight fields in {@link WeighCountDialog} and fills the gross-weight
 * field from a Home Assistant scale entity, via the bridge. It is deliberately **additive**:
 * manual entry is untouched and remains the default, so anyone without Home Assistant — or with
 * a scale that isn't connected to it — sees nothing new. It reports the reading upward in
 * canonical grams and never touches the count, tare or delta itself.
 *
 * The panel **hides itself entirely** unless it can actually be used: no bridge configured, a
 * bridge without the Home Assistant opt-in (`404`), or an instance with no weight sensors all
 * collapse to nothing rather than showing a dead control the user can't fix from here. A
 * *transient* failure (the bridge is down, the scale is unavailable) is different — that is
 * surfaced, because the user asked for a reading and deserves to know why they didn't get one.
 */
export function ScaleReadPanel({ onReading }: { onReading: (grams: number, label: string) => void }) {
  const t = useT();
  const bridgeUrl = usePreferencesStore((s) => s.bridgeUrl);
  const bridgeToken = usePreferencesStore((s) => s.bridgeToken);
  const scaleEntityId = usePreferencesStore((s) => s.scaleEntityId);
  const setScaleEntityId = usePreferencesStore((s) => s.setScaleEntityId);

  const [entities, setEntities] = useState<readonly ScaleEntity[] | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Monotonic id of the newest read, so a superseded response can be discarded. */
  const latestAttempt = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const configured = bridgeUrl.trim() !== '' && bridgeToken.trim() !== '';

  // Discover the available scales when the dialog opens. This doubles as the capability probe: a
  // bridge without `GUBBINS_BRIDGE_HA=on` answers 404, which leaves `entities` empty and takes the
  // whole panel off the screen — so the button never appears where it couldn't work.
  //
  // The result is cached per bridge for the session (see `scale-entity-cache`). The bridge answers
  // this by pulling Home Assistant's *entire* entity list, so refetching it on every dialog open —
  // while counting a run of items — would be a lot of traffic for a set of scales that does not
  // realistically change mid-session.
  useEffect(() => {
    if (!configured) return;
    const cached = getCachedScaleEntities(bridgeUrl);
    if (cached) {
      setEntities(cached);
      return;
    }

    let cancelled = false;
    void (async () => {
      const result = await fetchScaleEntities({
        baseUrl: bridgeUrl,
        token: bridgeToken,
        fetchImpl: (url, init) => fetch(url, init),
      });
      if (cancelled) return;
      const resolved = result.ok ? result.entities : [];
      // Only a successful listing is cached. A failure may be transient (the bridge was still
      // starting), and caching it would hide the feature for the rest of the session.
      if (result.ok) setCachedScaleEntities(bridgeUrl, resolved);
      setEntities(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [configured, bridgeUrl, bridgeToken]);

  const read = useCallback(async () => {
    setReading(true);
    setError(null);
    // Stamp this attempt so a response that lands after the dialog closed — or after a newer
    // click superseded it — is dropped rather than overwriting a fresher reading.
    const attempt = ++latestAttempt.current;
    const result = await fetchScaleReading(
      { baseUrl: bridgeUrl, token: bridgeToken, fetchImpl: (url, init) => fetch(url, init) },
      scaleEntityId,
    );
    if (attempt !== latestAttempt.current || !mounted.current) return;
    setReading(false);
    if (!result.ok) {
      // The transport reports a machine-readable reason; the words are chosen here, inside the
      // i18n seam, so a failure is explained in the user's language.
      setError(t(`inventory.weighCount.scaleFailure.${result.failure}`));
      return;
    }
    // Hand back grams (canonical) plus the reading as the sensor actually phrased it, so the
    // dialog can say "read 1.25 kg from the scale" rather than restating a converted number.
    onReading(result.grams, `${result.value} ${result.unit}`);
  }, [bridgeUrl, bridgeToken, scaleEntityId, onReading, t]);

  // Nothing usable here — stay out of the way entirely (see the component note).
  if (!configured || entities === null || entities.length === 0) return null;

  // A previously-chosen scale that Home Assistant no longer reports (renamed or removed) must not
  // silently read from the wrong sensor, so treat it as unchosen and make the user pick again.
  const known = entities.some((entity) => entity.entityId === scaleEntityId);
  const selected = known ? scaleEntityId : '';

  return (
    <div className="mb-4 rounded-xl border border-border bg-secondary/30 p-4">
      <div className="flex flex-col gap-field-gap-compact sm:flex-row sm:items-end sm:gap-3">
        <FormField label={t('inventory.weighCount.scaleEntityLabel')} className="flex-1">
          <Select
            value={selected}
            onChange={setScaleEntityId}
            placeholder={t('inventory.weighCount.scaleEntityPlaceholder')}
            options={entities.map((entity) => ({
              value: entity.entityId,
              label: entity.name,
              meta: entity.unit,
            }))}
            data-testid="scale-entity-select"
          />
        </FormField>
        <Button
          variant="secondary"
          onClick={() => void read()}
          disabled={selected === '' || reading}
          data-testid="scale-read"
        >
          {reading ? <RefreshIcon aria-hidden className="animate-spin" /> : <ScaleIcon aria-hidden />}
          {reading ? t('inventory.weighCount.scaleReading') : t('inventory.weighCount.scaleRead')}
        </Button>
      </div>

      {/* `role="alert"`, not the Banner default `status`: this reports the failure of an action
          the user just took, so it must interrupt rather than queue politely — otherwise a
          screen-reader user can carry on believing a reading landed. */}
      {error !== null ? (
        <Banner
          tone="warning"
          role="alert"
          className="mt-3"
          icon={<WarningIcon aria-hidden />}
          data-testid="scale-error"
        >
          {error}
        </Banner>
      ) : null}
    </div>
  );
}
