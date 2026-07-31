import { useId, useRef, useState } from 'react';
import { plural } from '@/lib/plural';
import { Banner, Button, FormField, Input, Modal, Select, Textarea } from '@/components/foundry';
import { UploadIcon } from '@/components/icons';
import {
  detectImportFormat,
  IMPORT_FORMATS,
  IMPORT_FORMAT_LABELS,
  isTabularFormat,
  type ImportFormat,
} from '@/features/import/tabular';
import { ImportProblemsBanner } from '@/features/import/components/ImportProblemsBanner';
import { ImportFileBanner } from '@/features/import/components/ImportFileBanner';
import { readImportFile, type ImportFileRead } from '@/features/import/file-source';
import { useCreateProjectFromBom, useImportBom } from '../projects';
import { parseBom, BomImportError, type BomParseResult } from '../bom-import';
import { useErrorMessage } from '@/features/errors';

/** The file types the BOM importer accepts (mirrors the recognised tabular formats). */
const BOM_FILE_ACCEPT =
  '.csv,.tsv,.tab,.txt,.json,.md,.markdown,.html,.htm,' +
  'text/csv,text/tab-separated-values,text/plain,application/json,text/markdown,text/html';

/**
 * BOM ingress (spec §4). The user pastes or uploads a bill of materials in any recognised
 * shape — CSV / TSV / semicolon-separated, JSON, a Markdown table, or an HTML table — and
 * it is parsed (format auto-detected, or forced via "Interpret as"), previewed, then
 * imported with MPN/alias auto-match against local inventory. The generic
 * text→table extraction is the shared {@link module:features/import/tabular} engine (also
 * used by the item importer), so both importers understand the same formats.
 *
 * Two modes share the same parse + preview UI:
 *  - **into an existing project** — pass `projectId`; the lines are added to it.
 *  - **as a new project** — omit `projectId`; a name field appears and the import
 *    creates a standalone project from the order/BOM, then selects it via
 *    {@link onCreated}. Both modes reuse the same MPN auto-match path — no duplicated
 *    parsing or matching logic.
 */
export function ImportBomDialog({
  open,
  onClose,
  projectId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Import into this existing project. Omit to create a new project from the BOM. */
  projectId?: string;
  /** Called with the new project's id after a successful new-project import. */
  onCreated?: (projectId: string) => void;
}) {
  const isNewProject = projectId === undefined;
  const importBom = useImportBom(projectId ?? '');
  const createFromBom = useCreateProjectFromBom();
  const fileRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const formatId = useId();
  const [name, setName] = useState('');
  // True once the user edits the name, so an uploaded filename only seeds a name the
  // user has not already chosen.
  const [nameTouched, setNameTouched] = useState(false);
  const [text, setText] = useState('');
  // 'auto' → detect the source shape from the content; a format id forces that parser.
  const [formatOverride, setFormatOverride] = useState<ImportFormat | 'auto'>('auto');
  const [parsed, setParsed] = useState<BomParseResult | null>(null);
  // What the last chosen file turned out to be — a refusal to explain, or the encoding it had to
  // be read as. Cleared as soon as the text is edited by hand, since it no longer describes it.
  const [fileRead, setFileRead] = useState<ImportFileRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();
  const [summary, setSummary] = useState<string | null>(null);

  const pending = isNewProject ? createFromBom.isPending : importBom.isPending;

  const reset = () => {
    setName('');
    setNameTouched(false);
    setText('');
    setFormatOverride('auto');
    setParsed(null);
    setFileRead(null);
    setError(null);
    setSummary(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  // Parse the given text under the given format choice, updating the preview / error. Both
  // the text field and the format picker call this so a change to either re-parses live.
  const runParse = (raw: string, override: ImportFormat | 'auto') => {
    setText(raw);
    setSummary(null);
    if (raw.trim().length === 0) {
      setParsed(null);
      setError(null);
      return;
    }
    try {
      setParsed(parseBom(raw, override === 'auto' ? {} : { format: override }));
      setError(null);
    } catch (err) {
      setParsed(null);
      setError(err instanceof BomImportError ? err.message : 'Could not parse the BOM.');
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    // The shared seam decides whether this file can be text at all — size cap, binary sniff and a
    // strict decode — so an .xlsx or a Latin-1 export cannot become garbage lines (issue #347).
    const read = await readImportFile(file);
    if (read.ok) {
      // Seed a new project's name from the file's base name, unless the user typed one. Only for a
      // file that was actually read: a refused one contributes nothing, not even its name.
      if (isNewProject && !nameTouched) {
        const base = file.name.replace(/\.[^.]+$/, '').trim();
        if (base.length > 0) setName(base);
      }
      runParse(read.text, formatOverride);
    }
    setFileRead(read);
  };

  // When auto-detecting, show which tabular shape was recognised (a `lines` result means
  // "no table", which the error banner already explains, so it is not surfaced as a format).
  const detectedFormat =
    formatOverride === 'auto' && text.trim().length > 0 ? detectImportFormat(text) : null;

  const handleImport = () => {
    if (!parsed || parsed.lines.length === 0) return;

    if (isNewProject) {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        nameRef.current?.focus();
        return;
      }
      setError(null);
      createFromBom.mutate(
        { project: { name: trimmed }, lines: parsed.lines },
        {
          onSuccess: (result) => {
            onCreated?.(result.projectId);
            close();
          },
          onError: (err) => {
            setError(describeError(err, 'Could not create the project from this BOM.'));
          },
        },
      );
      return;
    }

    setError(null);
    importBom.mutate(parsed.lines, {
      onSuccess: (result) => {
        setSummary(
          `Imported ${result.added} ${plural(result.added, 'line')} — ${result.matched} auto-matched to inventory.`,
        );
        setParsed(null);
        setText('');
        // The staged text is gone, so a notice about the file it came from no longer describes
        // anything on screen — leaving it would tell the user to check a preview that is now empty.
        setFileRead(null);
      },
      onError: (err) => {
        setError(describeError(err, 'Could not import this BOM.'));
      },
    });
  };

  const nameMissing = isNewProject && name.trim().length === 0;

  return (
    <Modal
      open={open}
      onClose={close}
      title={isNewProject ? 'New project from a BOM' : 'Import BOM'}
      description={
        isNewProject
          ? 'Create a project from an order or bill of materials.'
          : 'Paste or upload a bill of materials — CSV, TSV, JSON, Markdown or HTML.'
      }
      className="max-w-2xl"
      {...(isNewProject ? { initialFocusRef: nameRef } : {})}
    >
      <div className="space-y-4">
        {isNewProject ? (
          <FormField
            label="Project name"
            hint="The parts below become this project's initial bill of materials."
          >
            <Input
              ref={nameRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="e.g. Bench power supply"
            />
          </FormField>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <UploadIcon />
              Upload file
            </Button>
            <span className="text-xs text-muted-foreground">…or paste below</span>
            <input
              ref={fileRef}
              type="file"
              accept={BOM_FILE_ACCEPT}
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                // Clear the input so re-choosing the same path fires another change event —
                // otherwise fixing a refused file in place and picking it again does nothing.
                e.target.value = '';
              }}
            />
          </div>
          <div className="ml-auto space-y-field-gap-compact">
            <span
              id={`${formatId}-label`}
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Interpret as
            </span>
            <Select
              id={formatId}
              aria-labelledby={`${formatId}-label`}
              value={formatOverride}
              onChange={(value) => {
                const next = value as ImportFormat | 'auto';
                setFormatOverride(next);
                runParse(text, next);
              }}
              className="h-8 text-xs"
              data-testid="bom-import-format"
              options={[
                { value: 'auto', label: 'Auto-detect' },
                ...IMPORT_FORMATS.filter(isTabularFormat).map((f) => ({
                  value: f,
                  label: IMPORT_FORMAT_LABELS[f],
                })),
              ]}
            />
          </div>
        </div>

        <ImportFileBanner read={fileRead} data-testid="bom-import-file-notice" />

        <Textarea
          sizeKey="import.bom"
          value={text}
          onChange={(e) => {
            setFileRead(null);
            runParse(e.target.value, formatOverride);
          }}
          placeholder={'Reference,Value,Quantity,MPN,Manufacturer\nR1,10k,2,RC0805FR-0710KL,Yageo'}
          className="h-40 font-mono"
          aria-label="BOM text"
        />

        <p className="text-xs text-muted-foreground">
          Accepts CSV / TSV, JSON, a Markdown table or an HTML table — the format is detected automatically,
          or choose it with “Interpret as”.
          {detectedFormat && isTabularFormat(detectedFormat)
            ? ` Detected: ${IMPORT_FORMAT_LABELS[detectedFormat]}.`
            : ''}
        </p>

        {error ? <Banner tone="danger">{error}</Banner> : null}
        {summary ? <Banner tone="success">{summary}</Banner> : null}
        {parsed ? (
          <ImportProblemsBanner problems={parsed.problems} data-testid="bom-import-problems" />
        ) : null}

        {parsed && parsed.lines.length > 0 ? (
          <div className="max-h-48 overflow-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Qty</th>
                  <th className="px-2 py-1.5 font-medium">Designator</th>
                  <th className="px-2 py-1.5 font-medium">Description</th>
                  <th className="px-2 py-1.5 font-medium">MPN</th>
                </tr>
              </thead>
              <tbody>
                {parsed.lines.map((line, i) => (
                  <tr key={i} className="border-t border-border/60">
                    <td className="px-2 py-1.5">{line.requiredQty}</td>
                    <td className="px-2 py-1.5">{line.designator ?? '—'}</td>
                    <td className="px-2 py-1.5">{line.description ?? '—'}</td>
                    <td className="px-2 py-1.5 font-mono">{line.mpn ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="flex items-center justify-between pt-1">
          <p className="text-xs text-muted-foreground">
            {parsed ? `${parsed.lines.length} ${plural(parsed.lines.length, 'line')} ready` : ' '}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              {isNewProject ? 'Cancel' : 'Close'}
            </Button>
            <Button
              type="button"
              onClick={handleImport}
              disabled={!parsed || parsed.lines.length === 0 || nameMissing || pending}
            >
              {isNewProject
                ? `Create project (${parsed?.lines.length ?? 0})`
                : `Import ${parsed?.lines.length ?? 0}`}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
