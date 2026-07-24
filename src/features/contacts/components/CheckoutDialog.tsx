import { useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Button, Checkbox, Input, Modal, SelectField } from '@/components/foundry';
import { CheckoutIcon, LinkIcon } from '@/components/icons';
import type { BorrowerType, CheckoutItemInput, Item, ItemBatchPlacement } from '@/db/repositories';
import { isDefaultBatch } from '@/features/inventory/batches';
import { useItemBatches, useItemStock } from '@/features/lifecycle/hooks';
import { useItemRelations, useItemsById, useLocations } from '@/features/inventory/queries';
import { missingRequirementsOf } from '@/features/inventory/item-requirements';
import { itemDisplayName } from '@/features/inventory/item-display';
import { useProjects } from '@/features/projects/projects';
import { useFeature } from '@/features/modules/useFeature';
import { useContacts, useCheckoutItem } from '../contacts';
import { addCalendarDays } from '@/lib/calendar-days';
import { useErrorMessage } from '@/features/errors';

/** Sentinel for "lend whatever FEFO picks" — distinct from the untracked default key (''). */
const ANY_LOT = ' any';

/** A human label for a tracked lot: its batch/lot number, else a bare "Untracked". */
function lotLabel(b: ItemBatchPlacement): string {
  if (b.batchNumber && b.lotNumber) return `Batch ${b.batchNumber} · Lot ${b.lotNumber}`;
  if (b.batchNumber) return `Batch ${b.batchNumber}`;
  if (b.lotNumber) return `Lot ${b.lotNumber}`;
  return 'Untracked';
}

/**
 * How much of `item` is lendable, in the unit its tracking mode counts in — the same figure the
 * dialog shows for the item being checked out. A gauge item is a single vessel, so it lends as one.
 */
function lendableQty(item: Item): number {
  return item.trackingMode === 'DISCRETE' ? item.quantity : 1;
}

/**
 * Check an item out to a contact (spec §4 Borrowing & Checking Out, Phase 6).
 *
 * Low-friction contacts (§4 Ergonomics): the name box is a free-text field backed
 * by a `<datalist>` of existing contacts — typing a brand-new name auto-creates the
 * contact on submit (the repository resolves-or-creates). Discrete items can lend
 * several units; serialised/gauge are pinned. A due date is optional (§4 Due Dates),
 * set via quick presets or a date picker.
 */
export function CheckoutDialog({ open, onClose, item }: { open: boolean; onClose: () => void; item: Item }) {
  const contacts = useContacts();
  const projects = useProjects();
  const locations = useLocations();
  const projectsOn = useFeature('projects');
  const checkout = useCheckoutItem();
  const stock = useItemStock(item.id);
  const itemBatches = useItemBatches(item.id);
  // The borrower is a tagged union (B4): a loan targets a contact (a person), a project ("out
  // on the Henderson job") or a location ("in the van"). The target-type choice drives which
  // picker shows; the contact path keeps the low-friction type-a-name-to-create convenience,
  // while project/location are picked from existing rows.
  const [targetType, setTargetType] = useState<BorrowerType>('contact');
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [dueDate, setDueDate] = useState(''); // yyyy-mm-dd, '' = none
  const [fromLocationId, setFromLocationId] = useState<string>(item.locationId);
  const [fromBatchKey, setFromBatchKey] = useState(ANY_LOT);
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();
  const nameRef = useRef<HTMLInputElement>(null);

  // --- Prerequisites (issue #70) ------------------------------------------------------------
  // A `REQUIRES` relation asserts this item is unusable without another; lending it without the
  // prerequisite is the mistake the feature exists to catch. The pure seam decides *which*
  // relations qualify; this reads their items so each can show its stock and be lent alongside.
  const { data: relations } = useItemRelations(item.id);
  const requirements = useMemo(() => missingRequirementsOf(item.id, relations ?? []), [item.id, relations]);
  const requiredIds = useMemo(() => requirements.map((r) => r.requiredItemId), [requirements]);
  const { data: requiredItems } = useItemsById(requiredIds);
  // Prerequisites that still exist as items, paired with what they have on hand. A required item
  // that has since been deleted simply drops out rather than showing an un-actionable row.
  const prerequisites = useMemo(
    () =>
      requiredIds
        .map((id) => requiredItems?.get(id))
        .filter((i): i is Item => i !== undefined)
        .map((i) => ({ item: i, available: lendableQty(i) })),
    [requiredIds, requiredItems],
  );

  // Which prerequisites to lend alongside. Seeded to every in-stock one each time the dialog
  // opens (the common case is "yes, bring it too"), and re-seeded when the set itself changes.
  const [alsoLend, setAlsoLend] = useState<ReadonlySet<string>>(new Set());
  // True once this dialog's main loan has been committed — so a retry after a *prerequisite*
  // failure doesn't lend the main item a second time. Reset whenever the dialog opens *or* the
  // item changes: a caller that swaps `item` while staying open (the scanner mounts the dialog
  // with a literal `open`) must not have the new item's loan skipped by the old one's flag.
  const [mainLent, setMainLent] = useState(false);
  // Re-entrancy latch. `checkout.isPending` only updates on re-render, so two submits fired in
  // the same tick — Enter is not gated by the button's disabled state — would both observe
  // `mainLent === false` and lend the item twice. A ref settles synchronously.
  const submitting = useRef(false);

  const prerequisiteKey = prerequisites.map((p) => p.item.id).join('|');
  useEffect(() => {
    if (!open) return;
    setAlsoLend(new Set(prerequisites.filter((p) => p.available > 0).map((p) => p.item.id)));
    // `prerequisiteKey` stands in for the identity of the prerequisite set — re-seed only when
    // *which* items are required changes, not on every stock refetch (which would tick a box the
    // user had deliberately cleared).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prerequisiteKey]);

  useEffect(() => {
    if (open) setMainLent(false);
  }, [open, item.id]);

  // Project is only offered when the Projects module is on; contacts and locations are always
  // available (the loan flow itself is gated on Contacts upstream).
  const targetOptions = useMemo(
    () => [
      { value: 'contact' as const, label: 'A person (contact)' },
      ...(projectsOn ? [{ value: 'project' as const, label: 'A project' }] : []),
      { value: 'location' as const, label: 'A location' },
    ],
    [projectsOn],
  );

  const projectRows = projects.data?.rows ?? [];
  const locationRows = locations.data?.rows ?? [];

  // Whether a borrower has been chosen for the active target type — drives submit-enablement.
  const hasBorrower =
    targetType === 'contact'
      ? name.trim().length > 0
      : targetType === 'project'
        ? projectId.length > 0
        : locationId.length > 0;

  const isDiscrete = item.trackingMode === 'DISCRETE';
  // Per-location source (Phase 26): only when the item's stock is genuinely split across
  // more than one location is a lend-from choice meaningful; otherwise the single
  // placement is used silently. The available quantity follows the chosen placement.
  const placements = useMemo(() => stock.data ?? [], [stock.data]);
  const isSplit = isDiscrete && placements.length > 1;
  // Per-lot source (Phase 29): the lots sitting at the *resolved* source placement (the chosen
  // location when split, else the item's primary). When any is a tracked lot, the user may lend
  // a specific one rather than the FEFO default; the available figure then follows that lot.
  const sourceLocId = isSplit ? fromLocationId : item.locationId;
  const lotsHere = (itemBatches.data ?? []).filter((b) => b.locationId === sourceLocId && b.quantity > 0);
  const canPickLot = isDiscrete && lotsHere.some((b) => !isDefaultBatch(b.batchKey));
  const selectedLot =
    fromBatchKey !== ANY_LOT ? lotsHere.find((b) => b.batchKey === fromBatchKey) : undefined;
  const placementHere = isSplit
    ? (placements.find((p) => p.locationId === fromLocationId)?.quantity ?? 0)
    : item.quantity;
  const availableHere = selectedLot ? selectedLot.quantity : placementHere;
  const maxQty = isDiscrete ? availableHere : 1;

  // Default the source to the busiest placement once the breakdown loads.
  useEffect(() => {
    if (isSplit && !placements.some((p) => p.locationId === fromLocationId)) {
      setFromLocationId(placements[0]!.locationId);
    }
  }, [isSplit, placements, fromLocationId]);

  // Keep the requested quantity within what the chosen placement holds.
  useEffect(() => {
    setQuantity((q) => Math.max(1, Math.min(maxQty || 1, q)));
  }, [maxQty]);

  const presets = useMemo(
    () => [
      { label: '1 week', days: 7 },
      { label: '2 weeks', days: 14 },
      { label: '1 month', days: 30 },
    ],
    [],
  );

  const setPreset = (days: number) => {
    // Whole calendar days from today (issue #325), so "1 month" lands on the same date regardless
    // of a DST change in between rather than slipping an hour and, near midnight, a day.
    const d = new Date(addCalendarDays(Date.now(), days));
    setDueDate(d.toISOString().slice(0, 10));
  };

  const submit = async () => {
    if (submitting.current) return;
    setError(null);
    if (!hasBorrower) {
      setError(
        targetType === 'contact'
          ? 'Enter who is borrowing this.'
          : targetType === 'project'
            ? 'Pick a project to loan this to.'
            : 'Pick a location to loan this to.',
      );
      return;
    }
    const dueMs = dueDate ? new Date(`${dueDate}T23:59:59`).getTime() : null;
    // Exactly one borrower target per the tagged union (B4): a contact name (resolve-or-create),
    // an existing project id, or an existing location id. Every loan in this submit shares it —
    // for a contact the resolve-or-create settles on the same person for each.
    const borrower: Pick<CheckoutItemInput, 'contactName' | 'projectId' | 'locationId'> =
      targetType === 'contact'
        ? { contactName: name.trim() }
        : targetType === 'project'
          ? { projectId }
          : { locationId };

    submitting.current = true;
    try {
      // The main item first: if it can't be lent there is nothing to bring prerequisites along
      // *for*, so nothing is committed. `mainLent` guards the retry path below — a second submit
      // after a prerequisite failure must not lend this item twice.
      if (!mainLent) {
        try {
          await checkout.mutateAsync({
            itemId: item.id,
            ...borrower,
            quantity: isDiscrete ? quantity : 1,
            dueDate: dueMs,
            // Only send a source when the stock is split; otherwise the repository defaults
            // to the item's primary placement (Phase 26).
            fromLocationId: isSplit ? fromLocationId : undefined,
            // A specific lot to lend (Phase 29); omitted lets the repository draw FEFO.
            fromBatchKey: selectedLot ? selectedLot.batchKey : undefined,
          });
          setMainLent(true);
        } catch (e) {
          setError(describeError(e, 'Could not check the item out.'));
          return;
        }
      }

      // Then each ticked prerequisite, independently (issue #70). One unit each — the prompt is
      // "bring the thing it needs", not a quantity decision — and from wherever the repository
      // defaults to, since the user picked the item, not a placement. A failure is reported rather
      // than swallowed, and leaves that prerequisite ticked so a retry sends only what's left.
      const lent = new Set<string>();
      const failed: string[] = [];
      for (const { item: required } of prerequisites) {
        if (!alsoLend.has(required.id)) continue;
        try {
          await checkout.mutateAsync({
            itemId: required.id,
            ...borrower,
            quantity: 1,
            dueDate: dueMs,
          });
          lent.add(required.id);
        } catch {
          failed.push(itemDisplayName(required.name, required.serialNo));
        }
      }
      if (failed.length > 0) {
        setAlsoLend((prev) => new Set([...prev].filter((id) => !lent.has(id))));
        setError(
          `${item.name} was checked out, but ${failed.join(', ')} could not be — check the stock on hand, then try again.`,
        );
        return;
      }
    } finally {
      submitting.current = false;
    }

    setName('');
    setProjectId('');
    setLocationId('');
    setQuantity(1);
    setDueDate('');
    setFromBatchKey(ANY_LOT);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Check out" description={item.name} initialFocusRef={nameRef}>
      <div className="space-y-4">
        <SelectField
          label="Loan to"
          value={targetType}
          onChange={(value) => {
            setTargetType(value as BorrowerType);
            setError(null);
          }}
          data-testid="checkout-target-type"
          options={targetOptions}
        />

        {targetType === 'contact' ? (
          <label className="block">
            <span className="mb-field-gap block text-sm font-medium">Borrower</span>
            <Input
              ref={nameRef}
              list="contact-suggestions"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder="Type a name — new names are added automatically"
            />
            <datalist id="contact-suggestions">
              {contacts.data?.rows.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </label>
        ) : targetType === 'project' ? (
          <SelectField
            label="Project"
            value={projectId}
            onChange={setProjectId}
            data-testid="checkout-project"
            placeholder="Choose a project…"
            options={projectRows.map((p) => ({ value: p.id, label: p.name }))}
          />
        ) : (
          <SelectField
            label="Location"
            value={locationId}
            onChange={setLocationId}
            data-testid="checkout-location"
            placeholder="Choose a location…"
            options={locationRows.map((l) => ({ value: l.id, label: l.name }))}
          />
        )}

        {isSplit ? (
          <div>
            <SelectField
              label="Lend from"
              value={fromLocationId}
              onChange={(value) => {
                setFromLocationId(value);
                setFromBatchKey(ANY_LOT); // the lot list belongs to the placement — reset on change
              }}
              data-testid="checkout-from-location"
              options={placements.map((p) => ({
                value: p.locationId,
                label: `${p.locationName} (${p.quantity})`,
              }))}
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              Returned stock goes back to this location.
            </span>
          </div>
        ) : null}

        {canPickLot ? (
          <div>
            <SelectField
              label="Lend from lot"
              value={fromBatchKey}
              onChange={setFromBatchKey}
              data-testid="checkout-from-lot"
              options={[
                { value: ANY_LOT, label: 'Any (soonest expiry)' },
                ...lotsHere.map((b) => ({ value: b.batchKey, label: `${lotLabel(b)} (${b.quantity})` })),
              ]}
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              A returned unit goes back to this exact lot.
            </span>
          </div>
        ) : null}

        {isDiscrete ? (
          <label className="block">
            <span className="mb-field-gap block text-sm font-medium">Quantity</span>
            <Input
              type="number"
              // Clamped-on-keystroke controlled field: it can't hold an intermediate expression,
              // so the micro-calculator is opted out here (issue #93).
              calc={false}
              min={1}
              max={maxQty}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Math.min(maxQty, Number(e.target.value) || 1)))}
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              {availableHere} {isSplit ? 'available here' : 'on hand'}
            </span>
          </label>
        ) : null}

        <div>
          <span className="mb-field-gap block text-sm font-medium">Due back (optional)</span>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-44"
            />
            {presets.map((p) => (
              <Button key={p.days} variant="ghost" size="sm" onClick={() => setPreset(p.days)}>
                {p.label}
              </Button>
            ))}
            {dueDate ? (
              <Button variant="ghost" size="sm" onClick={() => setDueDate('')}>
                Clear
              </Button>
            ) : null}
          </div>
        </div>

        {/* Prerequisites (issue #70): a soft, non-blocking prompt — the loan can always go ahead
            without them. Each in-stock prerequisite starts ticked; one with nothing on hand is
            shown but not selectable, so the gap is visible rather than silently omitted. */}
        {prerequisites.length > 0 ? (
          <Banner
            tone="warning"
            icon={<LinkIcon />}
            heading={prerequisites.length === 1 ? 'This item requires another' : 'This item requires others'}
            data-testid="checkout-prerequisites"
          >
            <p className="mb-2">Check these out at the same time?</p>
            <ul className="flex flex-col gap-1.5">
              {prerequisites.map(({ item: required, available }) => (
                <li key={required.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={alsoLend.has(required.id)}
                      disabled={available <= 0}
                      data-testid={`checkout-prerequisite-${required.id}`}
                      onChange={(e) =>
                        setAlsoLend((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(required.id);
                          else next.delete(required.id);
                          return next;
                        })
                      }
                    />
                    <span className="flex-1 truncate font-medium text-foreground">
                      {itemDisplayName(required.name, required.serialNo)}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums">
                      {available > 0 ? `${available} on hand` : 'none on hand'}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </Banner>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={checkout.isPending || !hasBorrower}>
            <CheckoutIcon />
            Check out
          </Button>
        </div>
      </div>
    </Modal>
  );
}
