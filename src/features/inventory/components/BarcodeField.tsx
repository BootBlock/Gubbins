import { useState } from 'react';
import { Button, FormField, Input, LiveRegion } from '@/components/foundry';
import { ScanIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { useFeature } from '@/features/modules/useFeature';
import { canonicaliseBarcode, describeGtinConcern } from '@/features/scanner/gtin';
import { useBarcodeCarriers } from '../queries';

export interface BarcodeFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Forwarded to the input, so a form library still sees the field being left. */
  readonly onBlur?: () => void;
  /** Open the camera scanner; the button is hidden when the `scanner` capability is off. */
  readonly onScan: () => void;
  readonly inputTestId: string;
  readonly scanTestId: string;
  /**
   * The item being edited, so the duplicate advisory never reports the item against itself.
   * Omitted when the field is on the Add-item form, where there is no record to exclude yet.
   */
  readonly itemId?: string;
}

/**
 * The **Barcode** field shared by the Add-item dialog and the item's details editor — the
 * labelled GTIN input, its rich help, and the "Scan" button that fills it from the camera.
 *
 * It also carries the typed-entry sanity check (issue #344). A camera scan is already
 * check-digit-validated on the way in, but a *hand-typed* barcode was accepted verbatim: a
 * single transposed digit saved silently and the item then never resolved on a re-scan,
 * because barcode lookup is an exact match (see `features/scanner/gtin`). The judgement is
 * the pure {@link describeGtinConcern}, surfaced as an **advisory warning** rather than a
 * validation error — the field legitimately holds non-retail codes, so the entry always
 * saves; the user simply gets told it looks wrong.
 *
 * It also says when the barcode is **already recorded against another item** (issue #513). That
 * is legitimate — two variants of one product, a multipack sharing its unit's GTIN — so it is an
 * advisory in the same non-blocking style, not a rejection. What it buys the user is knowing in
 * advance why a later scan of that code will stop and ask which item was meant, instead of
 * meeting the question with no idea where the duplicate came from.
 *
 * Leaving the field is also where a typed **UPC-E** — the squeezed 8-digit code on small
 * packaging — is replaced by the 12-digit UPC-A it compresses (issue #508), so a code typed off
 * the pack and the same code scanned from it store the same value.
 *
 * The warning waits for **blur**, because a half-typed GTIN is transiently wrong at almost
 * every keystroke (`400638133393` is a valid UPC-A *width* on the way to a 13-digit EAN) and
 * a message that flickers per keystroke is noise, not help. Editing again clears it until the
 * user next leaves the field. A value the user did *not* type — the stored barcode of an item
 * being edited, or one that arrives when the editor switches items — is judged straight away,
 * since it is finished by definition and is exactly the mistake the user has so far had no way
 * to discover.
 */
export function BarcodeField({
  value,
  onChange,
  onBlur,
  onScan,
  inputTestId,
  scanTestId,
  itemId,
}: BarcodeFieldProps) {
  const t = useT();
  const scannerEnabled = useFeature('scanner');
  // Mid-keystroke is the *only* state that suppresses the check, so a value that arrives from
  // anywhere else — an item's stored barcode, a switch to another item, a camera capture — is
  // judged the moment it lands, with no interaction needed to reveal it.
  const [editing, setEditing] = useState(false);
  // What the field last replaced a typed UPC-E with, announced once so the rewrite is not a
  // silent change for a screen-reader user, who has no way to see the digits count go up.
  const [expanded, setExpanded] = useState('');

  const concern = editing ? null : describeGtinConcern(value);
  // Judged on the same beat as the check-digit concern — a blank value mid-keystroke disables the
  // read, so a half-typed GTIN costs no round-trip and the two advisories never disagree about
  // when they apply.
  const carriers = useBarcodeCarriers(editing ? '' : value);
  const alsoCarrying = (carriers.data ?? []).filter((other) => other.id !== itemId);
  const warning =
    concern === 'check-digit'
      ? t('inventory.barcode.warning.checkDigit')
      : concern === 'length'
        ? t('inventory.barcode.warning.length')
        : alsoCarrying.length > 0
          ? t('inventory.barcode.warning.duplicate', {
              vars: { count: alsoCarrying.length, name: alsoCarrying[0]!.name },
            })
          : '';

  // The Scan button sits beside the field (issues #8/#52) but *outside* the FormField's
  // `<label>` — so it never folds into the input's accessible name and clicking it can't be
  // mistaken for the label. It is top-aligned past a spacer that mirrors the label's own line
  // (same type + `mb-field-gap`), rather than bottom-aligned to the field: the field's height
  // now changes when the advisory warning appears, and bottom-alignment would drag the button
  // down with it. The spacer is decorative, so it is hidden from assistive tech.
  return (
    <div className="flex items-start gap-2">
      <FormField
        className="flex-1"
        label={t('inventory.barcode.label')}
        hintSize="lg"
        hint={t('inventory.barcode.hint')}
        warning={warning}
      >
        <Input
          inputMode="numeric"
          placeholder={t('inventory.barcode.placeholder')}
          value={value}
          onChange={(e) => {
            setEditing(true);
            setExpanded('');
            onChange(e.target.value);
          }}
          onBlur={() => {
            // A typed UPC-E is replaced by the UPC-A it compresses, so the stored value is the
            // one a camera scan of that pack produces (issue #508). Only on a value the user
            // actually typed: an item's existing barcode must never change just because the
            // field was focused and left.
            if (editing) {
              const canonical = canonicaliseBarcode(value);
              if (canonical !== value) {
                onChange(canonical);
                setExpanded(canonical);
              }
            }
            setEditing(false);
            onBlur?.();
          }}
          data-testid={inputTestId}
        />
      </FormField>
      <LiveRegion visuallyHidden>
        {expanded ? <p>{t('inventory.barcode.expanded', { vars: { barcode: expanded } })}</p> : null}
      </LiveRegion>
      {scannerEnabled ? (
        <div className="flex flex-col">
          <span className="mb-field-gap block text-sm font-medium" aria-hidden>
            &nbsp;
          </span>
          <Button type="button" variant="outline" onClick={onScan} data-testid={scanTestId}>
            <ScanIcon aria-hidden />
            {t('inventory.barcode.scan')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
