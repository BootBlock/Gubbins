import { useState } from 'react';
import { Button, Modal, Surface } from '@/components/foundry';
import { ExportIcon, PackageIcon, VaultIcon } from '@/components/icons';
import { runExport } from './run-export';
import { useExportStore, type ExportFormat } from './useExportStore';

/**
 * The Granular Export Wizard (spec §3, §2 JSON backup, §4.5 Markdown vault).
 *
 * Remembers the last-used format/scope via {@link useExportStore} (§3 "must
 * remember the user's last-used settings"). Phase 6 ships the full-database scope
 * in three formats: a versioned JSON backup (§2), an items CSV, and an Obsidian
 * Markdown vault zipped off-thread (§4.5). Per-item / per-project scopes are future.
 */
const FORMATS: { value: ExportFormat; label: string; hint: string; icon: typeof ExportIcon }[] = [
  { value: 'JSON', label: 'JSON backup', hint: 'Versioned full backup (items, contacts, loans).', icon: ExportIcon },
  { value: 'CSV', label: 'Items CSV', hint: 'Spreadsheet of every item.', icon: PackageIcon },
  { value: 'VAULT', label: 'Markdown vault', hint: 'Obsidian-ready .zip, one note per item.', icon: VaultIcon },
];

export function ExportWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { format, includeInactive, setFormat, setIncludeInactive } = useExportStore();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setDone(null);
    setError(null);
    try {
      const filename = await runExport(format, { includeInactive });
      setDone(filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export"
      description="Your last settings are remembered for next time."
    >
      <div className="space-y-4">
        <div className="grid gap-2">
          {FORMATS.map((f) => {
            const Icon = f.icon;
            const selected = format === f.value;
            return (
              <button
                key={f.value}
                onClick={() => setFormat(f.value)}
                aria-pressed={selected}
                className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors [&_svg]:size-5 ${
                  selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary/50'
                }`}
              >
                <Icon className={selected ? 'text-primary' : 'text-muted-foreground'} />
                <span className="flex-1">
                  <span className="block text-sm font-medium">{f.label}</span>
                  <span className="block text-xs text-muted-foreground">{f.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="size-4 accent-primary"
          />
          Include removed (decommissioned) items
        </label>

        {done ? (
          <Surface className="p-3 text-sm text-foreground">
            Exported <span className="font-medium">{done}</span> to your downloads.
          </Surface>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void run()} disabled={busy} data-testid="run-export">
            <ExportIcon />
            {busy ? 'Exporting…' : 'Export'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
