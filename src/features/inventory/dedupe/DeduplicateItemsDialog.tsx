/**
 * The **Deduplicate items** dialog (Settings → Inventory → Deduplicate).
 *
 * Three steps, in the order the user actually thinks in:
 *
 * 1. **Choose what counts as a duplicate.** Four exact signals and one fuzzy one, each a tick
 *    box. Nothing is scanned until they press Scan — the tool never runs on its own, and never
 *    on a schedule.
 * 2. **Read what it found.** Each cluster is one card: its members, why they were grouped, and
 *    how many things elsewhere point at each of them, so a user can see what a removal would
 *    strand *before* choosing.
 * 3. **Decide, per cluster.** One member is kept — the tool proposes the one holding the most
 *    stock, and the choice is the user's — and each other member can be ticked for removal.
 *    Anything referring to a removed member is re-pointed at the kept one, which is what makes
 *    the removal safe rather than merely tidy. That re-pointing can be turned off for a cluster
 *    the user decides is not really duplicated after all.
 *
 * Nothing is applied across the whole result at once. Each cluster is merged by its own button,
 * because the judgement that two records are one thing is a judgement about *those* records, and
 * a single Apply-all would collect a hundred such judgements behind one press.
 *
 * What a merge does — and does not — is stated on the card before it is pressed: the removed item
 * is **marked as removed**, exactly as the ordinary Delete action does, so its stock, photos and
 * Activity Log stay with it and Restore brings it back. The re-pointing is not undone by that
 * restore, which is the one asymmetry the user has to know about, so it is said plainly rather
 * than left to be discovered.
 */
import { useState } from 'react';
import {
  Banner,
  Button,
  Checkbox,
  Modal,
  Radio,
  Select,
  Spinner,
  Surface,
  useToast,
} from '@/components/foundry';
import { MergeIcon, SearchIcon, SuccessIcon, WarningIcon } from '@/components/icons';
import {
  emptyItemReferenceCounts,
  totalItemReferences,
  type DuplicateScanItem,
  type ItemReferenceCounts,
} from '@/db/repositories';
import { useT, type TypedTranslator } from '@/features/i18n';
import { itemDisplayName } from '../item-display';
import { useDuplicateScan, useItemReferenceCounts } from '../queries';
import { useMergeItems } from '../mutations';
import {
  DEFAULT_DUPLICATE_SIGNALS,
  DEFAULT_SIMILARITY_THRESHOLD,
  DUPLICATE_SIGNALS,
  suggestKeeper,
  type DuplicateGroup,
  type DuplicateScanOptions,
  type DuplicateSignal,
} from './duplicate-groups';

interface DeduplicateItemsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * The most clusters rendered at once. A scan of a badly-duplicated inventory can return
 * thousands, and a list that long is neither reviewable nor cheap to render; the dialog says how
 * many it is showing out of how many it found rather than quietly truncating.
 */
const MAX_GROUPS_SHOWN = 100;

/**
 * The similarity thresholds the fuzzy signal offers, loosest first, each under a name rather
 * than its number: `0.75` means nothing to a user, and "Loose" says what changes.
 */
const THRESHOLD_OPTIONS = [
  { id: 'loose', value: 0.75 },
  { id: 'balanced', value: DEFAULT_SIMILARITY_THRESHOLD },
  { id: 'strict', value: 0.95 },
] as const;

/** What happened when one cluster was merged. */
interface GroupOutcome {
  readonly merged: number;
  readonly failed: number;
  readonly discarded: number;
  readonly demoted: number;
}

/** Which member is kept, which are removed, and whether references follow. */
interface GroupChoice {
  readonly keepId: string;
  readonly removeIds: readonly string[];
  readonly remapReferences: boolean;
}

function defaultChoice(group: DuplicateGroup<DuplicateScanItem>): GroupChoice {
  const keepId = suggestKeeper(group.members)!.id;
  return {
    keepId,
    removeIds: group.members.filter((m) => m.id !== keepId).map((m) => m.id),
    remapReferences: true,
  };
}

export function DeduplicateItemsDialog({ open, onClose }: DeduplicateItemsDialogProps) {
  const t = useT();
  const { show } = useToast();
  const merge = useMergeItems();

  const [signals, setSignals] = useState<readonly DuplicateSignal[]>(DEFAULT_DUPLICATE_SIGNALS);
  const [threshold, setThreshold] = useState<number>(DEFAULT_SIMILARITY_THRESHOLD);
  // `null` until the user presses Scan: the read walks the active items, so it must never happen
  // just because the dialog opened.
  const [scan, setScan] = useState<DuplicateScanOptions | null>(null);
  const [choices, setChoices] = useState<Record<string, GroupChoice>>({});
  const [outcomes, setOutcomes] = useState<Record<string, GroupOutcome>>({});
  const [running, setRunning] = useState<string | null>(null);

  const result = useDuplicateScan(scan);
  const groups = (result.data?.groups ?? []).slice(0, MAX_GROUPS_SHOWN);
  const references = useItemReferenceCounts(groups.flatMap((g) => g.members.map((m) => m.id)));

  const busy = running !== null;
  const choiceFor = (group: DuplicateGroup<DuplicateScanItem>) => choices[group.id] ?? defaultChoice(group);

  const setChoice = (group: DuplicateGroup<DuplicateScanItem>, next: Partial<GroupChoice>) => {
    setChoices((prev) => ({ ...prev, [group.id]: { ...choiceFor(group), ...next } }));
  };

  const toggleSignal = (signal: DuplicateSignal, on: boolean) => {
    setSignals((prev) =>
      on
        ? DUPLICATE_SIGNALS.filter((s) => s === signal || prev.includes(s))
        : prev.filter((s) => s !== signal),
    );
  };

  function startScan() {
    setChoices({});
    setOutcomes({});
    const options: DuplicateScanOptions = { signals, similarityThreshold: threshold };
    // Re-scanning with the same options changes the key not at all, so ask the query itself.
    if (scan && scan.signals.join() === signals.join() && scan.similarityThreshold === threshold) {
      void result.refetch();
    } else {
      setScan(options);
    }
  }

  async function mergeGroup(group: DuplicateGroup<DuplicateScanItem>) {
    const choice = choiceFor(group);
    const keeper = group.members.find((m) => m.id === choice.keepId);
    if (!keeper || choice.removeIds.length === 0) return;

    setRunning(group.id);
    let outcome: GroupOutcome = { merged: 0, failed: 0, discarded: 0, demoted: 0 };
    for (const removeId of choice.removeIds) {
      try {
        const merged = await merge.mutateAsync({
          keepId: choice.keepId,
          removeId,
          remapReferences: choice.remapReferences,
        });
        outcome = {
          ...outcome,
          merged: outcome.merged + 1,
          discarded: outcome.discarded + totalItemReferences(merged.discarded),
          demoted: outcome.demoted + merged.demotedSupplierFlags,
        };
      } catch {
        // One member failing must not abandon the rest of the cluster; the tally reports it and
        // `useMergeItems` has already surfaced the reason.
        outcome = { ...outcome, failed: outcome.failed + 1 };
      }
    }
    setOutcomes((prev) => ({ ...prev, [group.id]: outcome }));
    setRunning(null);
    // A run where nothing merged is not a merge, so it is neither headed nor toned as one.
    show(
      outcome.merged === 0
        ? {
            tone: 'danger',
            icon: <WarningIcon />,
            heading: t('inventory.dedupe.toast.noneHeading'),
            message: t('inventory.dedupe.group.failed', { vars: { count: outcome.failed } }),
          }
        : {
            tone: outcome.failed > 0 ? 'warning' : 'success',
            icon: outcome.failed > 0 ? <WarningIcon /> : <SuccessIcon />,
            heading: t('inventory.dedupe.toast.heading', {
              vars: { name: itemDisplayName(keeper.name, keeper.serialNo) },
            }),
            message: t('inventory.dedupe.toast.message', { vars: { count: outcome.merged } }),
          },
    );
  }

  const found = result.data?.groups.length ?? 0;

  return (
    <Modal open={open} onClose={onClose} title={t('inventory.dedupe.title')} busy={busy}>
      <div className="space-y-4">
        <Surface className="space-y-3 p-4">
          <fieldset>
            <legend className="mb-field-gap text-sm font-medium">
              {t('inventory.dedupe.signals.legend')}
            </legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {DUPLICATE_SIGNALS.map((signal) => (
                <label key={signal} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={signals.includes(signal)}
                    disabled={busy}
                    data-testid={`dedupe-signal-${signal}`}
                    onChange={(e) => toggleSignal(signal, e.target.checked)}
                  />
                  {t(`inventory.dedupe.signal.${signal}`)}
                </label>
              ))}
            </div>
          </fieldset>

          {signals.includes('similar-name') ? (
            <div className="flex items-center gap-2 text-sm">
              <label htmlFor="dedupe-threshold">{t('inventory.dedupe.threshold.label')}</label>
              <Select
                id="dedupe-threshold"
                className="h-9 w-44"
                value={String(threshold)}
                disabled={busy}
                onChange={(value) => setThreshold(Number(value))}
                options={THRESHOLD_OPTIONS.map((option) => ({
                  value: String(option.value),
                  label: t(`inventory.dedupe.threshold.option.${option.id}`),
                }))}
              />
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              disabled={busy || signals.length === 0 || result.isFetching}
              data-testid="dedupe-scan"
              onClick={startScan}
            >
              {result.isFetching ? <Spinner /> : <SearchIcon />}
              {t('inventory.dedupe.scan')}
            </Button>
            {signals.length === 0 ? (
              <span className="text-sm text-muted-foreground">{t('inventory.dedupe.noSignals')}</span>
            ) : null}
          </div>
        </Surface>

        {result.isError ? (
          <Banner tone="danger" role="alert">
            {t('inventory.dedupe.error')}
          </Banner>
        ) : /* A re-scan with the *same* options keeps the previous result on screen while it
               refetches, and the choices and outcomes have already been cleared — which would
               put an enabled Merge button back on a card whose items are already gone. The
               result belongs to the scan that produced it, so it goes away with it. */
        result.isFetching ? (
          <p className="text-sm text-muted-foreground">{t('inventory.dedupe.scanning')}</p>
        ) : result.data ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground" data-testid="dedupe-summary">
              {t('inventory.dedupe.summary', {
                vars: { count: found, scanned: result.data.scanned, total: result.data.total },
              })}
            </p>
            {result.data.truncated ? (
              <Banner tone="warning">
                {t('inventory.dedupe.truncated', {
                  vars: { scanned: result.data.scanned, total: result.data.total },
                })}
              </Banner>
            ) : null}
            {found > MAX_GROUPS_SHOWN ? (
              <Banner tone="info">
                {t('inventory.dedupe.tooManyGroups', {
                  vars: { shown: MAX_GROUPS_SHOWN, found },
                })}
              </Banner>
            ) : null}
            {groups.map((group) => (
              <GroupCard
                key={group.id}
                t={t}
                group={group}
                choice={choiceFor(group)}
                references={references.data}
                outcome={outcomes[group.id]}
                busy={busy}
                running={running === group.id}
                onChange={(next) => setChoice(group, next)}
                onMerge={() => void mergeGroup(group)}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('inventory.dedupe.idle')}</p>
        )}
      </div>
    </Modal>
  );
}

function GroupCard({
  t,
  group,
  choice,
  references,
  outcome,
  busy,
  running,
  onChange,
  onMerge,
}: {
  readonly t: TypedTranslator;
  readonly group: DuplicateGroup<DuplicateScanItem>;
  readonly choice: GroupChoice;
  readonly references: Map<string, ItemReferenceCounts> | undefined;
  readonly outcome: GroupOutcome | undefined;
  readonly busy: boolean;
  readonly running: boolean;
  readonly onChange: (next: Partial<GroupChoice>) => void;
  readonly onMerge: () => void;
}) {
  const keeper = group.members.find((m) => m.id === choice.keepId);
  const reason = group.signals.map((s) => t(`inventory.dedupe.signal.${s}`)).join(', ');
  // Once something has actually merged, the card becomes a record of what happened rather than a
  // control: the members it names no longer describe the database, and re-merging them would be a
  // second decision made on a stale reading. A run where *nothing* merged is a different thing —
  // the database is as it was, so the controls stay and the user can try again beside the reason.
  const done = (outcome?.merged ?? 0) > 0;

  return (
    <Surface className="space-y-3 p-4" data-testid="dedupe-group">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {t('inventory.dedupe.group.heading', { vars: { count: group.members.length } })}
        </h3>
        <span className="text-xs text-muted-foreground">
          {t('inventory.dedupe.group.matchedOn', { vars: { reason } })}
        </span>
      </div>

      <div role="radiogroup" aria-label={t('inventory.dedupe.group.keepLabel')} className="space-y-1">
        {group.members.map((member) => {
          const counts = references?.get(member.id) ?? emptyItemReferenceCounts();
          const total = totalItemReferences(counts);
          const isKeeper = member.id === choice.keepId;
          return (
            <div key={member.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 text-sm">
              <label className="flex items-center gap-2">
                <Radio
                  name={`dedupe-keep-${group.id}`}
                  checked={isKeeper}
                  disabled={busy || done}
                  data-testid="dedupe-keep"
                  onChange={() =>
                    onChange({
                      keepId: member.id,
                      removeIds: group.members.filter((m) => m.id !== member.id).map((m) => m.id),
                    })
                  }
                />
                <span className="sr-only">
                  {t('inventory.dedupe.group.keepOption', {
                    vars: { name: itemDisplayName(member.name, member.serialNo) },
                  })}
                </span>
              </label>
              {isKeeper ? null : (
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={choice.removeIds.includes(member.id)}
                    disabled={busy || done}
                    data-testid="dedupe-remove"
                    onChange={(e) =>
                      onChange({
                        removeIds: e.target.checked
                          ? [...choice.removeIds, member.id]
                          : choice.removeIds.filter((id) => id !== member.id),
                      })
                    }
                  />
                  <span className="sr-only">
                    {t('inventory.dedupe.group.removeOption', {
                      vars: { name: itemDisplayName(member.name, member.serialNo) },
                    })}
                  </span>
                </label>
              )}
              {/* With its short number, because every member of a group shares a name — often
                  exactly — and the number is the only thing on the row that tells two of them
                  apart the way the rest of the app does. */}
              <span className="min-w-0 flex-1 truncate font-medium">
                {itemDisplayName(member.name, member.serialNo)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('inventory.dedupe.member.stock', {
                  vars: {
                    quantity: member.quantity,
                    location: member.locationName ?? t('inventory.dedupe.member.noLocation'),
                  },
                })}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('inventory.dedupe.member.references', { vars: { count: total } })}
              </span>
            </div>
          );
        })}
      </div>

      {outcome ? (
        <div className="space-y-1 text-sm" data-testid="dedupe-group-outcome">
          {/* Each loss gets its own line rather than a clause: a discarded link and a demoted
              flag are different things, and a sentence that lists both is read as neither. */}
          {outcome.merged > 0 ? (
            <p className="text-glyph-success">
              {t('inventory.dedupe.group.outcome', { vars: { count: outcome.merged } })}
            </p>
          ) : null}
          {outcome.failed > 0 ? (
            <p className="text-warning">
              {t('inventory.dedupe.group.failed', { vars: { count: outcome.failed } })}
            </p>
          ) : null}
          {outcome.discarded > 0 ? (
            <p className="text-muted-foreground">
              {t('inventory.dedupe.group.discarded', { vars: { count: outcome.discarded } })}
            </p>
          ) : null}
          {outcome.demoted > 0 ? (
            <p className="text-muted-foreground">
              {t('inventory.dedupe.group.demoted', { vars: { count: outcome.demoted } })}
            </p>
          ) : null}
        </div>
      ) : null}

      {done ? null : (
        <>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={choice.remapReferences}
              disabled={busy}
              data-testid="dedupe-remap"
              onChange={(e) => onChange({ remapReferences: e.target.checked })}
            />
            <span>
              {t('inventory.dedupe.group.remap')}
              <span className="block text-xs text-muted-foreground">
                {t('inventory.dedupe.group.remapHint')}
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="destructive"
              disabled={busy || choice.removeIds.length === 0 || !keeper}
              data-testid="dedupe-merge"
              onClick={onMerge}
            >
              {running ? <Spinner /> : <MergeIcon />}
              {t('inventory.dedupe.group.merge', {
                vars: {
                  count: choice.removeIds.length,
                  name: keeper ? itemDisplayName(keeper.name, keeper.serialNo) : '',
                },
              })}
            </Button>
            <span className="text-xs text-muted-foreground">{t('inventory.dedupe.group.warning')}</span>
          </div>
        </>
      )}
    </Surface>
  );
}
