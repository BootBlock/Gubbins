import { useMemo, type ReactNode, type Ref } from 'react';
import { AutocompleteField, LiveRegion } from '@/components/foundry';
import { useT } from '@/features/i18n';
import { isSameSupplierName, normaliseSupplierName } from '@/lib/supplier-name';
import { useSuppliers } from '../queries';
import type { SupplierPickerValue } from '../supplier-picker-value';

/**
 * How many suppliers the type-ahead offers as the user types. Matches the page
 * {@link useSuppliers} reads, so narrowing a long dictionary is never cut short at the
 * type-ahead default of ten. Browsing the list from the chevron shows every name regardless.
 */
const SUPPLIER_OPTION_LIMIT = 100;

export interface SupplierPickerProps {
  readonly value: SupplierPickerValue;
  readonly onChange: (value: SupplierPickerValue) => void;
  /** Field label; defaults to the translated "Supplier". */
  readonly label?: ReactNode;
  /** Rich-Markdown help for the InfoHint badge; defaults to the picker's own explanation. */
  readonly hint?: string;
  /** Validation message, announced and wired to the control exactly as on a FormField. */
  readonly error?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly 'data-testid'?: string;
}

/**
 * The app-wide supplier picker (issue #384) — the one control through which a supplier is
 * named, on a supplier part or a purchase order.
 *
 * Suppliers are a real entity now, but entry stays as low-friction as the free-text field it
 * replaces: this is an **editable** combobox, so an existing supplier is one keystroke away
 * from the list *and* a supplier you have never used before is created simply by typing it.
 * Nobody is sent to a setup screen first.
 *
 * The duplicate-prevention win is made visible rather than silent: because
 * {@link isSameSupplierName} folds case, spacing and punctuation, typing `rs-components`
 * resolves to your existing `RS Components` — so the control says so, under the field and in
 * a live region, before you commit. A name that folds onto nothing is announced as a new
 * supplier, so "I am creating one" is never a surprise either.
 *
 * Built by composing Foundry's {@link AutocompleteField}, so the APG editable-combobox
 * wiring — `role="combobox"`, the `aria-activedescendant` listbox, arrow/Home/End/Enter
 * keyboard handling, Escape closing the list rather than the dialog, and the labelled
 * hint/error plumbing — is the one implementation the glyph and category pickers use, not a
 * second one that could drift.
 */
export function SupplierPicker({
  value,
  onChange,
  label,
  hint,
  error,
  placeholder,
  disabled,
  id,
  className,
  inputRef,
  'data-testid': testId,
}: SupplierPickerProps) {
  const t = useT();
  const { data } = useSuppliers();
  const suppliers = useMemo(() => data?.rows ?? [], [data]);
  /**
   * True when the dictionary is larger than the page we hold, so a name we cannot find here
   * might still exist. The write is unaffected either way — `resolveOrCreate` folds the name
   * against the whole table — but we must not *claim* a supplier is new when we cannot see it.
   */
  const partialList = data?.hasMore ?? false;
  const names = useMemo(() => suppliers.map((s) => s.name), [suppliers]);

  const typed = normaliseSupplierName(value.name);
  /** The supplier this text folds onto, under the canonical name key. */
  const match = useMemo(
    () => (typed.length === 0 ? undefined : suppliers.find((s) => isSameSupplierName(s.name, typed))),
    [suppliers, typed],
  );

  const handleChange = (next: string) => {
    const name = normaliseSupplierName(next);
    const resolved = name.length === 0 ? undefined : suppliers.find((s) => isSameSupplierName(s.name, name));
    onChange({ supplierId: resolved?.id ?? null, name: next });
  };

  /**
   * The status under the field. Silent while blank, or when the text already *is* the
   * supplier's canonical spelling — there is nothing to tell the user then. It speaks up
   * exactly when the outcome would otherwise be invisible: a differently-spelled name that
   * folds onto one you have, or a name that will create a supplier.
   */
  let status: string | null = null;
  if (typed.length > 0) {
    if (match && match.name !== typed) {
      status = t('supplier.picker.matchesExisting', { vars: { name: match.name } });
    } else if (!match && !partialList) {
      // Suppressed when the list is truncated: "will be added" would be a claim we cannot
      // back, and saying nothing is better than saying something false. A match we CAN see is
      // still reported above, since that one is certain.
      status = t('supplier.picker.createsNew', { vars: { name: typed } });
    }
  }

  return (
    <div className={className}>
      <AutocompleteField
        label={label ?? t('supplier.picker.label')}
        hint={hint ?? t('supplier.picker.hint')}
        inputRef={inputRef}
        id={id}
        value={value.name}
        onChange={handleChange}
        suggestions={names}
        // A supplier dictionary is a browsable list, not a long-tail one: typing a common
        // fragment should narrow to what you actually have, not to the first ten of it.
        maxOptions={SUPPLIER_OPTION_LIMIT}
        error={error}
        placeholder={placeholder ?? t('supplier.picker.placeholder')}
        disabled={disabled}
        data-testid={testId}
      />
      {/* Always mounted so the message is announced when it appears, not inserted with it. */}
      <LiveRegion className="mt-1 text-xs text-muted-foreground">
        {status !== null ? <span data-testid="supplier-picker-status">{status}</span> : null}
      </LiveRegion>
    </div>
  );
}
