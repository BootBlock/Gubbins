/**
 * Category-scoped capability hiding (issue #618).
 *
 * The Modules screen answers *"I never use maintenance"* — globally, for this device. It
 * cannot answer *"maintenance matters for my Tools but is noise on my Movies"*, because its
 * axis is the device, not the kind of thing an item is. A category already knows that, so it
 * carries the second axis: the set of capabilities its items simply don't have.
 *
 * Three invariants hold everything together, and every one of them is load-bearing:
 *
 * 1. **Narrowing only.** A category may hide what the device shows; it must never re-enable
 *    what the device has switched off, or the Modules screen stops being the truth about what
 *    this device displays. {@link isCapabilityVisible} is the only place that decides this.
 * 2. **Presentation only.** Hiding changes what you *see*, never what you *have*. A hidden
 *    section's data keeps syncing and keeps raising its alerts.
 * 3. **Never hide data that exists.** A section the category hides but which actually holds
 *    data is shown anyway (with a note saying why) — see {@link isCapabilityVisible}'s
 *    `hasData` argument. Silently swallowing real data is the one outcome that would make
 *    this feature a bug rather than a convenience.
 */
import { getFeature, type FeatureDef, type FeatureId } from '@/features/modules/feature-registry';

/** Shared empty set, so the common "nothing hidden" case allocates nothing. */
const EMPTY_SET: ReadonlySet<FeatureId> = new Set<FeatureId>();

/**
 * The capabilities a category may hide.
 *
 * Deliberately *not* every `capabilities`-group feature. A category describes what an item
 * **is**, so only capabilities that shape an item's own record belong here. The workflow- and
 * device-level ones are excluded on purpose:
 *
 * - `scanner` / `nfc` / `labels` / `scraping` — properties of the device and how you work,
 *   not of the thing in the box. A Movie is no less scannable than a drill.
 * - `cycle-counts` — hiding it would read as "exclude this category from stock takes", which
 *   is a *behavioural* promise this feature does not make (it is presentation only). Naming
 *   it here would be a lie the moment a cycle count included a Movie anyway.
 * - `sales` — gates a *menu action* ("record a sale"), not an item-detail section. This
 *   feature is about the fields and sections an item shows, so an action belongs to a
 *   separate decision about what a category may suppress.
 * - `warranty` — gates the whole **Asset details** section, which also holds the acquired-on
 *   date, purchase price and depreciation term. Hiding it per category would therefore be one
 *   of two wrong things: it buries an item's purchase record along with the warranty, or — if
 *   "shown when it holds data" rescues it — it does nothing at all for any item that records
 *   when it was bought, which is most of them. Splitting acquisition from warranty is the
 *   prerequisite, and that is a change to the section, not to this list.
 *
 * Every id here gates a section or sub-block of the item detail dialog whose content is
 * *only* that capability, which is what makes "hidden, unless it holds data" a meaningful and
 * honest promise for all of them.
 */
export const HIDEABLE_CAPABILITY_IDS: readonly FeatureId[] = [
  'maintenance',
  'batches',
  'perishables',
  'variants',
  'kits',
  'custom-fields',
  'tags-attachments',
  'location-photos',
];

const HIDEABLE_SET: ReadonlySet<string> = new Set<string>(HIDEABLE_CAPABILITY_IDS);

/**
 * The registry entries for {@link HIDEABLE_CAPABILITY_IDS}, in declared order — the rows the
 * picker renders, carrying the label, description and icon the Modules screen already shows.
 *
 * `getFeature` is total over `FeatureId` (the registry is typed `Record<FeatureId, FeatureDef>`,
 * so a missing entry is a compile error there, not a runtime hole here), but this filters
 * rather than asserting so a future refactor can never turn a registry gap into a crash.
 */
export const HIDEABLE_CAPABILITIES: readonly FeatureDef[] = HIDEABLE_CAPABILITY_IDS.map((id) =>
  getFeature(id),
).filter((def): def is FeatureDef => def !== undefined);

/**
 * Narrow a category's stored hidden-capability ids to the ones this build both recognises
 * *and* permits a category to hide.
 *
 * Storage keeps ids verbatim — including any written by a peer on a newer version — so that a
 * round-trip through this device can't discard a choice it doesn't understand. This is the
 * boundary where that tolerance ends: an id that isn't a hideable capability here simply has
 * no effect on what this build renders.
 */
export function toHiddenCapabilitySet(ids: readonly string[] | null | undefined): ReadonlySet<FeatureId> {
  if (ids == null || ids.length === 0) return EMPTY_SET;
  const hidden = new Set<FeatureId>();
  for (const id of ids) {
    if (HIDEABLE_SET.has(id)) hidden.add(id as FeatureId);
  }
  return hidden;
}

/** The visibility verdict for one capability-gated section, and *why* it reads that way. */
export type CapabilityVisibility =
  /** Shown normally — either ungated, or gated by a capability nothing suppresses. */
  | 'visible'
  /** Not rendered: the device's module is off, or the category hides it and it holds no data. */
  | 'hidden'
  /** The category hides this, but it holds data — shown with a note explaining why. */
  | 'shown-despite-hidden';

/**
 * Decide whether a capability-gated section is shown for an item, and why.
 *
 * The order of the tests *is* the specification:
 * device module off beats everything → category hiding narrows further → existing data
 * overrides the category's hiding, because rule 3 above outranks tidiness.
 *
 * Note the asymmetry in the first test: a device module that is off wins even when the
 * section holds data. That is deliberate and matches how Modular UI already behaves — the
 * data is still there, still synced and still reachable by switching the module back on,
 * and the Modules screen must stay the last word on what this device shows.
 *
 * @param feature  The capability gating the section, or undefined for an ungated one.
 * @param enabled  The device's effective module set.
 * @param hidden   The item's category's hidden-capability set (empty when uncategorised).
 * @param hasData  Whether this section actually holds data for the item.
 */
export function isCapabilityVisible(
  feature: FeatureId | undefined,
  enabled: ReadonlySet<FeatureId>,
  hidden: ReadonlySet<FeatureId>,
  hasData: boolean,
): CapabilityVisibility {
  if (feature === undefined) return 'visible';
  if (!enabled.has(feature)) return 'hidden';
  if (!hidden.has(feature)) return 'visible';
  return hasData ? 'shown-despite-hidden' : 'hidden';
}

/**
 * Whether a category hides anything this build acts on — the cheap guard that keeps the
 * common case free. When this is false the item detail dialog skips its data-presence probe
 * entirely, so an inventory that never hides a capability pays nothing for the feature.
 */
export function hidesAnyCapability(ids: readonly string[] | null | undefined): boolean {
  return toHiddenCapabilitySet(ids).size > 0;
}

/**
 * Toggle one capability in a category's hidden set, returning the new array to store.
 *
 * Sorted and de-duplicated so that toggling a capability off and on again reproduces the
 * exact stored value — an editor that produced a differently-ordered array would look like
 * an edit to LWW sync and churn the row for no reason.
 */
export function toggleHiddenCapability(
  current: readonly string[],
  id: FeatureId,
  hide: boolean,
): readonly string[] {
  const next = new Set(current);
  if (hide) next.add(id);
  else next.delete(id);
  return [...next].sort();
}
