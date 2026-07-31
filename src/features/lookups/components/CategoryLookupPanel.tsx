/**
 * "Fill from a database" panel (issue #616, phase L1).
 *
 * The affordance that runs a category's lookup against one item, and the one place the whole flow
 * is sequenced: **search → mandatory match picker → detail fetch → review → apply**. Nothing
 * auto-commits at any step, and no step is skippable.
 *
 * It stays **feature-detected**, exactly as `ProductLookupPanel` degrades today — it renders
 * nothing at all when:
 *
 * - the `scraping` capability ("Product & supplier lookup") is off for this device;
 * - the item has no category;
 * - that category has no lookup provider attached that this build can run;
 * - or the provider's inputs aren't satisfiable (an unnamed item cannot be searched for).
 *
 * Two fetch paths, mirroring `ProductLookupPanel`:
 *
 * - **Companion extension present** — the privileged extension performs the request, gated by its
 *   own host allow-list, and hands back the raw body.
 * - **No extension** — the app fetches directly, but only after the user consents to **those
 *   hosts**. Consent is per host and not one global yes: agreeing to query an open film database
 *   is not agreement to query everything.
 */
import { useMemo, useState } from 'react';
import { Button, Modal, Tooltip, useToast } from '@/components/foundry';
import { CloudIcon, DatabaseIcon, SearchIcon, WarningIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useT, type TypedTranslator } from '@/features/i18n';
import { useCategories, useItemFields, useSetItemFieldValues } from '@/features/inventory/categories';
import { useUpdateItem } from '@/features/inventory/mutations';
import { useFeature } from '@/features/modules/useFeature';
import { useScrapeBridge, type ScrapeErrorType } from '@/features/scraping';
import { assertExhaustive } from '@/lib/exhaustive';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { bindLookupOutputs, type BindableField, type LookupBindingSet } from '../binding';
import { buildLookupFillPlan, type LookupFillPlan, type LookupFillWrite } from '../fill-plan';
import { fetchLookupValues, searchLookupCandidates } from '../flow';
import { getLookupRunner, type LookupFetcher, type LookupRunner } from '../runner';
import { resolveLookupSources } from '../sources';
import type { LookupCandidate, LookupFailure, LookupProvider, LookupQuery } from '../types';
import { LookupMatchDialog } from './LookupMatchDialog';
import { LookupReviewDialog } from './LookupReviewDialog';

/**
 * One runnable lookup, with everything the flow needs already resolved against this item — so no
 * step has to re-derive which provider it is working with, or look one up by index.
 */
interface RunnableLookup {
  readonly provider: LookupProvider;
  readonly binding: LookupBindingSet;
  readonly query: LookupQuery;
}

/** Where the flow currently is. One lookup is in flight at a time, by construction. */
type Stage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searching'; readonly lookup: RunnableLookup }
  | {
      readonly kind: 'choosing';
      readonly lookup: RunnableLookup;
      readonly candidates: readonly LookupCandidate[];
      /** True while the detail fetch for a chosen candidate is in flight. */
      readonly fetching: boolean;
    }
  | { readonly kind: 'reviewing'; readonly lookup: RunnableLookup; readonly plan: LookupFillPlan };

const IDLE: Stage = { kind: 'idle' };

/** Translate a failure code into the sentence the user reads. */
function failureText(
  t: TypedTranslator,
  failure: LookupFailure,
  provider: LookupProvider,
  name: string,
): string {
  const vars = { source: provider.sourceName, status: failure.status ?? 0, name };
  switch (failure.code) {
    case 'NETWORK':
      return t('lookup.error.network', { vars });
    case 'HTTP':
      return t('lookup.error.http', { vars });
    case 'REFUSED':
      return t('lookup.error.refused', { vars });
    case 'UNREADABLE':
      return t('lookup.error.unreadable', { vars });
    case 'NO_MATCHES':
      return t('lookup.error.noMatches', { vars });
    case 'NOT_FOUND':
      return t('lookup.error.notFound', { vars });
    default:
      assertExhaustive(failure.code);
      // A code from an out-of-band source degrades to the generic failure rather than crashing.
      return t('lookup.error.unreadable', { vars });
  }
}

/**
 * Translate the extension's own §9.4.2 outcome into a lookup failure.
 *
 * The extension classifies the HTTP status itself and hands back a *category*, so the precise
 * code is gone by the time it reaches here. Mapped rather than collapsed to `NETWORK`, because a
 * Wikidata rate limit told to the user as "check your connection" is a wrong answer, not a vague
 * one.
 */
function fromExtensionError(errorType: ScrapeErrorType): LookupFailure {
  switch (errorType) {
    case 'NETWORK_TIMEOUT':
      return { code: 'NETWORK' };
    case 'NOT_FOUND':
      return { code: 'NOT_FOUND' };
    case 'DOM_DRIFT':
    case 'CHALLENGE':
      return { code: 'UNREADABLE' };
    case 'RATE_LIMITED':
    case 'BLOCKED':
    case 'SERVER_ERROR':
      return { code: 'REFUSED' };
    default:
      assertExhaustive(errorType);
      return { code: 'REFUSED' };
  }
}

/** A positive whole number out of a stored field value, or null — the item's year, when it has one. */
function yearFrom(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function CategoryLookupPanel({
  item,
  className,
  runner = getLookupRunner(),
}: {
  item: Item;
  className?: string;
  /**
   * The runner that performs the requests. Defaults to the app's shared one — the single queue is
   * what makes a provider's `minIntervalMs` a real limit rather than a per-panel suggestion — and
   * is injectable so a test can drive the flow without waiting out real rate-limit gaps, the same
   * seam `lookupProductOnline` opens with its `fetchImpl`.
   */
  runner?: LookupRunner;
}) {
  const t = useT();
  const scrapingEnabled = useFeature('scraping');
  const bridge = useScrapeBridge();
  const { show } = useToast();
  const consentHosts = usePreferencesStore((s) => s.lookupConsentHosts);
  const setHostConsent = usePreferencesStore((s) => s.setLookupHostConsent);
  const { data: categories } = useCategories();
  const { data: fields, isLoading: fieldsLoading } = useItemFields(item.id);
  const setFieldValues = useSetItemFieldValues(item.id);
  const updateItem = useUpdateItem();

  const [stage, setStage] = useState<Stage>(IDLE);
  const [consentFor, setConsentFor] = useState<LookupProvider | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  const category = useMemo(
    () => categories?.rows.find((row) => row.id === item.categoryId) ?? null,
    [categories, item.categoryId],
  );

  /**
   * Every lookup this build can actually run for this item, resolved end to end.
   *
   * The binding is computed here rather than at click time so the year a provider searches with —
   * read out of whichever field its own `yearOutputKey` bound to — comes from the same resolution
   * the fill plan will later use, instead of a second, possibly-divergent guess.
   */
  const runnable = useMemo<readonly RunnableLookup[]>(() => {
    // `BindableField` is the narrow shape the pure seam wants; a resolved item field satisfies it
    // structurally, so this trims rather than reshapes.
    const bindable: readonly BindableField[] = (fields ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      fieldType: f.fieldType,
      options: f.options,
    }));
    return resolveLookupSources(category?.lookupSources)
      .map(({ provider, fieldMap }) => {
        const binding = bindLookupOutputs(provider.outputs, bindable, fieldMap);
        const yearTarget =
          provider.yearOutputKey === undefined
            ? undefined
            : binding.bindings.find((b) => b.outputKey === provider.yearOutputKey)?.target;
        const year =
          yearTarget?.kind === 'field'
            ? yearFrom(fields?.find((f) => f.id === yearTarget.field.id)?.value)
            : null;
        return { provider, binding, query: { name: item.name, year } };
      })
      .filter(({ provider, query }) => provider.canSearch(query));
  }, [category, fields, item.name]);

  // Nothing to offer: render no control at all rather than a disabled one that can only fail.
  //
  // These three tests must stay in step with the ones the item detail dialog uses to decide
  // whether to emit the section *card* at all (`scraping` + `hasRunnableLookup`), because the card
  // is drawn before its children: any state where the card appears and this returns `null` is an
  // empty card promising a feature that isn't there. An item's name is trimmed and rejected empty
  // on both create and update, so `canSearch` — the fourth term, inside `runnable` — cannot be the
  // one that diverges.
  if (!scrapingEnabled || item.categoryId === null || runnable.length === 0) return null;

  // The item's fields are still arriving. Say so rather than returning `null` (which would leave
  // that empty card) and rather than offering the button (whose binding is resolved against the
  // category's fields — a click now would capture a binding computed from an empty field list, and
  // the review dialog would then report every one of the provider's keys as "there's no such field
  // in this category"). The sibling custom-fields editor on this same tab does exactly this.
  if (fieldsLoading) {
    return (
      <div className={className} data-testid="category-lookup-panel">
        <p className="text-xs text-muted-foreground">{t('lookup.panel.loading')}</p>
      </div>
    );
  }

  /**
   * The extension's privileged fetch, or undefined to fetch directly.
   *
   * A `null` outcome means the extension is present but did not answer (an older build with no
   * `DATA_FETCH_REQUEST` handler): reported as a network failure rather than silently falling back
   * to a direct fetch, because that fallback would cross to the network on a path the user has not
   * consented to.
   */
  const bridgeFetcher: LookupFetcher | undefined = bridge.ready
    ? async (request) => {
        const outcome = await bridge.fetchDataUrl(request.url);
        if (outcome === null) return { ok: false, failure: { code: 'NETWORK' } };
        return outcome.ok
          ? { ok: true, value: outcome.body }
          : { ok: false, failure: fromExtensionError(outcome.error.error_type) };
      }
    : undefined;

  const warn = (message: string) =>
    show({ tone: 'warning', icon: <WarningIcon />, heading: t('lookup.error.heading'), message });

  const runSearch = async (lookup: RunnableLookup) => {
    setStage({ kind: 'searching', lookup });
    const result = await searchLookupCandidates(lookup.provider, lookup.query, runner, bridgeFetcher);
    if (!result.ok) {
      setStage(IDLE);
      warn(failureText(t, result.failure, lookup.provider, lookup.query.name));
      return;
    }
    setStage({ kind: 'choosing', lookup, candidates: result.value, fetching: false });
  };

  /** Prefer the privileged extension; otherwise ask for consent to *these* hosts first. */
  const start = (lookup: RunnableLookup) => {
    const consented = lookup.provider.hosts.every((host) => consentHosts.includes(host.toLowerCase()));
    if (bridge.ready || consented) void runSearch(lookup);
    else setConsentFor(lookup.provider);
  };

  const confirmConsent = () => {
    const provider = consentFor;
    setConsentFor(null);
    if (provider === null) return;
    for (const host of provider.hosts) setHostConsent(host, true);
    const lookup = runnable.find((candidate) => candidate.provider.id === provider.id);
    if (lookup !== undefined) void runSearch(lookup);
  };

  const choose = async (candidate: LookupCandidate) => {
    if (stage.kind !== 'choosing') return;
    const { lookup, candidates } = stage;
    setStage({ kind: 'choosing', lookup, candidates, fetching: true });
    const result = await fetchLookupValues(lookup.provider, candidate.id, runner, bridgeFetcher);
    if (!result.ok) {
      // Back to the picker rather than to idle: the candidate list is still valid, and the user's
      // most likely next move is to try the entry beside the one that had no details.
      setStage({ kind: 'choosing', lookup, candidates, fetching: false });
      warn(failureText(t, result.failure, lookup.provider, candidate.label));
      return;
    }
    const plan = buildLookupFillPlan(lookup.binding.bindings, lookup.binding.problems, result.value, {
      // A field's resolved `value` is its *effective* one — stored, inherited, or the category
      // default — and only the first two are the user's. A field showing a category default is
      // genuinely empty and should fill freely, so `hasStoredValue` decides: it is true for a
      // stored literal *and* for a stored "inherit this from the location" intent (which must
      // still be protected, since overwriting it silently converts the field to a literal), and
      // false only when the value on screen is the category's own default.
      fieldValues: Object.fromEntries((fields ?? []).map((f) => [f.id, f.hasStoredValue ? f.value : null])),
      builtins: { 'builtin:name': item.name, 'builtin:description': item.description },
    });
    setStage({ kind: 'reviewing', lookup, plan });
  };

  const apply = async (write: LookupFillWrite) => {
    setIsApplying(true);
    try {
      const fieldCount = Object.keys(write.fieldValues).length;
      if (fieldCount > 0) await setFieldValues.mutateAsync({ ...write.fieldValues });
      // Spread conditionally rather than passing `undefined`: `useUpdateItem` strips undefined
      // before it patches, but an explicit key is clearer about what the write actually touches.
      const builtinPatch = {
        ...(write.builtins['builtin:name'] !== undefined ? { name: write.builtins['builtin:name'] } : {}),
        ...(write.builtins['builtin:description'] !== undefined
          ? { description: write.builtins['builtin:description'] }
          : {}),
      };
      const builtinCount = Object.keys(builtinPatch).length;
      if (builtinCount > 0) await updateItem.mutateAsync({ id: item.id, input: builtinPatch });
      show({
        tone: 'success',
        message: t('lookup.applied', { vars: { count: fieldCount + builtinCount } }),
      });
      setStage(IDLE);
    } catch {
      // Both mutations already surface their own failure toast through `useReportWriteFailure`, so
      // the dialog simply stays open — the user can retry without losing the plan they reviewed.
    } finally {
      setIsApplying(false);
    }
  };

  const busyFor = (provider: LookupProvider): boolean =>
    (stage.kind === 'searching' && stage.lookup.provider.id === provider.id) ||
    (stage.kind === 'choosing' && stage.fetching && stage.lookup.provider.id === provider.id);

  return (
    <div className={className} data-testid="category-lookup-panel">
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
        <p className="mb-2 flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-primary">
          <DatabaseIcon aria-hidden />
          {t('lookup.panel.title')}
        </p>
        <div className="space-y-2">
          {runnable.map((lookup) => (
            <div key={lookup.provider.id} className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {t('lookup.panel.description', { vars: { source: lookup.provider.sourceName } })}
              </p>
              <Tooltip content={t('lookup.panel.tooltip')} triggerTabIndex={-1}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => start(lookup)}
                  disabled={busyFor(lookup.provider)}
                  className="shrink-0"
                  data-testid={`lookup-start-${lookup.provider.id}`}
                >
                  <SearchIcon className="size-4" aria-hidden />
                  {busyFor(lookup.provider) ? t('lookup.panel.busy') : t('lookup.panel.action')}
                </Button>
              </Tooltip>
            </div>
          ))}
        </div>
      </div>

      {/* One-time, per-host consent before the app itself reaches the network (issue #616). */}
      <Modal
        open={consentFor !== null}
        onClose={() => setConsentFor(null)}
        title={t('lookup.consent.title', { vars: { source: consentFor?.sourceName ?? '' } })}
      >
        <div className="space-y-4">
          <p className="flex gap-2 text-sm text-muted-foreground">
            <CloudIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span>
              {t('lookup.consent.body', {
                vars: {
                  source: consentFor?.sourceName ?? '',
                  hosts: (consentFor?.hosts ?? []).join(', '),
                },
              })}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">{t('lookup.consent.note')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConsentFor(null)} data-testid="lookup-consent-cancel">
              {t('lookup.consent.decline')}
            </Button>
            <Button onClick={confirmConsent} data-testid="lookup-consent-confirm">
              {t('lookup.consent.accept')}
            </Button>
          </div>
        </div>
      </Modal>

      {stage.kind === 'choosing' ? (
        <LookupMatchDialog
          open
          candidates={stage.candidates}
          sourceName={stage.lookup.provider.sourceName}
          itemYear={stage.lookup.query.year}
          onChoose={(candidate) => void choose(candidate)}
          onClose={() => setStage(IDLE)}
          isFetching={stage.fetching}
        />
      ) : null}

      {stage.kind === 'reviewing' ? (
        <LookupReviewDialog
          open
          plan={stage.plan}
          sourceName={stage.lookup.provider.sourceName}
          sourceUrl={stage.lookup.provider.sourceUrl}
          onApply={(write) => void apply(write)}
          onClose={() => setStage(IDLE)}
          isApplying={isApplying}
        />
      ) : null}
    </div>
  );
}
