import { useRef, useState } from 'react';
import { Banner, Button, Modal } from '@/components/foundry';
import { UploadIcon } from '@/components/icons';
import { useImportBom } from '../projects';
import { parseBom, BomImportError, type ParsedBomLine } from '../bom-import';

/**
 * CSV/KiCad BOM import (spec §4 BOM Ingress — Standard CSV/KiCad Import). The user
 * pastes or uploads a BOM; it is parsed with the native parser, previewed, then
 * imported with MPN/alias auto-match against local inventory.
 */
export function ImportBomDialog({
  open,
  onClose,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
}) {
  const importBom = useImportBom(projectId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedBomLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const reset = () => {
    setText('');
    setParsed(null);
    setError(null);
    setSummary(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const handleParse = (raw: string) => {
    setText(raw);
    setSummary(null);
    if (raw.trim().length === 0) {
      setParsed(null);
      setError(null);
      return;
    }
    try {
      setParsed(parseBom(raw));
      setError(null);
    } catch (err) {
      setParsed(null);
      setError(err instanceof BomImportError ? err.message : 'Could not parse the BOM.');
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    handleParse(await file.text());
  };

  const handleImport = () => {
    if (!parsed || parsed.length === 0) return;
    importBom.mutate(parsed, {
      onSuccess: (result) => {
        setSummary(
          `Imported ${result.added} line${result.added === 1 ? '' : 's'} — ${result.matched} auto-matched to inventory.`,
        );
        setParsed(null);
        setText('');
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Import BOM"
      description="Paste or upload a CSV / KiCad bill of materials."
      className="max-w-2xl"
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <UploadIcon />
            Upload file
          </Button>
          <span className="text-xs text-muted-foreground">…or paste below</span>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
        </div>

        <textarea
          value={text}
          onChange={(e) => handleParse(e.target.value)}
          placeholder={'Reference,Value,Quantity,MPN,Manufacturer\nR1,10k,2,RC0805FR-0710KL,Yageo'}
          className="h-40 w-full resize-y rounded-lg border border-border bg-input/40 p-3 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          aria-label="BOM CSV text"
        />

        {error ? <Banner tone="danger">{error}</Banner> : null}
        {summary ? <Banner tone="success">{summary}</Banner> : null}

        {parsed && parsed.length > 0 ? (
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
                {parsed.map((line, i) => (
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
            {parsed ? `${parsed.length} line${parsed.length === 1 ? '' : 's'} ready` : ' '}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Close
            </Button>
            <Button
              type="button"
              onClick={handleImport}
              disabled={!parsed || parsed.length === 0 || importBom.isPending}
            >
              Import {parsed?.length ?? 0}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
