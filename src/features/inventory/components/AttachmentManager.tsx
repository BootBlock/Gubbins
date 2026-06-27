import { useState } from 'react';
import { Button, Input, Select, Tooltip } from '@/components/foundry';
import { CloseIcon, DatasheetIcon, LinkIcon, LocalFileIcon } from '@/components/icons';
import type { AttachmentKind } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useAddAttachment, useItemAttachments, useRemoveAttachment } from '../media';
import { ATTACHMENT_KIND_LABELS } from './inventory-ui';

/**
 * Datasheet/attachment manager (spec §4 "Attachments & Datasheets"). The kinds a
 * user may add follow the global `attachmentMode` preference: Option A allows only
 * external URLs; Option B (Hybrid) also allows a local file-path pointer — of which
 * only the path string is stored, keeping it sync-safe (§4 Strict Sync Isolation).
 */
export function AttachmentManager({ itemId }: { itemId: string }) {
  const mode = usePreferencesStore((s) => s.attachmentMode);
  const { data: attachments } = useItemAttachments(itemId);
  const addAttachment = useAddAttachment();
  const removeAttachment = useRemoveAttachment(itemId);

  const [kind, setKind] = useState<AttachmentKind>('URL');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const effectiveKind: AttachmentKind = mode === 'URL_ONLY' ? 'URL' : kind;

  const submit = () => {
    setError(null);
    addAttachment.mutate(
      { itemId, kind: effectiveKind, value, label: label.trim() || null },
      {
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not add the attachment.'),
        onSuccess: () => {
          setValue('');
          setLabel('');
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <ul className="space-y-1.5">
        {(attachments ?? []).length === 0 ? (
          <li className="text-xs text-muted-foreground">No datasheets linked yet.</li>
        ) : (
          attachments!.map((att) => (
            <li
              key={att.id}
              className="flex items-center gap-2 rounded-lg border border-border bg-secondary/20 px-2.5 py-1.5 text-sm"
            >
              <span className="text-muted-foreground [&_svg]:size-4">
                {att.kind === 'URL' ? <LinkIcon /> : <LocalFileIcon />}
              </span>
              {att.kind === 'URL' ? (
                <a
                  href={att.value}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-primary hover:underline"
                >
                  {att.label || att.value}
                </a>
              ) : (
                <Tooltip content="**Local file pointer** — this path is only valid on the device that linked it; on other devices it shows as an unlinked local file.">
                  <span className="min-w-0 flex-1 truncate" title={att.value}>
                    {att.label || att.value}
                  </span>
                </Tooltip>
              )}
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={() => removeAttachment.mutate(att.id)}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive [&_svg]:size-3.5"
              >
                <CloseIcon />
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="space-y-2 rounded-lg border border-border bg-secondary/10 p-2.5">
        {mode === 'HYBRID' ? (
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as AttachmentKind)}
            aria-label="Attachment kind"
          >
            <option value="URL">{ATTACHMENT_KIND_LABELS.URL}</option>
            <option value="LOCAL_POINTER">{ATTACHMENT_KIND_LABELS.LOCAL_POINTER}</option>
          </Select>
        ) : null}
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={effectiveKind === 'URL' ? 'https://…/datasheet.pdf' : 'C:\\Datasheets\\NE555.pdf'}
          aria-label="Attachment location"
        />
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          aria-label="Attachment label"
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end">
          <Button size="sm" onClick={submit} disabled={!value.trim() || addAttachment.isPending}>
            <DatasheetIcon />
            Link datasheet
          </Button>
        </div>
      </div>
    </div>
  );
}
