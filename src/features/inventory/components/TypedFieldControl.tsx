import { useRef, useState } from 'react';
import { Checkbox, Input, Select, Spinner, Textarea, useRovingRadioGroup } from '@/components/foundry';
import { CloseIcon, UploadIcon } from '@/components/icons';
import { encodeFieldImage } from '@/features/images/compression';
import { useErrorMessage } from '@/features/errors';
import { useT } from '@/features/i18n';
import { assertExhaustive } from '@/lib/exhaustive';
import { cn } from '@/lib/utils';
import { isImageDataUrl } from '../custom-fields';
import type { FieldType } from '@/db/repositories';

/** ARIA validation wiring (aria-invalid/describedby) to spread onto the primary control. */
export interface TypedFieldControlAria {
  readonly 'aria-invalid'?: true;
  readonly 'aria-describedby'?: string;
}

export interface TypedFieldControlProps {
  readonly fieldType: FieldType;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /**
   * Fired when the control loses focus — for a caller that edits a local draft and commits
   * once per edit rather than per keystroke (see `LocationFieldValueInput`). The toggle
   * types (BOOLEAN / ON_OFF / SELECT) commit on selection, so they have no separate blur
   * step and deliberately don't wire this.
   */
  readonly onBlur?: () => void;
  /** SELECT's choice list; ignored for other types. */
  readonly options?: readonly string[] | null;
  readonly controlProps?: TypedFieldControlAria;
  /** Names the control directly — for a caller with no referenceable label id (e.g. FormField). */
  readonly ariaLabel?: string;
  /** Names the control via `aria-labelledby` — for a caller that renders its own label span with an id. */
  readonly labelId?: string;
}

/**
 * The one place a category custom field's *value* is rendered as its declared
 * {@link FieldType} — shared by the per-item Custom Fields editor (Edit item dialog)
 * and the category schema's Default-value control (Categories & schemas dialog), so
 * setting a field's default feels exactly like setting its value on an item.
 *
 * Deliberately renders no wrapping `<label>` of its own: every control (including the
 * BOOLEAN/ON_OFF toggles, which aren't natively labelable via wrapping) names itself
 * via `ariaLabel`/`labelId`, so a caller may freely wrap this in its own single
 * `<label>` without ever nesting two.
 */
export function TypedFieldControl({
  fieldType,
  value,
  onChange,
  onBlur,
  options,
  controlProps = {},
  ariaLabel,
  labelId,
}: TypedFieldControlProps) {
  const naming = { 'aria-label': ariaLabel, 'aria-labelledby': labelId, onBlur };

  // TEXT's control, and the graceful degradation for a value that reaches us out of band —
  // shared so the two branches below can never drift apart.
  const plainTextInput = (
    <Input value={value} onChange={(e) => onChange(e.target.value)} {...naming} {...controlProps} />
  );

  switch (fieldType) {
    case 'TEXT':
      return plainTextInput;
    case 'NUMBER':
      return (
        <Input
          type="number"
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...naming}
          {...controlProps}
        />
      );
    case 'RATING':
      return (
        <Input
          type="number"
          min={1}
          max={5}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...naming}
          {...controlProps}
        />
      );
    case 'URL':
      return (
        <Input
          type="url"
          placeholder="https://…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...naming}
          {...controlProps}
        />
      );
    case 'LONG_TEXT':
      return (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} {...naming} {...controlProps} />
      );
    case 'DATE':
      return (
        <Input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...naming}
          {...controlProps}
        />
      );
    case 'BOOLEAN':
      return <YesNoToggle value={value} onChange={onChange} ariaLabel={ariaLabel} labelId={labelId} />;
    case 'ON_OFF':
      return (
        <span className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={value === 'true'}
            onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
            {...naming}
            {...controlProps}
          />
          {value === 'true' ? 'On' : 'Off'}
        </span>
      );
    case 'SELECT':
      return (
        <Select
          value={value}
          onChange={onChange}
          options={[{ value: '', label: '—' }, ...(options ?? []).map((opt) => ({ value: opt, label: opt }))]}
          aria-label={ariaLabel}
          aria-labelledby={labelId}
          aria-invalid={controlProps['aria-invalid']}
          aria-describedby={controlProps['aria-describedby']}
        />
      );
    case 'FILE':
      return (
        <Input
          type="text"
          // Gubbins stores the link, not the file — a path, UNC share, or file:// URI.
          placeholder={String.raw`\\server\share\movie.mkv  ·  file://…`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...naming}
          {...controlProps}
        />
      );
    case 'IMAGE':
      return (
        <ImageFieldControl
          value={value}
          onChange={onChange}
          ariaLabel={ariaLabel}
          labelId={labelId}
          controlProps={controlProps}
        />
      );
    default:
      // Exhaustiveness guard, mirroring `validateFieldValue`: a new FieldType must
      // extend this switch explicitly or this stops compiling — otherwise the validator
      // would loudly demand attention while the editor quietly rendered a text box (#355).
      // The runtime fallback stays, so a value arriving out of band still degrades to a
      // usable control rather than blanking the field editor.
      assertExhaustive(fieldType);
      return plainTextInput;
  }
}

/**
 * The IMAGE field control: pick an image, compress it to a bounded WebP `data:` URL
 * ({@link encodeFieldImage}) and store that string in the field value — the whole image
 * lives in the database, so it stays small and travels with sync/backup.
 *
 * Uses a `<button>` + hidden `ref`'d file input rather than a wrapping `<label>`: a caller
 * (FormField / the item editor) already wraps this control in its own `<label>`, and a
 * nested `<label>` would be invalid. The button carries the accessible name.
 */
function ImageFieldControl({
  value,
  onChange,
  ariaLabel,
  labelId,
  controlProps,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  labelId?: string;
  controlProps: TypedFieldControlAria;
}) {
  const t = useT();
  const describeError = useErrorMessage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await encodeFieldImage(file));
    } catch (err) {
      setError(describeError(err, 'That image could not be processed.'));
    } finally {
      setBusy(false);
    }
  };

  // Only a genuine image `data:` URL is ever pointed at — the same shape `validateFieldValue`
  // enforces on save (see {@link isImageDataUrl}). A value that isn't one can still reach this
  // control (a field retyped from TEXT keeps its stored text, and rows arrive from sync peers
  // and restored backups), and putting it in `src` would make the app fetch a string a peer
  // chose. Anything else reads as "no image": the picker shows, the stale value is not loaded.
  // Trimmed first, and the trimmed form is what's shown, so this accepts exactly what saving
  // does — validation trims before applying the same test.
  const trimmed = value.trim();
  const preview = isImageDataUrl(trimmed) ? trimmed : null;

  return (
    <div className="space-y-field-gap-compact">
      {value ? (
        <div className="relative inline-block">
          {preview ? (
            <img
              src={preview}
              alt={ariaLabel ? `${ariaLabel} preview` : 'Selected image'}
              className="max-h-32 rounded-lg border border-border object-contain"
            />
          ) : (
            // Say the stored value isn't an image rather than silently showing an empty
            // picker — and keep the remove control reachable, since a value this control
            // can't display is also one `validateFieldValue` will refuse to save.
            <span className="block max-w-xs rounded-lg border border-dashed border-border py-2 pl-3 pr-9 text-xs text-muted-foreground">
              {t('inventory.fields.image.notAnImage')}
            </span>
          )}
          <button
            type="button"
            aria-label="Remove image"
            onClick={() => onChange('')}
            className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-background/80 text-destructive backdrop-blur transition-colors hover:bg-background [&_svg]:size-3.5"
          >
            <CloseIcon />
          </button>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        aria-label={ariaLabel}
        aria-labelledby={labelId}
        // `aria-invalid` is not a valid attribute on a button — the image picker surfaces its
        // own errors below; we still forward `aria-describedby` so a FormField error is linked.
        aria-describedby={controlProps['aria-describedby']}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-60 [&_svg]:size-4"
      >
        {busy ? <Spinner /> : <UploadIcon />}
        {value ? 'Replace image' : 'Choose image'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        onChange={onPick}
      />
      {error ? (
        <span role="alert" className="block text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

const YES_NO_OPTIONS = [
  { value: 'false', label: 'No' },
  { value: 'true', label: 'Yes' },
] as const;

/**
 * A 2-option segmented radiogroup for a BOOLEAN field — copies the shape of
 * {@link LowStockPolicyPicker} (roving-tabindex `radiogroup`, single tab stop, arrow
 * keys move+select). A value that matches neither option (blank — no default set yet)
 * falls back to showing "No" selected without committing it: only an actual click/key
 * selection calls `onChange`, so an untouched default still submits as unset.
 */
function YesNoToggle({
  value,
  onChange,
  ariaLabel,
  labelId,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  labelId?: string;
}) {
  const selectedIndex = Math.max(
    0,
    YES_NO_OPTIONS.findIndex((o) => o.value === value),
  );
  const { refs, selectAt, onKeyDown } = useRovingRadioGroup<HTMLButtonElement>({
    count: YES_NO_OPTIONS.length,
    onSelect: (index) => onChange(YES_NO_OPTIONS[index]!.value),
  });

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={labelId}
      className="inline-flex rounded-lg border border-border bg-secondary/40 p-0.5"
    >
      {YES_NO_OPTIONS.map((option, index) => {
        const checked = index === selectedIndex;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            // `role="radio"` isn't named from its content per the ARIA accessible-name
            // spec (unlike a plain button) — it needs its own explicit label.
            aria-label={option.label}
            tabIndex={checked ? 0 : -1}
            onClick={() => selectAt(index)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              'rounded-md px-3 py-1 text-sm font-medium outline-none transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              checked
                ? 'bg-card-elevated text-foreground shadow-sm ring-1 ring-border'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
