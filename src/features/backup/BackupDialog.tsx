import { Fragment, useId, useRef, useState } from 'react';
import { Banner, Button, Checkbox, Input, LiveRegion, Modal, Surface } from '@/components/foundry';
import {
  DatabaseIcon,
  DownloadIcon,
  HistoryIcon,
  ImageIcon,
  PackageIcon,
  RestoreIcon,
  SettingsIcon,
  UploadIcon,
} from '@/components/icons';
import { plural } from '@/lib/plural';
import { useFormatters } from '@/lib/useFormatters';
import { getItemRepository } from '@/db/repositories';
import { estimateStorage } from '@/features/storage/storage-api';
import { createBackup, type BackupResult } from './build-backup';
import { readBackup, rememberRestoreNotice, restoreBackup, type RestoreMode } from './restore-backup';
import { DEFAULT_BACKUP_SELECTION, type BackupSelection, type ParsedBackup } from './backup-format';
import {
  DEFAULT_SETTINGS_GROUPS,
  SETTINGS_GROUP_IDS,
  allSettingsGroups,
  settingsGroupsPresent,
  type SettingsGroupSelection,
} from './settings-groups';
import { SettingsGroupPicker } from './SettingsGroupPicker';
import { useErrorMessage } from '@/features/errors';
import {
  REPLACE_CONFIRM_WORD,
  assessQuota,
  assessRestoreImpact,
  estimateBackupBytes,
  isReplaceConfirmed,
} from './restore-safety';

type Tab = 'create' | 'restore';

/** The boolean flags of a {@link BackupSelection} — i.e. everything the toggle rows can drive. */
type BackupToggleKey = {
  [K in keyof BackupSelection]: BackupSelection[K] extends boolean ? K : never;
}[keyof BackupSelection];

/** The toggle rows in the Create tab — each maps to a {@link BackupSelection} flag. */
const TOGGLES: {
  key: BackupToggleKey;
  label: string;
  hint: string;
  icon: typeof DatabaseIcon;
}[] = [
  {
    key: 'images',
    label: 'Full-resolution images',
    hint: 'The original image files. The biggest part of a backup — turn off for a small, fast backup.',
    icon: ImageIcon,
  },
  {
    key: 'history',
    label: 'Activity history & audit log',
    hint: 'Every per-item event and gauge change. Can be large for long-lived inventories.',
    icon: HistoryIcon,
  },
  {
    key: 'removedItems',
    label: 'Removed (decommissioned) items',
    hint: 'Include soft-deleted items, not just active ones.',
    icon: PackageIcon,
  },
  {
    key: 'settings',
    label: 'App settings & preferences',
    hint: 'Theme, units, dashboard layout and saved searches. Your bridge token is never included.',
    icon: SettingsIcon,
  },
  {
    key: 'rawSqlite',
    label: 'Exact database copy (.sqlite)',
    hint: 'A byte-for-byte database file for guaranteed recovery. Always complete — the filters above shape only the portable copy.',
    icon: DatabaseIcon,
  },
];

/**
 * The Backup & Restore dialog (spec §2 versioned backup, §2.7 full archive, §3).
 *
 * Create: choose what to include and download a single `.zip` (a portable, version-guarded
 * data snapshot + an exact `.sqlite` copy + full-resolution images + settings). Restore: pick
 * a backup, preview its contents, and merge it into the current data or replace everything.
 */
export function BackupDialog({
  open,
  onClose,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after a reload-free restore (merge / clone) so the host can refresh in place. */
  onRestored?: (message: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('create');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Backup & restore"
      description="Save everything to a file, or restore from one."
    >
      <div className="space-y-4">
        <div
          role="tablist"
          aria-label="Backup or restore"
          className="flex gap-1 rounded-lg bg-secondary/40 p-1"
        >
          <TabButton active={tab === 'create'} onClick={() => setTab('create')}>
            <DownloadIcon /> Create backup
          </TabButton>
          <TabButton active={tab === 'restore'} onClick={() => setTab('restore')}>
            <UploadIcon /> Restore
          </TabButton>
        </div>

        {tab === 'create' ? <CreatePanel /> : <RestorePanel onClose={onClose} onRestored={onRestored} />}
      </div>
    </Modal>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors [&_svg]:size-4 ${
        active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

// --- Create -------------------------------------------------------------------------

function CreatePanel() {
  const fmt = useFormatters();
  const [selection, setSelection] = useState<BackupSelection>(DEFAULT_BACKUP_SELECTION);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BackupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();

  const toggle = (key: BackupToggleKey) => setSelection((prev) => ({ ...prev, [key]: !prev[key] }));

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await createBackup(selection));
    } catch (err) {
      setError(describeError(err, 'The backup could not be created.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Your inventory and all records are <strong>always included</strong> as a portable, restorable data
        file. Choose what else to add:
      </p>

      <fieldset className="space-y-1">
        <legend className="sr-only">Backup contents</legend>
        {TOGGLES.map(({ key, label, hint, icon: Icon }) => (
          <Fragment key={key}>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-secondary/40 [&_svg]:size-5">
              <Checkbox
                checked={selection[key]}
                onChange={() => toggle(key)}
                className="mt-0.5"
                data-testid={`backup-toggle-${key}`}
              />
              <Icon className="mt-0.5 text-muted-foreground" />
              <span className="flex-1">
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-muted-foreground">{hint}</span>
              </span>
            </label>
            {/* The settings toggle opens into a per-group picker (issue #175): the user decides
                which parts of their settings travel, rather than all-or-nothing. */}
            {key === 'settings' && selection.settings ? (
              <div className="ml-7">
                <SettingsGroupPicker
                  ids={SETTINGS_GROUP_IDS}
                  value={selection.settingGroups}
                  onChange={(settingGroups) => setSelection((prev) => ({ ...prev, settingGroups }))}
                  titleKey="backup.settings.chooseTitle"
                  hintKey="backup.settings.chooseHint"
                  emptyKey="backup.settings.none"
                  testIdPrefix="backup-setting-group"
                />
              </div>
            ) : null}
          </Fragment>
        ))}
      </fieldset>

      {result ? (
        <Surface className="space-y-1 p-3 text-sm">
          <p className="font-medium text-foreground">Backup downloaded</p>
          <p className="text-muted-foreground">
            {result.filename} · {fmt.bytes(result.size)} · {result.manifest.counts.items} items
            {result.manifest.counts.images > 0 ? `, ${result.manifest.counts.images} images` : ''}
          </p>
        </Surface>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {/* Always-mounted polite region: "Preparing…" and the success summary are
          in-place state changes that a screen reader would otherwise miss (WCAG 4.1.3).
          A separate assertive region handles error outcomes. */}
      <LiveRegion visuallyHidden data-testid="create-backup-live-region">
        {busy ? (
          <p>Preparing backup…</p>
        ) : result ? (
          <p>
            Backup downloaded: {result.filename}, {fmt.bytes(result.size)}, {result.manifest.counts.items}{' '}
            items.
          </p>
        ) : null}
      </LiveRegion>
      <LiveRegion urgency="assertive" visuallyHidden data-testid="create-backup-error-live-region">
        {error ? <p>{error}</p> : null}
      </LiveRegion>

      <div className="flex justify-end">
        <Button onClick={() => void run()} disabled={busy} data-testid="create-backup">
          <DownloadIcon />
          {busy ? 'Preparing…' : 'Create backup'}
        </Button>
      </div>
    </div>
  );
}

// --- Restore ------------------------------------------------------------------------

function RestorePanel({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  onRestored?: (message: string) => void;
}) {
  const fmt = useFormatters();
  const fileRef = useRef<HTMLInputElement>(null);
  const modeName = useId();
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedBackup | null>(null);
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();
  // Live context for the Replace guards: how many items exist now, and the storage head-room.
  const [currentItems, setCurrentItems] = useState<number | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number; supported: boolean } | null>(null);
  const [replaceText, setReplaceText] = useState('');
  // Which of the settings groups the chosen backup carries should land on this device (#175).
  // Defaults match the create tab's, so the device-specific group is opt-in at *both* ends: a
  // backup that happens to carry a bridge address never re-points a different device by default.
  const [settingGroups, setSettingGroups] = useState<SettingsGroupSelection>(DEFAULT_SETTINGS_GROUPS);

  const resetMode = (next: RestoreMode) => {
    setMode(next);
    setConfirming(false);
    setReplaceText('');
  };

  const onFileChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    event.target.value = '';
    setFile(chosen);
    setParsed(null);
    setConfirming(false);
    setError(null);
    setReplaceText('');
    setCurrentItems(null);
    setStorage(null);
    setSettingGroups(DEFAULT_SETTINGS_GROUPS);
    if (!chosen) return;
    setBusy(true);
    try {
      const result = await readBackup(chosen);
      setParsed(result);
      // Gather the live context the Replace guards need (best-effort; never blocks the preview).
      const [count, estimate] = await Promise.all([
        getItemRepository()
          .count()
          .catch(() => null),
        estimateStorage().catch(() => null),
      ]);
      setCurrentItems(count);
      setStorage(
        estimate ? { usage: estimate.usage, quota: estimate.quota, supported: estimate.supported } : null,
      );
    } catch (err) {
      setError(describeError(err, 'That file could not be read as a backup.'));
    } finally {
      setBusy(false);
    }
  };

  const confirmRestore = async () => {
    if (!parsed) return;
    if (mode === 'replace' && !isReplaceConfirmed(replaceText)) return; // type-to-confirm guard
    setBusy(true);
    setError(null);
    try {
      // Safety net: capture the current data as a downloadable "restore point" *before* a
      // destructive Replace overwrites it, so a wrong restore can be undone. Abort if it fails
      // — never wipe without first securing what's there.
      if (mode === 'replace') {
        try {
          // The restore point is the undo for a destructive Replace, so it captures *every*
          // settings group — including the device-specific one the create tab leaves off by
          // default. A safety net the user never chose the shape of must not have holes in it.
          await createBackup(
            { ...DEFAULT_BACKUP_SELECTION, settingGroups: allSettingsGroups(true) },
            { filenamePrefix: 'gubbins-restore-point' },
          );
          // Let the browser commit the restore-point download before we overwrite the DB and
          // (on the .sqlite path) reload — a reload in the same tick could cancel it.
          await new Promise((resolve) => setTimeout(resolve, 400));
        } catch (err) {
          setError(
            `Could not save a safety backup of your current data, so the restore was cancelled. ${describeError(
              err,
              '',
            )}`.trim(),
          );
          setBusy(false);
          return;
        }
      }

      const outcome = await restoreBackup(parsed, mode, settingGroups);
      if (outcome.reloadRequired) {
        rememberRestoreNotice(outcome.message); // survives the reload, shown on the Sync screen
        location.reload();
        return; // page navigates away
      }
      onRestored?.(outcome.message);
      onClose();
    } catch (err) {
      setError(describeError(err, 'The restore failed.'));
      setBusy(false);
      setConfirming(false);
    }
  };

  const backupItems = parsed?.snapshot.tables.items?.length ?? 0;
  const impact = parsed && currentItems !== null ? assessRestoreImpact(currentItems, backupItems) : null;
  const quota =
    parsed && storage
      ? assessQuota(estimateBackupBytes(parsed), storage.usage, storage.quota, storage.supported)
      : null;
  const replaceArmed = isReplaceConfirmed(replaceText);
  const presentSettingGroups = parsed?.settings ? settingsGroupsPresent(parsed.settings) : [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Restore from a Gubbins backup (<code className="rounded bg-secondary/60 px-1">.zip</code>).
      </p>

      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        data-testid="restore-backup-input"
        onChange={(e) => void onFileChosen(e)}
      />
      <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
        <UploadIcon />
        Choose backup file…
      </Button>

      {file && !parsed && !error && busy ? (
        <p className="text-sm text-muted-foreground">Reading {file.name}…</p>
      ) : null}

      {parsed ? (
        <>
          <Surface className="space-y-2 p-3 text-sm">
            <p className="font-medium text-foreground">{file?.name}</p>
            <p className="text-muted-foreground">
              {parsed.manifest
                ? `Created ${new Date(parsed.manifest.createdAt).toLocaleString()} · Gubbins ${parsed.manifest.appVersion}`
                : 'Backup (data only).'}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Badge>{parsed.snapshot.tables.items?.length ?? 0} items</Badge>
              {parsed.images.length > 0 ? <Badge>{parsed.images.length} images</Badge> : null}
              {parsed.sqlite ? <Badge>exact .sqlite</Badge> : null}
              {parsed.settings ? <Badge>settings</Badge> : null}
            </div>
          </Surface>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              How to apply
            </legend>
            <ModeOption
              name={modeName}
              value="merge"
              checked={mode === 'merge'}
              onChange={() => resetMode('merge')}
              label="Merge into current data"
              hint="Add and update records from the backup; keep anything you've added since. Non-destructive."
            />
            <ModeOption
              name={modeName}
              value="replace"
              checked={mode === 'replace'}
              onChange={() => resetMode('replace')}
              label="Replace everything"
              hint="Erase current data and restore the backup exactly. We save a restore point first, but it cannot otherwise be undone."
            />
          </fieldset>

          {/* Only the groups this backup actually carries are offered, so a tick-box can never
              promise to restore something the file doesn't contain (issue #175). */}
          {presentSettingGroups.length > 0 ? (
            <SettingsGroupPicker
              ids={presentSettingGroups}
              value={settingGroups}
              onChange={setSettingGroups}
              titleKey="backup.settings.restoreTitle"
              hintKey="backup.settings.restoreHint"
              emptyKey="backup.settings.noneRestore"
              testIdPrefix="restore-setting-group"
            />
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          {confirming ? (
            <Banner tone={mode === 'replace' ? 'danger' : 'warning'}>
              <div className="space-y-3">
                {mode === 'replace' ? (
                  <>
                    <p>
                      This erases all current data on this device and restores the backup exactly, then
                      reloads. <strong>A safety copy of your current data is downloaded first</strong> so this
                      can be undone.
                    </p>
                    {impact ? (
                      <p data-testid="restore-impact">
                        Replacing <strong>{impact.currentItems}</strong> current{' '}
                        {plural(impact.currentItems, 'item')} with <strong>{impact.backupItems}</strong> from
                        the backup.
                      </p>
                    ) : null}
                    {impact?.empty ? (
                      <p className="font-medium text-destructive" data-testid="restore-empty-warning">
                        This backup contains no items — restoring it will erase your inventory.
                      </p>
                    ) : impact?.shrinking ? (
                      <p className="font-medium" data-testid="restore-shrink-warning">
                        The backup has fewer items than you have now — you may lose data.
                      </p>
                    ) : null}
                    {quota && !quota.willFit ? (
                      <p className="font-medium" data-testid="restore-quota-warning">
                        This backup (~{fmt.bytes(quota.incomingBytes)}) may not fit in the storage still
                        available (~{fmt.bytes(quota.availableBytes)}).
                      </p>
                    ) : null}
                    <label className="block space-y-field-gap-compact">
                      <span className="text-xs text-muted-foreground">
                        Type{' '}
                        <code className="rounded bg-secondary/60 px-1 font-mono">{REPLACE_CONFIRM_WORD}</code>{' '}
                        to confirm
                      </span>
                      <Input
                        value={replaceText}
                        onChange={(e) => setReplaceText(e.target.value)}
                        placeholder={REPLACE_CONFIRM_WORD}
                        autoComplete="off"
                        aria-label={`Type ${REPLACE_CONFIRM_WORD} to confirm`}
                        data-testid="replace-confirm-input"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <p>This adds and updates records from the backup.</p>
                    {quota && !quota.willFit ? (
                      <p className="font-medium" data-testid="restore-quota-warning">
                        This backup (~{fmt.bytes(quota.incomingBytes)}) may not fit in the storage still
                        available (~{fmt.bytes(quota.availableBytes)}).
                      </p>
                    ) : null}
                  </>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={mode === 'replace' ? 'destructive' : 'primary'}
                    onClick={() => void confirmRestore()}
                    disabled={busy || (mode === 'replace' && !replaceArmed)}
                    data-testid="confirm-restore-backup"
                  >
                    <RestoreIcon />
                    {busy ? 'Restoring…' : mode === 'replace' ? 'Erase & restore' : 'Merge & apply'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setConfirming(false);
                      setReplaceText('');
                    }}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </Banner>
          ) : (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button
                variant={mode === 'replace' ? 'destructive' : 'primary'}
                onClick={() => setConfirming(true)}
                disabled={busy}
                data-testid="restore-backup"
              >
                <RestoreIcon />
                Restore
              </Button>
            </div>
          )}
        </>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      {/* Always-mounted polite region: "Reading {filename}…" and "Restoring…" are
          in-place state changes that a screen reader would otherwise miss (WCAG 4.1.3).
          A separate assertive region handles error outcomes. */}
      <LiveRegion visuallyHidden data-testid="restore-live-region">
        {file && busy && !parsed ? (
          <p>Reading {file.name}…</p>
        ) : file && busy && parsed && confirming ? (
          <p>Restoring…</p>
        ) : null}
      </LiveRegion>
      <LiveRegion urgency="assertive" visuallyHidden data-testid="restore-error-live-region">
        {error ? <p>{error}</p> : null}
      </LiveRegion>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-secondary/70 px-2 py-0.5 text-xs text-muted-foreground">{children}</span>
  );
}

function ModeOption({
  name,
  value,
  checked,
  onChange,
  label,
  hint,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  hint: string;
}) {
  return (
    // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the nested radio input is correctly associated; the label's text comes from the dynamic {label}/{hint} props, which the linter cannot resolve to a static string.
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-secondary/40">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 size-4 accent-primary"
        data-testid={`restore-mode-${value}`}
      />
      <span className="flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
