import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ImportIcon } from '@/components/icons';
import { ImportDataDialog } from '@/features/inventory/components/ImportDataDialog';
import { readImportFile, type ImportFileRead } from '@/features/import/file-source';
import { LandingScaffold } from './LandingScaffold';

/**
 * Minimal shape of the File Handling API surface we consume. `window.launchQueue` is only present
 * in a PWA launched to open a file (a `file_handlers` action — plan EI-4); it is typed loosely here
 * because the DOM lib does not yet ship these definitions.
 */
interface LaunchParams {
  files?: readonly FileSystemFileHandle[];
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/**
 * File-handler landing screen (plan EI-4). When the OS opens a `.csv` / `.tsv` / `.json` / `.md` /
 * `.txt` file "with Gubbins", the launched PWA receives the file handle via `window.launchQueue`;
 * this screen reads its text and opens the existing {@link ImportDataDialog} pre-seeded with the
 * contents, so the file flows straight into the reviewable import preview. Opened without a launch
 * file it just shows the empty import dialog.
 */
export function ImportLaunchScreen() {
  const navigate = useNavigate();
  const [seed, setSeed] = useState<{ read: ImportFileRead; filename: string } | null>(null);

  useEffect(() => {
    const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
    if (!queue?.setConsumer) return;
    queue.setConsumer((params) => {
      const handle = params.files?.[0];
      if (!handle) return;
      void (async () => {
        try {
          const file = await handle.getFile();
          // The OS hands over whatever the user chose "open with Gubbins" on, so a launched file
          // goes through the same size cap, binary sniff and strict decode as a picked one; a
          // refused one seeds no text and the dialog's File tab explains why (issue #347).
          setSeed({ read: await readImportFile(file), filename: file.name });
        } catch {
          // A read failure leaves the empty dialog open; the user can pick a file manually.
        }
      })();
    });
  }, []);

  const close = () => void navigate({ to: '/inventory' });

  return (
    <LandingScaffold icon={<ImportIcon />} title="Import into Gubbins" message="Opening the import tool…">
      {/* Remount when a launched file arrives so its contents seed the workbench (the dialog reads
          its seed on mount); opened directly, it stays an empty, ready import dialog. */}
      <ImportDataDialog
        key={seed ? 'seeded' : 'empty'}
        open
        onClose={close}
        initialText={seed?.read.ok ? seed.read.text : undefined}
        initialFilename={seed?.read.ok ? seed.filename : undefined}
        initialFileRead={seed?.read}
      />
    </LandingScaffold>
  );
}
