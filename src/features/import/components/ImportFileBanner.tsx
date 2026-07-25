import { Banner } from '@/components/foundry';
import { useT, type TypedTranslator } from '@/features/i18n';
import { useFormatters } from '@/lib/useFormatters';
import type { Formatters } from '@/lib/format';
import type { ImportFileRead, ImportFileRejection } from '../file-source';

/**
 * The shared "about the file you picked" notice for every importer (issue #347).
 *
 * `readImportFile` refuses a file it cannot honour — too large to decode on the main thread,
 * binary rather than text, empty, unreadable — and reports the fallback encoding when a file
 * turned out not to be UTF-8. This is where the user is told, in the same words whichever
 * importer they are in: the item importer's file tab, a BOM upload, or a purchase list.
 *
 * Renders nothing when there is nothing to say (no file chosen yet, or one that decoded cleanly
 * as UTF-8 / UTF-16), so a call site can mount it unconditionally.
 */
export function ImportFileBanner({
  read,
  'data-testid': testId,
}: {
  /** The last file-read outcome, or `null` before a file has been chosen. */
  readonly read: ImportFileRead | null;
  readonly 'data-testid'?: string;
}) {
  const t = useT();
  const formatters = useFormatters();
  if (read === null) return null;

  if (read.ok) {
    // UTF-8 and UTF-16 are read exactly as written, so there is nothing to report. Windows-1252
    // is a *fallback* — the file was not valid UTF-8 — and the user is the only one who can tell
    // whether the accented characters came out right, so say which encoding was assumed.
    if (read.encoding !== 'windows-1252') return null;
    return (
      <Banner tone="warning" heading={t('import.file.encoding.heading')} data-testid={testId}>
        {t('import.file.encoding.body')}
      </Banner>
    );
  }

  return (
    <Banner role="alert" tone="danger" heading={t('import.file.rejected')} data-testid={testId}>
      {rejectionMessage(t, formatters, read.rejection)}
    </Banner>
  );
}

/** The sentence for one refusal — what the file appears to be, and the way round it. */
function rejectionMessage(
  t: TypedTranslator,
  formatters: Formatters,
  rejection: ImportFileRejection,
): string {
  switch (rejection.reason) {
    case 'empty':
      return t('import.file.error.empty');
    case 'tooLarge':
      return t('import.file.error.tooLarge', {
        vars: {
          size: formatters.bytes(rejection.bytes),
          limit: formatters.bytes(rejection.limitBytes),
        },
      });
    case 'binary':
      return t(`import.file.error.binary.${rejection.kind}`);
    case 'unreadable':
      return t('import.file.error.unreadable');
  }
}
