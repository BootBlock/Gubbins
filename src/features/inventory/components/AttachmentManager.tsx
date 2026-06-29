import { useMemo, useState } from 'react';
import { Button, InfoHint, Input, Select, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { CloseIcon, DatasheetIcon, LinkIcon, LocalFileIcon, UnlinkIcon } from '@/components/icons';
import type { AttachmentKind, ItemAttachment, UpdateAttachmentInput } from '@/db/repositories';
import { getDeviceId } from '@/lib/env/device-id';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import {
  useAddAttachment,
  useItemAttachments,
  useRemoveAttachment,
  useUpdateAttachment,
} from '../media';
import { resolveAttachmentLink } from '../attachment-link';
import { ATTACHMENT_KIND_LABELS } from './inventory-ui';

/**
 * Datasheet/attachment manager (spec §4 "Attachments & Datasheets"). The kinds a
 * user may add follow the global `attachmentMode` preference: Option A allows only
 * external URLs; Option B (Hybrid) also allows a local file-path pointer — of which
 * only the path string is stored, keeping it sync-safe (§4 Strict Sync Isolation).
 *
 * A `LOCAL_POINTER` synced from another device degrades to an "Unlinked Local File"
 * placeholder (§4 graceful degradation) — the path is shown for reference but offers a
 * **Re-link** (supply a new local path for *this* device) or **Use URL** (replace with an
 * external URL) flow, never an attempt to fetch the foreign blob. The foreign/local
 * decision is the pure `resolveAttachmentLink` seam comparing the stored origin device
 * (v18) with this device's id (`getDeviceId`).
 */
export function AttachmentManager({ itemId }: { itemId: string }) {
  const mode = usePreferencesStore((s) => s.attachmentMode);
  const { data: attachments } = useItemAttachments(itemId);
  const addAttachment = useAddAttachment();
  const removeAttachment = useRemoveAttachment(itemId);
  const updateAttachment = useUpdateAttachment(itemId);
  const deviceId = useMemo(() => getDeviceId(), []);

  const [kind, setKind] = useState<AttachmentKind>('URL');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const effectiveKind: AttachmentKind = mode === 'URL_ONLY' ? 'URL' : kind;

  const submit = () => {
    setError(null);
    addAttachment.mutate(
      {
        itemId,
        kind: effectiveKind,
        value,
        label: label.trim() || null,
        // Stamp the origin so a peer can later detect a foreign local pointer (§4).
        originDeviceId: effectiveKind === 'LOCAL_POINTER' ? deviceId : null,
      },
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
            <AttachmentRow
              key={att.id}
              att={att}
              deviceId={deviceId}
              onRemove={() => removeAttachment.mutate(att.id)}
              onUpdate={(input, cbs) => updateAttachment.mutate({ id: att.id, input }, cbs)}
              updating={updateAttachment.isPending}
            />
          ))
        )}
      </ul>

      <div className="space-y-2 rounded-lg border border-border bg-secondary/10 p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Add a datasheet
          </span>
          <InfoHint
            content={
              'Link reference documents — datasheets, manuals, certificates.\n\n' +
              '- **External URL** — a web link; works on every device and syncs cleanly.\n' +
              '- **Local file** *(Hybrid mode only)* — a path on *this* machine. Only the path is ' +
              'stored, so on other devices it shows as an **Unlinked Local File** to re-link.\n\n' +
              'The **label** is an optional friendly name shown instead of the raw path.'
            }
          />
        </div>
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
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
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

interface UpdateCallbacks {
  readonly onError?: (e: unknown) => void;
  readonly onSuccess?: () => void;
}
type UpdateMutate = (input: UpdateAttachmentInput, cbs?: UpdateCallbacks) => void;

/** A single datasheet row, presented per its resolved link state (§4 degradation). */
function AttachmentRow({
  att,
  deviceId,
  onRemove,
  onUpdate,
  updating,
}: {
  att: ItemAttachment;
  deviceId: string;
  onRemove: () => void;
  onUpdate: UpdateMutate;
  updating: boolean;
}) {
  const link = resolveAttachmentLink(att, deviceId);
  // For an unlinked pointer: which re-home flow the user opened, plus its draft + error.
  const [relinkMode, setRelinkMode] = useState<'local' | 'url' | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    setError(null);
    const input =
      relinkMode === 'url'
        ? ({ kind: 'URL', value: draft, originDeviceId: null } as const)
        : ({ value: draft, originDeviceId: deviceId } as const);
    onUpdate(input, {
      onError: (e: unknown) =>
        setError(e instanceof Error ? e.message : 'Could not update the datasheet.'),
      onSuccess: () => {
        setRelinkMode(null);
        setDraft('');
      },
    });
  };

  if (link.state === 'unlinked') {
    return (
      <li
        data-testid="attachment-unlinked"
        className="space-y-2 rounded-lg border border-border bg-secondary/20 px-2.5 py-2 text-sm"
      >
        <div className="flex items-center gap-2">
          <span className="text-warning [&_svg]:size-4">
            <UnlinkIcon />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">Unlinked Local File</p>
            <Tooltip
              content="This local file path was linked on another device and isn't available here. Re-link it to a path on this device, or replace it with a URL."
              openDelayMs={INFO_OPEN_DELAY_MS}
            >
              <p className="truncate text-xs text-muted-foreground" title={link.value}>
                {att.label ? `${att.label} — ${link.value}` : link.value}
              </p>
            </Tooltip>
          </div>
          <button
            type="button"
            aria-label="Remove attachment"
            onClick={onRemove}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive [&_svg]:size-3.5"
          >
            <CloseIcon />
          </button>
        </div>

        {relinkMode === null ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              data-testid="attachment-relink"
              onClick={() => {
                setRelinkMode('local');
                setDraft('');
                setError(null);
              }}
            >
              Re-link
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid="attachment-use-url"
              onClick={() => {
                setRelinkMode('url');
                setDraft('');
                setError(null);
              }}
            >
              Use URL
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              data-testid="attachment-relink-input"
              placeholder={
                relinkMode === 'url' ? 'https://…/datasheet.pdf' : '/path/on/this/device.pdf'
              }
              aria-label={relinkMode === 'url' ? 'Replacement URL' : 'New local path'}
            />
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setRelinkMode(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                data-testid="attachment-relink-confirm"
                onClick={confirm}
                disabled={!draft.trim() || updating}
              >
                {relinkMode === 'url' ? 'Replace with URL' : 'Re-link'}
              </Button>
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <li className="flex items-center gap-2 rounded-lg border border-border bg-secondary/20 px-2.5 py-1.5 text-sm">
      <span className="text-muted-foreground [&_svg]:size-4">
        {link.state === 'url' ? <LinkIcon /> : <LocalFileIcon />}
      </span>
      {link.state === 'url' ? (
        <a
          href={link.value}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate text-primary hover:underline"
        >
          {att.label || link.value}
        </a>
      ) : (
        <Tooltip
          content="**Local file pointer** — this path is only valid on the device that linked it; on other devices it shows as an unlinked local file."
          openDelayMs={INFO_OPEN_DELAY_MS}
        >
          <span className="min-w-0 flex-1 truncate" title={link.value}>
            {att.label || link.value}
          </span>
        </Tooltip>
      )}
      <button
        type="button"
        aria-label="Remove attachment"
        onClick={onRemove}
        className="rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive [&_svg]:size-3.5"
      >
        <CloseIcon />
      </button>
    </li>
  );
}
