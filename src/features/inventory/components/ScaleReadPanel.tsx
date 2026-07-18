import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, FormField, Select } from '@/components/foundry';
import { RefreshIcon, ScaleIcon, WarningIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { fetchScaleEntities, fetchScaleReading, type ScaleEntity } from '../scale-reading';
import {
  forgetCachedScaleEntities,
  getCachedScaleEntities,
  setCachedScaleEntities,
} from '../scale-entity-cache';

/**
 * Which weight field a reading is destined for. Both come off the *same* scale and the same
 * entity — weighing an empty tray is the same operation as weighing the parts in it — so the
 * panel offers two buttons over one selected sensor rather than two separate pickers.
 */
export type ScaleReadTarget = 'gross' | 'tare';

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
export function ScaleReadPanel({
  onReading,
}: {
  onReading: (grams: number, label: string, target: ScaleReadTarget) => void;
}) {
  const t = useT();
  const bridgeUrl = usePreferencesStore((s) => s.bridgeUrl);
  const bridgeToken = usePreferencesStore((s) => s.bridgeToken);
  const scaleEntityId = usePreferencesStore((s) => s.scaleEntityId);
  const setScaleEntityId = usePreferencesStore((s) => s.setScaleEntityId);

  const [entities, setEntities] = useState<readonly ScaleEntity[] | null>(null);
  /** Which field the in-flight read is for, so only that button shows the spinner. */
  const [reading, setReading] = useState<ScaleReadTarget | null>(null);
  const [listing, setListing] = useState(false);
  /** Bumped by the refresh control to re-run the listing effect after the cache is dropped. */
  const [listAttempt, setListAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Monotonic id of the newest read, so a superseded response can be discarded. */
  const latestAttempt = useRef(0);
  /**
   * Whether a usable list is already on screen. Read from the async listing callback, so it is a
   * ref rather than state: it decides whether a *failed* refresh reports itself (there is a panel
   * to report into) or quietly leaves the panel hidden (there never was one).
   */
  const listed = useRef(false);
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
  // realistically change mid-session. The refresh control below drops that entry on demand, for
  // the one case the cache gets wrong: a scale added in Home Assistant just now.
  useEffect(() => {
    if (!configured) return;
    const cached = getCachedScaleEntities(bridgeUrl);
    if (cached) {
      listed.current = cached.length > 0;
      setEntities(cached);
      // Cleared here too: switching to an already-cached bridge mid-fetch would otherwise leave
      // the refresh control disabled by a listing that no longer has anywhere to land.
      setListing(false);
      return;
    }

    let cancelled = false;
    setListing(true);
    void (async () => {
      const result = await fetchScaleEntities({
        baseUrl: bridgeUrl,
        token: bridgeToken,
        fetchImpl: (url, init) => fetch(url, init),
      });
      if (cancelled) return;
      setListing(false);
      if (result.ok) {
        // Only a successful listing is cached. A failure may be transient (the bridge was still
        // starting), and caching it would hide the feature for the rest of the session.
        setCachedScaleEntities(bridgeUrl, result.entities);
        listed.current = result.entities.length > 0;
        setEntities(result.entities);
        return;
      }
      // A *failed* listing must not overwrite a list we already have. Doing so would take the
      // whole panel off the screen — refresh control included — because one refresh happened to
      // land while the bridge blipped, stranding the user with no way to try again. The first
      // listing is different: there is nothing to keep, and an empty list is what hides a panel
      // that was never usable — and, being invisible, has nothing to report a failure to.
      if (listed.current) {
        setError(t(`inventory.weighCount.scaleFailure.${result.failure}`));
        return;
      }
      setEntities([]);
    })();
    return () => {
      cancelled = true;
    };
    // `listAttempt` is the refresh trigger: the handler drops the cache entry, then bumps it.
    // `t` only reports a failed *refresh*; a language change re-runs this, but by then the list is
    // cached and the effect returns on the first line.
  }, [configured, bridgeUrl, bridgeToken, listAttempt, t]);

  const refreshEntities = useCallback(() => {
    forgetCachedScaleEntities(bridgeUrl);
    setError(null);
    setListAttempt((attempt) => attempt + 1);
  }, [bridgeUrl]);

  const read = useCallback(
    async (target: ScaleReadTarget) => {
      setReading(target);
      setError(null);
      // Stamp this attempt so a response that lands after the dialog closed — or after a newer
      // click superseded it — is dropped rather than overwriting a fresher reading. The stamp is
      // shared across both targets on purpose: reading the container supersedes an in-flight
      // gross read, because the scale can only be holding one of them.
      const attempt = ++latestAttempt.current;
      const result = await fetchScaleReading(
        { baseUrl: bridgeUrl, token: bridgeToken, fetchImpl: (url, init) => fetch(url, init) },
        scaleEntityId,
      );
      if (attempt !== latestAttempt.current || !mounted.current) return;
      setReading(null);
      if (!result.ok) {
        // The transport reports a machine-readable reason; the words are chosen here, inside the
        // i18n seam, so a failure is explained in the user's language.
        setError(t(`inventory.weighCount.scaleFailure.${result.failure}`));
        return;
      }
      // Hand back grams (canonical) plus the reading as the sensor actually phrased it, so the
      // dialog can say "read 1.25 kg from the scale" rather than restating a converted number.
      onReading(result.grams, `${result.value} ${result.unit}`, target);
    },
    [bridgeUrl, bridgeToken, scaleEntityId, onReading, t],
  );

  // Nothing usable here — stay out of the way entirely (see the component note).
  if (!configured || entities === null || entities.length === 0) return null;

  // A previously-chosen scale that Home Assistant no longer reports (renamed or removed) must not
  // silently read from the wrong sensor, so treat it as unchosen and make the user pick again.
  const known = entities.some((entity) => entity.entityId === scaleEntityId);
  const selected = known ? scaleEntityId : '';

  return (
    <div className="mb-4 rounded-xl border border-border bg-secondary/30 p-4">
      <div className="flex flex-col gap-field-gap-compact sm:flex-row sm:items-end sm:gap-3">
        {/* The refresh control is a *sibling* of the FormField, never a child of it: FormField
            wraps its child in a `<label>`, and a button nested there would fold its own name into
            the picker's accessible name and take the label's click-forwarding with it. */}
        <div className="flex flex-1 items-end gap-2">
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
          {/* The list is cached for the session, so a scale added in Home Assistant a moment
              ago would otherwise need a page reload to appear. Icon-only, so it needs a label. */}
          <Button
            variant="ghost"
            aria-label={t('inventory.weighCount.scaleRefresh')}
            onClick={refreshEntities}
            disabled={listing}
            data-testid="scale-refresh"
          >
            <RefreshIcon aria-hidden className={listing ? 'animate-spin' : undefined} />
          </Button>
        </div>
        {/* Two targets, one sensor: weighing the empty container is the same operation as
            weighing the parts, so the tare no longer has to be typed when a scale is connected. */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => void read('gross')}
            disabled={selected === '' || reading !== null}
            data-testid="scale-read"
          >
            {reading === 'gross' ? (
              <RefreshIcon aria-hidden className="animate-spin" />
            ) : (
              <ScaleIcon aria-hidden />
            )}
            {reading === 'gross'
              ? t('inventory.weighCount.scaleReading')
              : t('inventory.weighCount.scaleRead')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void read('tare')}
            disabled={selected === '' || reading !== null}
            data-testid="scale-read-tare"
          >
            {reading === 'tare' ? (
              <RefreshIcon aria-hidden className="animate-spin" />
            ) : (
              <ScaleIcon aria-hidden />
            )}
            {reading === 'tare'
              ? t('inventory.weighCount.scaleReading')
              : t('inventory.weighCount.scaleReadTare')}
          </Button>
        </div>
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
