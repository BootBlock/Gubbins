import { useEffect, useId, useMemo, useState } from 'react';
import { Button, Input, LiveRegion, Modal, Select } from '@/components/foundry';
import { useFormatters } from '@/lib/useFormatters';
import {
  CONDITIONS,
  type Condition,
  type LocationWithCount,
} from '@/db/repositories';
import { CONDITION_LABELS } from './inventory-ui';
import { useCategories } from '../categories';
import { useBulkEditItems } from '../mutations';
import { buildItemLocationOptions } from '../parent-options';
import { LocationSelect } from './LocationSelect';
import {
  isBulkEditEmpty,
  parseTagInput,
  type BulkEditSpec,
  type TagEditMode,
} from '../bulk-edit';

/**
 * Bulk-edit dialog (Phase 76) — apply category / location / condition / active-state / tags
 * across every selected item at once. Each field has an **enable** checkbox so an untouched
 * field is genuinely left alone (distinct from "set to None"). The actual writes route through
 * the existing repository methods via `useBulkEditItems`; this is pure glue + design tokens.
 *
 * Accessibility: an always-mounted `<LiveRegion>` announces the outcome once the batch resolves
 * (Phase 63 / WCAG 4.1.3).
 */
export function BulkEditDialog({
  open,
  onClose,
  itemIds,
  locations,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  itemIds: readonly string[];
  locations: readonly LocationWithCount[];
  onApplied?: () => void;
}) {
  const f = useFormatters();
  const categories = useCategories();
  const bulkEdit = useBulkEditItems();
  const locationOptions = useMemo(
    () => buildItemLocationOptions(locations, f.quantity),
    [locations, f],
  );
  const firstLocationId = locationOptions[0]?.value ?? '';
  const locationLabelId = useId();

  // Per-field enable + value state. The enable flag is the wrapper-presence the spec needs.
  const [catOn, setCatOn] = useState(false);
  const [catValue, setCatValue] = useState(''); // '' ⇒ clear (uncategorised)
  const [locOn, setLocOn] = useState(false);
  const [locValue, setLocValue] = useState(firstLocationId);
  const [condOn, setCondOn] = useState(false);
  const [condValue, setCondValue] = useState(''); // '' ⇒ clear (untracked)
  const [activeOn, setActiveOn] = useState(false);
  const [activeValue, setActiveValue] = useState<'active' | 'removed'>('active');
  const [tagsOn, setTagsOn] = useState(false);
  const [tagMode, setTagMode] = useState<TagEditMode>('add');
  const [tagText, setTagText] = useState('');

  const [announcement, setAnnouncement] = useState('');

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setCatOn(false); setCatValue('');
    setLocOn(false); setLocValue(firstLocationId);
    setCondOn(false); setCondValue('');
    setActiveOn(false); setActiveValue('active');
    setTagsOn(false); setTagMode('add'); setTagText('');
    setAnnouncement('');
  }, [open, firstLocationId]);

  const spec: BulkEditSpec = useMemo(() => {
    const tagNames = parseTagInput(tagText);
    return {
      ...(catOn ? { category: { value: catValue === '' ? null : catValue } } : {}),
      ...(locOn && locValue ? { location: { value: locValue } } : {}),
      ...(condOn ? { condition: { value: condValue === '' ? null : (condValue as Condition) } } : {}),
      ...(activeOn ? { active: { value: activeValue === 'active' } } : {}),
      ...(tagsOn && tagNames.length > 0 ? { tags: { mode: tagMode, names: tagNames } } : {}),
    };
  }, [catOn, catValue, locOn, locValue, condOn, condValue, activeOn, activeValue, tagsOn, tagMode, tagText]);

  const nothingToDo = isBulkEditEmpty(spec) || itemIds.length === 0;

  const apply = async () => {
    if (nothingToDo) return;
    const result = await bulkEdit.mutateAsync({ ids: itemIds, spec });
    setAnnouncement(
      result.failed > 0
        ? `Updated ${result.succeeded} item${result.succeeded === 1 ? '' : 's'}; ${result.failed} failed.`
        : `Updated ${result.succeeded} item${result.succeeded === 1 ? '' : 's'}.`,
    );
    onApplied?.();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Bulk edit"
      description={`Apply changes to ${itemIds.length} selected item${itemIds.length === 1 ? '' : 's'}.`}
    >
      <div className="max-h-[72vh] space-y-3 dialog-scroll">
        {/* Category ----------------------------------------------------- */}
        <FieldRow enabled={catOn} onToggle={setCatOn} label="Category" testId="bulk-field-category">
          <Select value={catValue} onChange={(e) => setCatValue(e.target.value)} disabled={!catOn} aria-label="New category">
            <option value="">— Clear (uncategorised) —</option>
            {(categories.data?.rows ?? []).map((cat) => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </Select>
        </FieldRow>

        {/* Location ----------------------------------------------------- */}
        <FieldRow enabled={locOn} onToggle={setLocOn} label="Location" testId="bulk-field-location">
          <span id={locationLabelId} className="sr-only">New location</span>
          <LocationSelect
            labelledBy={locationLabelId}
            value={locValue}
            onChange={setLocValue}
            options={locationOptions}
          />
        </FieldRow>

        {/* Condition ---------------------------------------------------- */}
        <FieldRow enabled={condOn} onToggle={setCondOn} label="Condition" testId="bulk-field-condition">
          <Select value={condValue} onChange={(e) => setCondValue(e.target.value)} disabled={!condOn} aria-label="New condition">
            <option value="">— Clear (untracked) —</option>
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>{CONDITION_LABELS[c]}</option>
            ))}
          </Select>
        </FieldRow>

        {/* Active-state ------------------------------------------------- */}
        <FieldRow enabled={activeOn} onToggle={setActiveOn} label="State" testId="bulk-field-active">
          <Select
            value={activeValue}
            onChange={(e) => setActiveValue(e.target.value as 'active' | 'removed')}
            disabled={!activeOn}
            aria-label="New state"
          >
            <option value="active">Active</option>
            <option value="removed">Removed</option>
          </Select>
        </FieldRow>

        {/* Tags --------------------------------------------------------- */}
        <FieldRow enabled={tagsOn} onToggle={setTagsOn} label="Tags" testId="bulk-field-tags">
          <div className="flex flex-col gap-2">
            <Select
              value={tagMode}
              onChange={(e) => setTagMode(e.target.value as TagEditMode)}
              disabled={!tagsOn}
              aria-label="Tag mode"
            >
              <option value="add">Add to existing tags</option>
              <option value="replace">Replace all tags</option>
            </Select>
            <Input
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              disabled={!tagsOn}
              placeholder="Comma-separated, e.g. fragile, restock"
              aria-label="Tag names"
            />
          </div>
        </FieldRow>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            onClick={apply}
            disabled={nothingToDo || bulkEdit.isPending}
            data-testid="bulk-edit-apply"
          >
            {bulkEdit.isPending ? 'Applying…' : 'Apply'}
          </Button>
        </div>
      </div>

      <LiveRegion visuallyHidden data-testid="bulk-edit-live-region">
        {announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
    </Modal>
  );
}

/**
 * One enable-gated field row: a checkbox+label that arms the control beneath it. The checkbox
 * owns its own `<label>` (toggling on the text); the control below carries its own `aria-label`
 * so the two never share an implicit label association.
 */
function FieldRow({
  enabled,
  onToggle,
  label,
  testId,
  children,
}: {
  enabled: boolean;
  onToggle: (on: boolean) => void;
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="size-3.5 accent-primary"
          data-testid={testId}
        />
        {label}
      </label>
      <div className={enabled ? undefined : 'opacity-50'}>{children}</div>
    </div>
  );
}
