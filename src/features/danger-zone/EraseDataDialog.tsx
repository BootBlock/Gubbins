/**
 * Erase Data Dialog (Danger Zone, §3).
 *
 * Lets the user selectively wipe specific categories of data from this device — or
 * perform a full factory reset. To keep the dialog a fixed, comfortable size (rather
 * than growing past the viewport as the long list of categories streams in), the
 * categories are split across a **vertical tab rail** down the left-hand side — one tab
 * per `ERASE_SECTIONS` group plus a separated "Erase everything" tab — with the active
 * group's checkboxes in a scrolling panel beside it (the same WAI-ARIA APG `tabs`
 * pattern, vertical orientation, as the Item detail dialog). Selection is global: a
 * category ticked under one tab stays ticked when you switch tabs, and the footer's
 * bottom-left running total reflects everything chosen across all tabs.
 *
 * Labels, tooltips and affected-row counts are read straight from the engine catalog
 * (`ERASE_TARGETS`) so the UI never hard-codes them. Destructive actions use an inline
 * two-click `EraseConfirmRow` (mirroring `StorageTriageDialog`) before calling
 * `eraseTargets`; "Erase everything" calls `hardResetLocalData`, which reloads the page.
 */
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Modal,
  Spinner,
  Tooltip,
  INFO_OPEN_DELAY_MS,
  NAV_OPEN_DELAY_MS,
  useToast,
} from '@/components/foundry';
import {
  CategoryIcon,
  ContactsIcon,
  CriticalIcon,
  DownloadIcon,
  InfoIcon,
  PackageIcon,
  ProjectIcon,
  SettingsIcon,
  WarningIcon,
} from '@/components/icons';
import { cn } from '@/lib/utils';
import { resolveTabKey } from '@/features/inventory/tab-keyboard';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { hardResetLocalData } from '@/app/error/safe-mode-actions';
import {
  ERASE_SECTIONS,
  ERASE_TARGETS,
  browserErasePorts,
  countTargets,
  eraseTargetById,
  eraseTargets,
  type EraseSection,
  type EraseTargetId,
} from '@/features/danger-zone';

/** The synthetic tab id for the factory-reset panel (not an `EraseSection`). */
const EVERYTHING_TAB = 'everything';
type TabId = EraseSection | typeof EVERYTHING_TAB;

/** Which inline confirm panel is currently open. */
type Confirming = 'selected' | 'everything' | null;

/** Per-tab metadata the UI owns (icons/guidance are presentation, not engine concerns). */
const SECTION_TABS: Readonly<Record<EraseSection, { icon: ReactNode; tooltip: string }>> = {
  inventory: {
    icon: <PackageIcon />,
    tooltip:
      'Items and everything attached to them: photos, activity history, checkouts, maintenance, supplier parts, custom-field values and tags.',
  },
  organisation: {
    icon: <CategoryIcon />,
    tooltip: 'Categories with their custom-field schemas, and empty custom locations.',
  },
  projects: {
    icon: <ProjectIcon />,
    tooltip: 'Projects (with their BOMs, budgets and expenses) and purchase orders.',
  },
  contacts: {
    icon: <ContactsIcon />,
    tooltip: 'Contacts and the checkout/loan records that belong to them.',
  },
  local: {
    icon: <SettingsIcon />,
    tooltip:
      'Things stored only on this device: app preferences, dashboard layout, saved searches, dismissed alerts, cloud sign-in and sync links.',
  },
};

const EVERYTHING_TOOLTIP =
  'Factory reset: wipe ALL inventory, photos, settings, sign-in and sync links from this device, then restart the app.';

export interface EraseDataDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function EraseDataDialog({ open, onClose }: EraseDataDialogProps) {
  // Stable ports object — created once per dialog mount so the count query key is stable.
  const [ports] = useState(() => browserErasePorts());

  const [activeTab, setActiveTab] = useState<TabId>(ERASE_SECTIONS[0]!.id);
  const [selected, setSelected] = useState<ReadonlySet<EraseTargetId>>(new Set());
  const [tombstone, setTombstone] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [erasing, setErasing] = useState(false);
  const [resettingAll, setResettingAll] = useState(false);

  const { show } = useToast();
  const queryClient = useQueryClient();

  // Roving-tabindex refs so arrow-key navigation moves DOM focus to the new tab.
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement | null>());

  const tabIds = useMemo<TabId[]>(() => [...ERASE_SECTIONS.map((s) => s.id), EVERYTHING_TAB], []);

  // Fetch affected-row counts for every target once on open (stable query key per mount).
  const allIds = useMemo(() => ERASE_TARGETS.map((t) => t.id), []);
  const countsQuery = useQuery({
    queryKey: ['erase-counts', allIds],
    queryFn: () => countTargets(allIds, ports),
    staleTime: Infinity,
    gcTime: 0,
  });
  const counts = countsQuery.data;

  const selectTab = (id: TabId) => {
    setActiveTab(id);
    // A pending confirm belongs to the tab it was started on — abandon it on a switch.
    setConfirming(null);
    tabRefs.current.get(id)?.focus();
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = resolveTabKey(tabIds, activeTab, e.key) as TabId | null;
    if (next === null) return;
    e.preventDefault();
    selectTab(next);
  };

  const toggleTarget = (id: EraseTargetId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // A target is "covered" when a selected superset already erases it via FK cascade (e.g.
  // "All items" covers item photos, history, checkouts, …). We map each covered id to the
  // label of the superset covering it, so the UI can disable it and explain why.
  const coveredBy = useMemo(() => {
    const map = new Map<EraseTargetId, string>();
    for (const target of ERASE_TARGETS) {
      if (!selected.has(target.id) || !target.includes) continue;
      for (const id of target.includes) if (!map.has(id)) map.set(id, target.label);
    }
    return map;
  }, [selected]);

  // The categories that actually drive the erase: the user's picks minus any subsumed by a
  // selected superset (the superset's cascade removes them, so passing them is redundant and
  // double-counts in the summary).
  const effectiveSelected = useMemo(
    () => [...selected].filter((id) => !coveredBy.has(id)),
    [selected, coveredBy],
  );
  const hasSelection = effectiveSelected.length > 0;

  // How many categories actively drive deletion within each section, for the rail badges.
  const selectedPerSection = useMemo(() => {
    const map = new Map<EraseSection, number>();
    for (const id of effectiveSelected) {
      const section = eraseTargetById(id)?.section;
      if (section) map.set(section, (map.get(section) ?? 0) + 1);
    }
    return map;
  }, [effectiveSelected]);

  // Approximate total records across the effective DB-backed categories (local toggles have
  // no row count, so they are excluded from the record tally).
  const totalRecords = useMemo(() => {
    if (!counts) return 0;
    let total = 0;
    for (const id of effectiveSelected) {
      const target = eraseTargetById(id);
      if (target?.countSql) total += counts[id] ?? 0;
    }
    return total;
  }, [counts, effectiveSelected]);

  async function handleEraseSelected() {
    setConfirming(null);
    setErasing(true);
    try {
      const summary = await eraseTargets(effectiveSelected, { tombstone }, ports);
      await queryClient.invalidateQueries();
      void useStorageStore.getState().refresh();
      setSelected(new Set());
      await queryClient.refetchQueries({ queryKey: ['erase-counts'] });
      const erased = summary.erased.length;
      show({
        tone: 'success',
        icon: <WarningIcon />,
        heading: 'Data erased',
        message: `Erased ${erased} categor${erased === 1 ? 'y' : 'ies'} from this device${
          tombstone ? ' and queued the deletion to sync.' : '.'
        }`,
      });
    } catch {
      show({
        tone: 'danger',
        heading: 'Erase failed',
        message: 'No data was removed. Check the console for details.',
      });
    } finally {
      setErasing(false);
    }
  }

  async function handleEraseEverything() {
    setConfirming(null);
    setResettingAll(true);
    try {
      // hardResetLocalData reloads the page itself — no toast needed.
      await hardResetLocalData();
    } catch {
      show({
        tone: 'danger',
        heading: 'Factory reset failed',
        message: 'Not all data could be removed. Try again from the safe-mode screen.',
      });
      setResettingAll(false);
    }
  }

  const busy = erasing || resettingAll;
  const activeSection = activeTab === EVERYTHING_TAB ? null : activeTab;
  const activeTargets = activeSection ? ERASE_TARGETS.filter((t) => t.section === activeSection) : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Erase data"
      description="Choose exactly what to remove from this device. This can't be undone."
      className="max-w-3xl"
    >
      <div className="flex h-[68vh] flex-col gap-4">
        {/* Backup nudge */}
        <p className="text-sm text-muted-foreground">
          Before erasing, consider{' '}
          <Tooltip
            content="Opens the Cloud & Sync screen, where you can export a full backup or archive of your data before removing anything."
            openDelayMs={INFO_OPEN_DELAY_MS}
          >
            <Link
              to="/sync"
              className="font-medium text-primary underline-offset-2 hover:underline [&_svg]:inline [&_svg]:size-3.5"
            >
              <DownloadIcon /> exporting a backup first &rarr;
            </Link>
          </Tooltip>
        </p>

        {/* Tab rail + scrolling panel (fixed-height frame so the dialog never overgrows) */}
        <div className="flex min-h-0 flex-1 gap-4 sm:gap-5">
          <div
            role="tablist"
            aria-orientation="vertical"
            aria-label="Data categories"
            className="flex w-14 shrink-0 flex-col gap-1 sm:w-52"
          >
            {ERASE_SECTIONS.map((section) => (
              <TabButton
                key={section.id}
                tabId={section.id}
                label={section.label}
                icon={SECTION_TABS[section.id].icon}
                tooltip={SECTION_TABS[section.id].tooltip}
                badge={selectedPerSection.get(section.id)}
                selected={activeTab === section.id}
                onSelect={() => selectTab(section.id)}
                onKeyDown={onTabKeyDown}
                refMap={tabRefs}
              />
            ))}
            <div className="my-1 border-t border-border" aria-hidden />
            <TabButton
              tabId={EVERYTHING_TAB}
              label="Erase everything"
              icon={<CriticalIcon />}
              tooltip={EVERYTHING_TOOLTIP}
              selected={activeTab === EVERYTHING_TAB}
              danger
              onSelect={() => selectTab(EVERYTHING_TAB)}
              onKeyDown={onTabKeyDown}
              refMap={tabRefs}
            />
          </div>

          <div
            role="tabpanel"
            id={`erase-panel-${activeTab}`}
            aria-labelledby={`erase-tab-${activeTab}`}
            tabIndex={0}
            className="min-w-0 flex-1 overflow-y-auto dialog-scroll focus-visible:outline-none"
          >
            {activeSection ? (
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                {activeTargets.map((target) => {
                  const count = counts?.[target.id];
                  const checkboxId = `erase-target-checkbox-${target.id}`;
                  // Disabled + shown-checked when a selected superset already erases it.
                  const includedIn = coveredBy.get(target.id);
                  const checked = selected.has(target.id) || includedIn !== undefined;
                  return (
                    <li
                      key={target.id}
                      className={cn('flex items-center gap-3 px-3 py-2.5', includedIn && 'opacity-60')}
                    >
                      <input
                        id={checkboxId}
                        type="checkbox"
                        data-testid={`erase-target-${target.id}`}
                        className="size-4 accent-primary"
                        checked={checked}
                        onChange={() => toggleTarget(target.id)}
                        disabled={busy || includedIn !== undefined}
                        aria-label={target.label}
                      />
                      <label
                        htmlFor={checkboxId}
                        className={cn('flex-1 text-sm', includedIn ? 'cursor-default' : 'cursor-pointer')}
                      >
                        {target.label}
                      </label>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {includedIn ? (
                          <span data-testid={`erase-included-${target.id}`}>
                            Included in &ldquo;{includedIn}&rdquo;
                          </span>
                        ) : countsQuery.isPending ? (
                          <Spinner className="size-3" />
                        ) : target.scope === 'local' && (count === undefined || count === 0) ? (
                          'device'
                        ) : count !== undefined ? (
                          `${count} record${count === 1 ? '' : 's'}`
                        ) : (
                          '—'
                        )}
                      </span>
                      <Tooltip
                        content={
                          includedIn
                            ? `${target.tooltip}\n\n_Already included in "${includedIn}", which is selected._`
                            : target.tooltip
                        }
                        openDelayMs={INFO_OPEN_DELAY_MS}
                        triggerTabIndex={-1}
                      >
                        <InfoIcon
                          className="size-4 shrink-0 text-muted-foreground/70"
                          aria-label={`About ${target.label}`}
                        />
                      </Tooltip>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EverythingPanel
                confirming={confirming === 'everything'}
                pending={resettingAll}
                busy={busy}
                onArm={() => setConfirming('everything')}
                onConfirm={() => void handleEraseEverything()}
                onCancel={() => setConfirming(null)}
              />
            )}
          </div>
        </div>

        {/* Footer: running selection total (bottom-left) + sync toggle & action (right).
            While confirming a selective erase the whole footer turns into a deep-red
            warning banner so the irreversible step is impossible to miss. */}
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-3',
            confirming === 'selected'
              ? 'rounded-lg border border-destructive bg-destructive-emphasis p-3'
              : 'border-t border-border pt-4',
          )}
        >
          <Tooltip
            content="The number of data categories ticked for deletion across all tabs, and the approximate total number of records they will remove."
            openDelayMs={INFO_OPEN_DELAY_MS}
            triggerTabIndex={-1}
          >
            <div
              className={cn('text-sm', confirming === 'selected' && 'text-destructive-emphasis-foreground')}
              data-testid="erase-selection-summary"
            >
              <span className="font-semibold tabular-nums">{effectiveSelected.length}</span> selected for
              deletion
              {totalRecords > 0 ? (
                <span
                  className={
                    confirming === 'selected'
                      ? 'text-destructive-emphasis-foreground/80'
                      : 'text-muted-foreground'
                  }
                >
                  {' '}
                  &middot; ~{totalRecords} record{totalRecords === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>
          </Tooltip>

          {confirming === 'selected' ? (
            <EraseConfirmRow
              testIdPrefix="erase-selected"
              message="Permanently erase the selected data? This can't be undone."
              emphasis
              onConfirm={() => void handleEraseSelected()}
              onCancel={() => setConfirming(null)}
              pending={erasing}
            />
          ) : (
            <div className="flex items-center gap-3">
              <Tooltip
                content="When off, the data is removed only from this device — your cloud backup and other signed-in devices are left untouched. When on, a deletion marker (tombstone) is written so the erase propagates to the cloud and your other devices on the next sync."
                openDelayMs={INFO_OPEN_DELAY_MS}
              >
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    data-testid="erase-sync-toggle"
                    className="size-4 accent-primary"
                    checked={tombstone}
                    onChange={(e) => setTombstone(e.target.checked)}
                    disabled={busy}
                  />
                  Sync deletion
                </label>
              </Tooltip>
              <Tooltip
                content={
                  hasSelection
                    ? 'Permanently erase the ticked categories from this device (you will be asked to confirm).'
                    : 'Tick one or more categories above to enable.'
                }
                openDelayMs={INFO_OPEN_DELAY_MS}
                triggerTabIndex={-1}
              >
                <span>
                  <Button
                    variant="destructive"
                    data-testid="erase-selected"
                    disabled={!hasSelection || busy}
                    onClick={() => setConfirming('selected')}
                  >
                    {erasing ? <Spinner /> : <WarningIcon />}
                    Erase selected
                  </Button>
                </span>
              </Tooltip>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** A single vertical tab-rail button (icon + label, with an optional selection badge). */
function TabButton({
  tabId,
  label,
  icon,
  tooltip,
  badge,
  selected,
  danger,
  onSelect,
  onKeyDown,
  refMap,
}: {
  readonly tabId: TabId;
  readonly label: string;
  readonly icon: ReactNode;
  readonly tooltip: string;
  readonly badge?: number;
  readonly selected: boolean;
  readonly danger?: boolean;
  readonly onSelect: () => void;
  readonly onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  readonly refMap: RefObject<Map<TabId, HTMLButtonElement | null>>;
}) {
  return (
    <Tooltip
      content={tooltip}
      placement="right"
      className="w-full"
      openDelayMs={NAV_OPEN_DELAY_MS}
      triggerTabIndex={-1}
    >
      <button
        ref={(el) => {
          refMap.current.set(tabId, el);
        }}
        type="button"
        role="tab"
        id={`erase-tab-${tabId}`}
        aria-label={label}
        aria-selected={selected}
        aria-controls={`erase-panel-${tabId}`}
        tabIndex={selected ? 0 : -1}
        data-testid={`erase-tab-${tabId}`}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm font-medium transition-colors ease-emphasized sm:px-3',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected
            ? danger
              ? 'bg-destructive/10 text-destructive'
              : 'bg-primary/10 text-primary'
            : cn(
                'text-muted-foreground hover:bg-secondary/40 hover:text-foreground',
                danger && 'text-destructive/80',
              ),
        )}
      >
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
            selected
              ? danger
                ? 'bg-destructive/15 text-destructive'
                : 'bg-primary/15 text-primary'
              : 'bg-secondary/50 text-muted-foreground',
          )}
        >
          {icon}
        </span>
        <span className="hidden flex-1 sm:inline">{label}</span>
        {badge ? (
          <span
            className="hidden min-w-5 rounded-full bg-primary/15 px-1.5 text-center text-xs font-semibold tabular-nums text-primary sm:inline"
            aria-label={`${badge} selected`}
          >
            {badge}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}

/** The factory-reset panel shown under the "Erase everything" tab. */
function EverythingPanel({
  confirming,
  pending,
  busy,
  onArm,
  onConfirm,
  onCancel,
}: {
  readonly confirming: boolean;
  readonly pending: boolean;
  readonly busy: boolean;
  readonly onArm: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
      <div className="flex items-center gap-2">
        <CriticalIcon className="size-4 text-destructive" aria-hidden />
        <h3 className="text-sm font-semibold text-destructive">Erase everything</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        A full factory reset: wipes ALL inventory, photos, custom fields, settings, cloud sign-in and sync
        links stored on this device, then restarts the app. This cannot be reversed — export a backup first if
        you might want your data back.
      </p>
      {confirming ? (
        <EraseConfirmRow
          testIdPrefix="erase-everything"
          message="Permanently erase all data and restart? This can't be undone."
          onConfirm={onConfirm}
          onCancel={onCancel}
          pending={pending}
        />
      ) : (
        <Tooltip
          content="Removes every trace of the app from this device (database, photos, settings, sign-in and sync links) and reloads. You will be asked to confirm."
          openDelayMs={INFO_OPEN_DELAY_MS}
          triggerTabIndex={-1}
        >
          <span className="self-start">
            <Button variant="destructive" data-testid="erase-everything" disabled={busy} onClick={onArm}>
              {pending ? <Spinner /> : <CriticalIcon />}
              Erase everything&hellip;
            </Button>
          </span>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * Inline two-click confirm guard (mirrors the `ConfirmRow` pattern from
 * `StorageTriageDialog`). Renders an `alertdialog` region with the action
 * description, a destructive Confirm button, and a ghost Cancel button.
 */
function EraseConfirmRow({
  testIdPrefix,
  message,
  emphasis,
  onConfirm,
  onCancel,
  pending,
}: {
  readonly testIdPrefix: string;
  readonly message: string;
  /** Style for a deep-red warning banner: light-red label and a banner-readable Cancel. */
  readonly emphasis?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly pending: boolean;
}) {
  return (
    <span className="flex w-full flex-wrap items-center gap-2" role="alertdialog" aria-label="Confirm erase">
      <span
        className={cn(
          'mr-auto text-sm font-medium',
          emphasis && 'font-semibold text-destructive-emphasis-foreground',
        )}
      >
        {message}
      </span>
      <Button
        data-testid={`${testIdPrefix}-confirm`}
        variant="destructive"
        size="sm"
        onClick={onConfirm}
        disabled={pending}
      >
        {pending ? <Spinner /> : null}
        Confirm
      </Button>
      <Button
        data-testid={`${testIdPrefix}-cancel`}
        variant="ghost"
        size="sm"
        className={cn(
          emphasis &&
            'text-destructive-emphasis-foreground hover:bg-destructive-emphasis-foreground/10 hover:text-destructive-emphasis-foreground',
        )}
        onClick={onCancel}
        disabled={pending}
      >
        Cancel
      </Button>
    </span>
  );
}
