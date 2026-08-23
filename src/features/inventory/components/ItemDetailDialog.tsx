import { type ReactNode } from 'react';
import { InfoHint, RailModal, type RailTab } from '@/components/foundry';
import {
  AssemblyIcon,
  CapabilityIcon,
  CategoryIcon,
  CostIcon,
  DatabaseIcon,
  DatasheetIcon,
  DueDateIcon,
  EditIcon,
  GaugeIcon,
  HistoryIcon,
  ImageIcon,
  LinkIcon,
  LocationOtherIcon,
  LowStockIcon,
  ProjectIcon,
  MapViewIcon,
  SettingsIcon,
  SubstituteIcon,
  SupplierIcon,
  TagsIcon,
  TestRecordIcon,
} from '@/components/icons';
import type { Item, ItemSectionPresence } from '@/db/repositories';
import { NO_SECTION_PRESENCE } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { usePermission } from '@/features/users/usePermission';
import type { FeatureId } from '@/features/modules/feature-registry';
import { hidesAnyCapability, isCapabilityVisible, toHiddenCapabilitySet } from '../category-capabilities';
import { useCategories } from '../categories';
import {
  effectiveProminenceMode,
  insertTabAfter,
  moveTabAfter,
  resolveFieldTabLabel,
  toFieldProminenceMode,
  type FieldProminenceMode,
} from '../field-prominence';
import { useItemSectionPresence } from '../queries';
import { KitEditor } from '@/features/lifecycle/components/KitEditor';
import { LifecycleEditor } from '@/features/lifecycle/components/LifecycleEditor';
import { MaintenanceEditor } from '@/features/lifecycle/components/MaintenanceEditor';
import { ActivityLog } from './ActivityLog';
import { AttachmentManager } from './AttachmentManager';
import { CapabilityEditor } from './CapabilityEditor';
import { CategoryLookupPanel, hasRunnableLookup } from '@/features/lookups';
import { CustomFieldsEditor } from './CustomFieldsEditor';
import { ImageManager } from './ImageManager';
import { AssetEditor } from './AssetEditor';
import { GaugeConfigEditor } from './GaugeConfigEditor';
import { ItemDetailsEditor } from './ItemDetailsEditor';
import { ItemPlacementsPanel } from './ItemPlacementsPanel';
import { RarityBadge } from './RarityBadge';
import { itemRarity } from '../rarity';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { suppressesFlourish } from '@/features/settings/theme-registry';
import { LocationEditor } from './LocationEditor';
import { OperationalMetadataEditor } from './OperationalMetadataEditor';
import { DeadStockEditor } from './DeadStockEditor';
import { ItemReservationsPanel } from './ItemReservationsPanel';
import { ReorderPointEditor } from './ReorderPointEditor';
import { RelationsEditor } from './RelationsEditor';
import { SubstitutionsEditor } from './SubstitutionsEditor';
import { SupplierDataEditor } from './SupplierDataEditor';
import { TagEditor } from './TagEditor';
import { TestRecordsEditor } from './TestRecordsEditor';

/**
 * Item detail dialog — the home for every per-item facet (images §4.2, tags §5,
 * supplier data, lifecycle, maintenance, capabilities, custom fields,
 * operational parameters §4.1.1, datasheets §4 and the activity log §4).
 *
 * The facets are grouped into a small set of tabs presented as a vertical rail
 * down the left-hand side (§2.4.1 — WAI-ARIA APG `tabs`, vertical orientation):
 * the long stack of editors had grown past comfortable scrolling, and tabs keep
 * the dialog short, give each panel full focus and leave obvious room to grow as
 * more fields arrive. Each editor stays wrapped in its own `Section` card so a
 * tab that holds two or three facets still reads as distinct, scannable blocks.
 */
export function ItemDetailDialog({
  item,
  open,
  onClose,
}: {
  item: Item;
  open: boolean;
  onClose: () => void;
}) {
  // Gate the per-item facets by the enabled feature set (modular-ui-plan §4, Phase 6):
  // a capability that is switched off drops its section, and a tab left with no surviving
  // sections is dropped entirely. The underlying editors and data are untouched — only the
  // way in disappears. Passing the resolved set into the pure `buildTabs` keeps the hook out
  // of the tab-building logic.
  const enabledFeatures = useEnabledFeatures();
  const mayViewAudit = usePermission('audit:view');

  // Second axis (issue #618): the item's category can declare capabilities its items simply
  // don't have — a Movie has no maintenance schedule — narrowing the device's set further.
  // `useCategories` is the app-wide cached list every other consumer resolves an id against,
  // so this costs nothing extra. An uncategorised item hides nothing.
  const categories = useCategories();
  const category = categories.data?.rows.find((c) => c.id === item.categoryId);
  const hiddenCapabilities = toHiddenCapabilitySet(category?.hiddenCapabilities);

  // Hiding must never make existing data invisible, so a hidden section that holds something
  // is shown anyway. Only ask which sections hold data when the category actually hides one —
  // an inventory that hides nothing never runs this query.
  const hidesSomething = hidesAnyCapability(category?.hiddenCapabilities);
  const presence = useItemSectionPresence(item.id, hidesSomething);

  // Whether this item's category offers a lookup this build can run (issue #616). The section is
  // omitted entirely when it doesn't: `Section` draws its card — border, icon, title, help badge —
  // before it reaches its children, so a panel that renders `null` would leave an empty card on
  // every item rather than no card at all.
  const offersLookup = hasRunnableLookup(category?.lookupSources);

  // Third axis (issue #619): where the category's *custom fields* sit. Position, unlike the two
  // axes above, is not about what exists — every tab here is still reachable in every mode.
  //
  // Note the break-out tab's fallback label is the one translated string in this rail: the rest of
  // this screen is not converted yet, so its labels are still English literals. Routing a *new*
  // string through `t()` is what the conventions ask for even on an unconverted screen, and the
  // key is needed by the category manager regardless — so the mixed rail is a transitional
  // artefact of this screen's conversion, not a decision to leave the label untranslated.
  const t = useT();
  const prominence: FieldProminence = {
    mode: toFieldProminenceMode(category?.fieldProminence),
    tabLabel: resolveFieldTabLabel(category?.fieldTabLabel, t('item.tab.customFields')),
  };

  const tabs = buildTabs(
    item,
    enabledFeatures,
    hiddenCapabilities,
    presence.data ?? NO_SECTION_PRESENCE,
    prominence,
    offersLookup,
    mayViewAudit,
  );

  // Collector-card rarity (Appearance flair): a decorative gem in the dialog's top-right for the
  // ~5% of items that are collectors. Gated to match the card frame — shown only when the
  // "Collector cards" toggle is on *and* the maximal ("Total Gubbage") animation level is
  // active (the one tier `suppressesFlourish` does not suppress). Purely cosmetic; see `rarity.ts`.
  const rarity = itemRarity(item);
  const gamifyCards = usePreferencesStore((s) => s.gamifyCards);
  const animationLevel = usePreferencesStore((s) => s.animationLevel);
  const rarityEnabled = gamifyCards && !suppressesFlourish(animationLevel);

  // Map each tab's grouped sections into the rail's panel content: the shared RailModal
  // owns the Modal frame, the rail and its keyboard navigation, so this dialog only
  // decides what each panel shows. Each section stays wrapped in its own Section card so
  // a tab that holds two or three facets still reads as distinct, scannable blocks.
  const railTabs: readonly RailTab[] = tabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
    content: tab.sections.map((section) => (
      <Section
        key={section.title}
        title={section.title}
        icon={section.icon}
        hint={section.hint}
        shownDespiteHidden={section.shownDespiteHidden === true}
        categoryName={category?.name}
      >
        {section.content}
      </Section>
    )),
  }));

  return (
    <RailModal
      open={open}
      onClose={onClose}
      title={item.serialNo === null ? item.name : `${item.name} #${item.serialNo}`}
      description="Edit details — plus images, tags, capabilities, custom fields & datasheets."
      titleAccessory={rarity !== null && rarityEnabled ? <RarityBadge rarity={rarity} /> : undefined}
      className="max-w-4xl"
      railAriaLabel="Item sections"
      idPrefix="item"
      tabs={railTabs}
      // Cross-referencing between tabs mid-edit — "what did the supplier record say the part
      // number was?", "is that the right photo?" — is how this dialog is meant to be used, and
      // every facet editor here holds its draft locally until an explicit Save. Unmounting the
      // panel behind you would throw that draft away without a word (issue #576).
      keepPanelsMounted
    />
  );
}

interface SectionDef {
  readonly title: string;
  readonly icon: ReactNode;
  readonly content: ReactNode;
  /**
   * Rich-Markdown help for the whole section — what this group of fields *is* and when to
   * reach for it. Rendered as a right-aligned {@link InfoHint} badge in the section header,
   * complementing the per-field hints inside each editor.
   */
  readonly hint?: string;
  /**
   * The capability that gates this section, if any. When that feature is switched off the
   * section is dropped; a section with no `feature` is always shown (a core facet).
   */
  readonly feature?: FeatureId;
  /**
   * Whether this section actually holds data for the item (issue #618).
   *
   * Only consulted when the item's category hides {@link feature}: hiding must never make
   * existing data invisible, so a populated section is shown regardless, carrying a note that
   * explains why it is there. Per-section rather than per-capability because one capability
   * can gate two sections — `tags-attachments` gates Tags *and* Datasheets, and either may
   * hold data without the other.
   */
  readonly hasData?: boolean;
  /**
   * Set by {@link buildTabs}' filter, never at the declaration site: this section survived
   * only because it holds data its category would otherwise have hidden, so the UI owes the
   * user an explanation for its presence.
   */
  readonly shownDespiteHidden?: boolean;
}

interface TabDef {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly sections: readonly SectionDef[];
}

/**
 * How prominently this item's category wants its custom fields presented (issue #619), with the
 * break-out tab's label already resolved — the catalog lookup belongs to the component, not to
 * this pure builder.
 */
export interface FieldProminence {
  readonly mode: FieldProminenceMode;
  readonly tabLabel: string;
}

/** The Custom fields section's heading, and the built-in fallback for a break-out tab's label. */
const CUSTOM_FIELDS_SECTION_TITLE = 'Custom fields';

/** The id of the break-out tab in `own-tab` mode. Distinct from every declared tab id above. */
const CUSTOM_FIELDS_TAB_ID = 'custom-fields';

/** No category preference — the answer for an uncategorised item, and the default everywhere. */
const DEFAULT_PROMINENCE: FieldProminence = {
  mode: 'default',
  tabLabel: CUSTOM_FIELDS_SECTION_TITLE,
};

/**
 * Section-level help — the rich-Markdown a reader sees behind each groupbox header's `(i)`
 * badge. Each explains what the *whole* group is and when to reach for it, complementing the
 * per-field hints inside the editors. Kept together so the copy is easy to review as a set.
 */
const SECTION_HINT_DETAILS =
  'The item’s **core identity** — the fields that name, classify and cost it.\n\n' +
  '- **Name & description** — how it reads in lists, search and on labels.\n' +
  '- **Category** — the group it belongs to, which unlocks that category’s custom fields.\n' +
  '- **Tracking mode** — *discrete* count, *serialised* individuals, or a *consumable gauge*.\n' +
  '- **MPN & manufacturer, unit cost, weight & dimensions** — the reference and costing details.\n\n' +
  '> Everything else in this dialog hangs off these basics.';

const SECTION_HINT_GAUGE_CONFIG =
  'What this consumable **is measured in** — the settings the gauge itself is built from.\n\n' +
  '- **Unit** — `g`, `ml`, `m`… the unit every capacity and remaining amount is shown in.\n' +
  '- **Full capacity** — how much a brand-new or completely full unit holds.\n' +
  '- **Tare** — the empty container’s weight, subtracted from a scale reading during a weigh-in.\n\n' +
  '> Use this to **correct a mistake** or to re-describe the gauge after swapping in a ' +
  'different-sized spool or bottle. To record how much you’ve *used*, use **Update** instead.';

const SECTION_HINT_LOCATION =
  'Where this item **physically lives** in your storage tree — the room, cabinet, drawer or bin ' +
  'it sits in.\n\n' +
  '- Moving it here routes through the stock ledger, so the change is **logged**, not a silent edit.\n' +
  '- **Unassigned** and **In Transit** are the holding pens for stock not yet shelved or still on ' +
  'its way in.\n\n' +
  '> **Tip:** split a quantity across several locations from the **Lifecycle** tab.';

const SECTION_HINT_PLACEMENTS =
  'The exact spot this item occupies, marked on a **photo of its location** — the shelf, drawer or ' +
  'bin it actually sits in.\n\n' +
  '- Regions are drawn on a location’s photos from the **location editor**.\n' +
  '- An item can be placed in more than one region (a long part spanning two bins, say).\n\n' +
  '> Nothing here moves stock: a placement describes *where* something is, while the **Location** ' +
  'above decides which location holds it.';

const SECTION_HINT_SUPPLIER =
  'Who you **buy this from**, and the names it goes by.\n\n' +
  '- **Supplier parts** — one row per supplier, each with its own part number, price and link, so ' +
  'you can compare where to reorder.\n' +
  '- **Aliases** — the other names, codes or part numbers this item is known by, so a scan or import ' +
  'still finds it.\n\n' +
  '> A supplier scrape can fill much of this in for you.';

const SECTION_HINT_LOW_STOCK =
  'When this item should be **flagged as low** on the dashboard’s *Low Stock* list.\n\n' +
  '- **Default** — follow the global default in **Settings → Inventory**.\n' +
  '- **Custom** — your own trigger: a quantity floor (with an optional top-up amount) for counted ' +
  'items, or a percentage-remaining floor for a gauge.\n' +
  '- **Never** — a hard exemption: never flagged, even when a global default is on.';

const SECTION_HINT_RESERVATIONS =
  'How much of this item is **free**, and which projects have spoken for the rest.\n\n' +
  '- **Available** — what is on hand, less everything open projects have reserved.\n' +
  '- A reservation claims stock that already exists; it never adds any, and two projects can ' +
  'claim the same units. Anything claimed with no stock behind it is flagged here, and goes ' +
  'back on that project’s shopping list.\n\n' +
  '> Items out on loan are already out of the on-hand figure, so they are not listed again.';

const SECTION_HINT_DEAD_STOCK =
  'Whether this item appears on the **Dead stock** report when it goes unused.\n\n' +
  '- **Inherit** — follow the location it’s stored in; if no location above it opts in, ' +
  'it isn’t reported.\n' +
  '- **Report** — always flag it once it has sat unmoved for the idle threshold.\n' +
  '- **Ignore** — never flag it, even if its location reports everything stored there.';

const SECTION_HINT_OPERATIONAL =
  'A free-form list of **operational facts** intrinsic to the item — anything worth recording that ' +
  'isn’t a built-in field.\n\n' +
  'Each is a simple **key → value** pair, e.g. `bed_temp_celsius = 60`, ' +
  '`calibration_interval_days = 365`, `torque_nm = 4`.\n\n' +
  '> Numbers, on/off flags and text are all kept in their natural form. Available on every item, ' +
  'not just gauges.';

const SECTION_HINT_LIFECYCLE =
  'The item’s **shelf-life and condition** — the facts that change as stock ages or gets used.\n\n' +
  '- **Expiry, batch & lot** — for perishable stock, so you can use the oldest first and trace a ' +
  'recall.\n' +
  '- **Condition** — its current state (new, used, faulty…), logged whenever it changes.';

const SECTION_HINT_LIFECYCLE_VARIANTS =
  SECTION_HINT_LIFECYCLE +
  '\n- **Variants** — child versions of this same product (a colour, size or revision). Each variant ' +
  'is its own item nested under this one, so they stay grouped while tracking stock separately.';

const SECTION_HINT_ASSET =
  'Treats this item as an **asset** you own and depreciate.\n\n' +
  '- **Acquired** & **warranty expiry** — when you got it and how long it’s covered; the warranty ' +
  'badge tracks the countdown.\n' +
  '- **Purchase price** & **depreciation term** — a straight-line write-down that surfaces the ' +
  'item’s current **book value**.\n\n' +
  '> Every field is optional — leave them blank for stock you don’t track as an asset.';

const SECTION_HINT_MAINTENANCE =
  'Recurring **service or upkeep** this item needs — the schedules a tool or piece of equipment is ' +
  'kept on.\n\n' +
  '- A schedule can fall due by **elapsed time** or by **accrued usage**.\n' +
  '- Its **due status** is worked out live from the last service — nothing to tick over by hand.\n' +
  '- **Logging** a service resets the schedule and records it in the item’s activity.';

const SECTION_HINT_TEST_RECORDS =
  'A structured **pass / fail and reading log** for this individual unit — the QA audit trail you ' +
  'keep against a serial number.\n\n' +
  'Use it for **test, calibration or service** results: each entry captures the outcome, any ' +
  'measured readings and the date.\n\n' +
  '> Shown only for **serialised** items, where there’s a single physical unit to keep the trail ' +
  'against.';

const SECTION_HINT_KIT =
  'A **kit** is an item that’s *assembled from other items* — a fixed recipe of components. A ' +
  'first-aid kit might be **2 bandages + 1 scissors + 5 plasters**.\n\n' +
  'Here you define that recipe — add each component and how many it takes per kit.\n\n' +
  '- **Buildable count** — how many whole kits your current component stock can make.\n' +
  '- **Assemble / disassemble** — build or break down kits; the moves flow through the stock ledger, ' +
  'consuming components and producing (or returning) kits.\n' +
  '- A component can **itself be a kit**, and sub-kits can be assembled on demand as you build.\n\n' +
  '> Distinct from **variants** (different versions of one product) and **related items** ' +
  '(loose cross-links): a kit is a real bill of materials.';

const SECTION_HINT_RELATED =
  'Loose **cross-links to other items** — *works with*, *is an accessory for*, *is a spare for*, and ' +
  'similar.\n\n' +
  '- Links are **reciprocal**: adding one here shows up on the other item too.\n' +
  '- They’re for reference and discovery — they never move or consume stock.\n\n' +
  '> For interchangeable stand-ins use **Substitutions**; for an assembly use a **Kit**.';

const SECTION_HINT_SUBSTITUTIONS =
  'Items that are **freely interchangeable** with this one — any of them will do where this is ' +
  'called for.\n\n' +
  '- The link is **two-way**: mark A and B as substitutes and each lists the other.\n' +
  '- A project or list that needs this item can then draw on any of its substitutes.\n\n' +
  '> Unlike **related items** (which just cross-reference), substitutes are genuine drop-in ' +
  'replacements.';

const SECTION_HINT_IMAGES =
  'Photos of this item, shown on its card and detail view.\n\n' +
  'Add as many as you like and pick which one leads — a clear picture makes an item far quicker to ' +
  'spot in a list.';

const SECTION_HINT_DATASHEETS =
  'Documents attached to this item — **datasheets, manuals, receipts, certificates** and the like.\n\n' +
  'Each file is stored with the item so its paperwork travels with it, a click away from the detail ' +
  'view.';

const SECTION_HINT_TAGS =
  'Free-form **labels** you attach to an item to slice your inventory your own way — `fragile`, ' +
  '`3d-printer`, `loaned-out`, whatever suits.\n\n' +
  'An item can carry any number of tags, and you can **filter and search** by them across the whole ' +
  'catalogue.';

const SECTION_HINT_CAPABILITIES =
  'Structured **specifications** that describe what this item *can do* — each a **key = value**, ' +
  'optionally weighted by how central it is.\n\n' +
  'e.g. `voltage = 3.3`, `resistance = 10k`, `interface = USB-C`.\n\n' +
  '> Numeric capabilities support range matching (find everything with `voltage > 3.3`) in the ' +
  'search builder — more precise than a plain tag.';

const SECTION_HINT_CUSTOM_FIELDS =
  'Extra fields defined by this item’s **category**, so every item in that category captures the ' +
  'same details.\n\n' +
  '- The set of fields comes from the category — manage them in the **category editor**.\n' +
  '- Here you just fill in this item’s **values**.\n\n' +
  '> Give an item a category on the **Details** tab to unlock its custom fields.';

const SECTION_HINT_LOOKUP =
  'Fill this item’s fields from an **open database** — the one the category is set up to use.\n\n' +
  '- You always **pick which entry** is yours from a list of matches; a search hit is never applied ' +
  'on your behalf.\n' +
  '- You then **review** every value before anything is written, and your own entries are never ' +
  'overwritten unless you tick them.\n\n' +
  '> This section appears only for categories that have a database attached.';

const SECTION_HINT_ACTIVITY =
  'A dated **history** of everything that’s happened to this item — moves, quantity changes, ' +
  'condition updates, maintenance, kit builds and more.\n\n' +
  'It’s recorded automatically as you work, giving you a full audit trail with no bookkeeping on ' +
  'your part.';

/**
 * The facet editors, grouped into six tabs. Built per-render (the editors
 * close over `item`); a panel is mounted the first time it is shown and then kept
 * (`keepPanelsMounted`), because each editor holds its draft in local state until an
 * explicit Save and unmounting the panel behind you would discard it (issue #576).
 * "Details" leads: it is the edit-item home for the core identity fields (name,
 * description, notes, MPN, manufacturer, cost, category) plus the item's location.
 *
 * Visibility runs on two axes, both resolved by the pure `isCapabilityVisible` seam:
 *
 * - `enabled` — the device's resolved feature set. A capability switched off on the Modules
 *   screen drops its section, and any tab left with no surviving sections is dropped
 *   entirely (§4, Phase 6). This axis always wins.
 * - `hidden` — the capabilities the item's *category* says its items don't have (issue #618).
 *   Narrows further, never widens. A section it would hide is kept anyway when `presence`
 *   says it holds data, flagged `shownDespiteHidden` so the UI can explain itself.
 *
 * `presence` is the data-presence probe for the item, or {@link NO_SECTION_PRESENCE} while it
 * is still loading or when nothing is hidden and it was never asked for.
 *
 * A third axis, `prominence` (issue #619), decides *where* the custom fields sit rather than
 * whether they appear. It is applied last, and deliberately cannot resurrect anything the two
 * visibility axes dropped: when the Custom fields section would not be shown at all, the
 * position reverts to the default rather than promoting a tab that no longer holds them.
 *
 * `offersLookup` (issue #616) is the one gate that is not a capability: the "Fill from a database"
 * section is omitted outright unless the item's category has a lookup provider this build can run.
 * Every other section owns an editor that is useful empty, so it can render its card and let the
 * editor say "nothing yet"; that one renders nothing at all, and an empty card promising a feature
 * the category hasn't got would be worse than no card. It moves with the custom fields under
 * `prominence`, since those are the fields it fills.
 *
 * `mayViewAudit` (issue #522) is the one gate that is a *permission* rather than a capability: the
 * per-item ledger is the same audit trail the Activity screen shows, so a role without `audit:view`
 * must not reach it through this rail either. It defaults to `true` — single-user mode's answer.
 */
export function buildTabs(
  item: Item,
  enabled: ReadonlySet<FeatureId>,
  hidden: ReadonlySet<FeatureId> = EMPTY_HIDDEN,
  presence: ItemSectionPresence = NO_SECTION_PRESENCE,
  prominence: FieldProminence = DEFAULT_PROMINENCE,
  offersLookup = false,
  mayViewAudit = true,
): readonly TabDef[] {
  // The variants block lives inside LifecycleEditor and is gated there by both axes, so the
  // section heading has to ask the same question rather than only the device's.
  const showsVariants =
    isCapabilityVisible('variants', enabled, hidden, item.hasVariants || item.parentId !== null) !== 'hidden';

  // Issue #619. The custom-fields verdict is needed *before* the tab list is assembled, because
  // `own-tab` removes the section from Classification rather than filtering it out afterwards —
  // and because a mode may only take effect while the section actually survives.
  const customFieldsVerdict = isCapabilityVisible('custom-fields', enabled, hidden, presence.customFields);
  const prominenceMode = effectiveProminenceMode(prominence.mode, customFieldsVerdict !== 'hidden');
  const customFieldsSection: SectionDef = {
    title: CUSTOM_FIELDS_SECTION_TITLE,
    icon: <CategoryIcon />,
    content: <CustomFieldsEditor itemId={item.id} />,
    hint: SECTION_HINT_CUSTOM_FIELDS,
    feature: 'custom-fields',
    hasData: presence.customFields,
  };

  // Filling those fields from an open database (issue #616). Sits directly under them wherever
  // they end up — it answers the follow-up question, "do I have to type all this?" — so it moves
  // into the break-out tab with them rather than being stranded in Classification.
  //
  // Gated on `scraping` ("Product & supplier lookup"), the capability the barcode and supplier
  // lookups already live under, but resolved **here** rather than left to the section filter
  // below: the `own-tab` tab is assembled after that filter has run, so a section carried into it
  // would otherwise skip the gate entirely. Present at all only when the category actually offers
  // a lookup — unlike every other section, this one has nothing to show without one.
  const lookupSections: readonly SectionDef[] =
    offersLookup && isCapabilityVisible('scraping', enabled, hidden, false) !== 'hidden'
      ? [
          {
            title: 'Fill from a database',
            icon: <DatabaseIcon />,
            content: <CategoryLookupPanel item={item} />,
            hint: SECTION_HINT_LOOKUP,
          },
        ]
      : [];
  const tabs: readonly TabDef[] = [
    {
      id: 'details',
      label: 'Details',
      icon: <EditIcon />,
      sections: [
        {
          title: 'Item details',
          icon: <EditIcon />,
          content: <ItemDetailsEditor item={item} />,
          hint: SECTION_HINT_DETAILS,
        },
        // What the gauge *is* — its unit, full capacity and tare (issue #69). Only a
        // consumable gauge has these, and correcting them belongs beside the item's other
        // identity fields; how full it is right now stays in the Update dialog.
        ...(item.trackingMode === 'CONSUMABLE_GAUGE'
          ? [
              {
                title: 'Gauge setup',
                icon: <GaugeIcon />,
                content: <GaugeConfigEditor item={item} />,
                hint: SECTION_HINT_GAUGE_CONFIG,
              },
            ]
          : []),
        {
          title: 'Location',
          icon: <LocationOtherIcon />,
          content: <LocationEditor item={item} />,
          hint: SECTION_HINT_LOCATION,
        },
        // Where in that location it physically sits, shown on the location's own photo
        // (issue #81). Sits directly under Location because it answers the follow-up
        // question — "which shelf?" — rather than repeating "which room?".
        {
          title: 'Where it sits',
          icon: <MapViewIcon />,
          content: <ItemPlacementsPanel item={item} />,
          hint: SECTION_HINT_PLACEMENTS,
          feature: 'location-photos',
          hasData: presence.placements,
        },
      ],
    },
    {
      id: 'supplier',
      label: 'Supplier & ops',
      icon: <SupplierIcon />,
      sections: [
        {
          title: 'Supplier data',
          icon: <SupplierIcon />,
          content: <SupplierDataEditor item={item} />,
          hint: SECTION_HINT_SUPPLIER,
        },
        {
          title: 'Low-stock alert',
          icon: <LowStockIcon />,
          content: <ReorderPointEditor item={item} />,
          hint: SECTION_HINT_LOW_STOCK,
        },
        {
          // Issue #653. Sits under the low-stock alert because it answers the same question one
          // step further on: that one says whether there is enough stock, this one says how much
          // of it is still yours to spend.
          title: 'Reservations',
          icon: <ProjectIcon />,
          content: <ItemReservationsPanel item={item} />,
          hint: SECTION_HINT_RESERVATIONS,
          feature: 'projects',
          hasData: presence.reservations,
        },
        {
          title: 'Dead-stock reporting',
          icon: <HistoryIcon />,
          content: <DeadStockEditor item={item} />,
          hint: SECTION_HINT_DEAD_STOCK,
        },
        {
          title: 'Operational parameters',
          icon: <GaugeIcon />,
          content: <OperationalMetadataEditor item={item} />,
          hint: SECTION_HINT_OPERATIONAL,
        },
      ],
    },
    {
      id: 'lifecycle',
      label: 'Lifecycle',
      icon: <DueDateIcon />,
      sections: [
        {
          // The variants sub-block is gated on the `variants` capability, so the heading drops
          // "& variants" when it isn't shown (the editor still owns expiry/batch/condition —
          // the "lifecycle" half — which is always present). Both axes have to be consulted:
          // titling a section "…& variants" while the item's category hides variants would
          // promise a block the editor no longer renders.
          title: showsVariants ? 'Lifecycle & variants' : 'Lifecycle',
          icon: <DueDateIcon />,
          content: <LifecycleEditor item={item} />,
          // The hint mirrors the retitle: it only promises variants when that block is shown.
          hint: showsVariants ? SECTION_HINT_LIFECYCLE_VARIANTS : SECTION_HINT_LIFECYCLE,
        },
        {
          title: 'Asset details',
          icon: <CostIcon />,
          content: <AssetEditor item={item} />,
          hint: SECTION_HINT_ASSET,
          feature: 'warranty',
        },
        {
          title: 'Maintenance',
          icon: <SettingsIcon />,
          content: <MaintenanceEditor itemId={item.id} />,
          hint: SECTION_HINT_MAINTENANCE,
          feature: 'maintenance',
          hasData: presence.maintenance,
        },
        // Per-instance test / calibration / service records (feature-gap G7). Structured pass/fail
        // + reading logs are only meaningful for a *serialised* unit (a specific instance with a
        // serial number), so the section is gated to SERIALISED tracking rather than a module
        // feature — a bulk/consumable line has no single instance to keep a QA audit trail against.
        ...(item.trackingMode === 'SERIALISED'
          ? [
              {
                title: 'Test & calibration records',
                icon: <TestRecordIcon />,
                content: <TestRecordsEditor item={item} />,
                hint: SECTION_HINT_TEST_RECORDS,
              },
            ]
          : []),
      ],
    },
    {
      id: 'kit',
      label: 'Kit',
      icon: <AssemblyIcon />,
      sections: [
        {
          // Kits define this item as a bundle of other items and show how many are
          // buildable from component stock. Gated on the `kits` capability, so the whole
          // tab disappears when the module is off (buildTabs drops a section-less tab).
          title: 'Kit components',
          icon: <AssemblyIcon />,
          content: <KitEditor item={item} />,
          hint: SECTION_HINT_KIT,
          feature: 'kits',
          hasData: presence.kit,
        },
      ],
    },
    {
      id: 'related',
      label: 'Related',
      icon: <LinkIcon />,
      sections: [
        {
          // Cross-links to *other* items — "works with" / accessory / spare-for. Distinct from
          // variants (same product) and kits (an assembly); reciprocal and always available (a
          // core relational facet, so ungated).
          title: 'Related items',
          icon: <LinkIcon />,
          content: <RelationsEditor item={item} />,
          hint: SECTION_HINT_RELATED,
        },
      ],
    },
    {
      id: 'substitutions',
      label: 'Substitutions',
      icon: <SubstituteIcon />,
      sections: [
        {
          // Interchangeable items — freely substitutable stand-ins usable in a project or list
          // (issue #36). A symmetric, reciprocal link; distinct from "Related" cross-links, so it
          // gets its own surface. Always available (a core relational facet, so ungated).
          title: 'Substitutions',
          icon: <SubstituteIcon />,
          content: <SubstitutionsEditor item={item} />,
          hint: SECTION_HINT_SUBSTITUTIONS,
        },
      ],
    },
    {
      id: 'media',
      label: 'Media & docs',
      icon: <ImageIcon />,
      sections: [
        {
          title: 'Images',
          icon: <ImageIcon />,
          content: <ImageManager itemId={item.id} />,
          hint: SECTION_HINT_IMAGES,
        },
        {
          title: 'Datasheets',
          icon: <DatasheetIcon />,
          content: <AttachmentManager itemId={item.id} />,
          hint: SECTION_HINT_DATASHEETS,
          feature: 'tags-attachments',
          hasData: presence.attachments,
        },
      ],
    },
    {
      id: 'classification',
      label: 'Classification',
      icon: <TagsIcon />,
      sections: [
        {
          title: 'Tags',
          icon: <TagsIcon />,
          content: <TagEditor itemId={item.id} />,
          hint: SECTION_HINT_TAGS,
          feature: 'tags-attachments',
          hasData: presence.tags,
        },
        {
          title: 'Capabilities',
          icon: <CapabilityIcon />,
          content: <CapabilityEditor itemId={item.id} />,
          hint: SECTION_HINT_CAPABILITIES,
          feature: 'custom-fields',
          hasData: presence.capabilities,
        },
        // In `own-tab` mode the fields — and the lookup that fills them — leave Classification
        // entirely and are inserted below as a tab of their own; Tags and Capabilities keep this
        // one.
        ...(prominenceMode === 'own-tab' ? [] : [customFieldsSection, ...lookupSections]),
      ],
    },
    // The per-item ledger is the same audit trail the Activity screen shows, so it answers to the
    // same permission (issue #522). Without this the tab is a second, unguarded door to exactly
    // what `audit:view` is defined to withhold — and the one the built-in Viewer role is described
    // as not having. An empty `sections` array drops the tab in the filter below.
    {
      id: 'activity',
      label: 'Activity',
      icon: <HistoryIcon />,
      sections: mayViewAudit
        ? [
            {
              title: 'Activity log',
              icon: <HistoryIcon />,
              content: <ActivityLog itemId={item.id} itemName={item.name} />,
              hint: SECTION_HINT_ACTIVITY,
            },
          ]
        : [],
    },
  ];

  // Resolve both visibility axes, then drop any tab left with no sections. A section kept only
  // because it holds data its category hides is marked so its header can explain itself.
  const visible = tabs
    .map((tab) => ({
      ...tab,
      sections: tab.sections.flatMap((s) => {
        const verdict = isCapabilityVisible(s.feature, enabled, hidden, s.hasData === true);
        if (verdict === 'hidden') return [];
        return [verdict === 'shown-despite-hidden' ? { ...s, shownDespiteHidden: true } : s];
      }),
    }))
    .filter((tab) => tab.sections.length > 0);

  // Position last (issue #619), over the list that survived: promotion moves a tab that is
  // definitely there, and the break-out tab is inserted only in the mode that removed the
  // section from Classification above. `effectiveProminenceMode` has already ruled out the
  // `hidden` verdict, so the section below is genuinely shown either way.
  if (prominenceMode === 'promoted') return moveTabAfter(visible, 'classification', 'details');
  if (prominenceMode === 'own-tab') {
    return insertTabAfter(
      visible,
      {
        id: CUSTOM_FIELDS_TAB_ID,
        label: prominence.tabLabel,
        icon: <CategoryIcon />,
        sections: [
          customFieldsVerdict === 'shown-despite-hidden'
            ? { ...customFieldsSection, shownDespiteHidden: true }
            : customFieldsSection,
          // Already gated above, since this tab is built past the section filter (issue #616).
          ...lookupSections,
        ],
      },
      'details',
    );
  }
  return visible;
}

/** No category hiding — the default, and the answer for an uncategorised item. */
const EMPTY_HIDDEN: ReadonlySet<FeatureId> = new Set<FeatureId>();

/**
 * Each editor is wrapped in a self-contained card — a bordered surface with a
 * tinted header band, a divider and an accent-chipped icon — so a tab that holds
 * more than one facet reads as distinct, scannable blocks rather than blurring
 * together, while staying cohesive with the app's glass-and-violet aesthetic
 * (§1.1, §2.4.1).
 */
function Section({
  title,
  icon,
  hint,
  shownDespiteHidden = false,
  categoryName,
  children,
}: {
  title: string;
  icon: ReactNode;
  hint?: string;
  /** This section's category hides it, but it holds data — say so rather than surprising anyone. */
  shownDespiteHidden?: boolean;
  /** The item's category name, for the note above. Absent for an uncategorised item. */
  categoryName?: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <section className="overflow-hidden rounded-xl border border-border shadow-sm">
      <h3 className="flex items-center gap-2.5 border-b border-border bg-secondary/30 px-4 py-2.5 text-sm font-semibold">
        <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">
          {icon}
        </span>
        {title}
        {/* Section-level help sits at the far right of the header band, explaining what the whole
            group is — distinct from the per-field hints inside each editor. The `ml-auto` lives on
            a wrapper span (the real flex child): InfoHint applies its own className to the inner
            badge, which the Tooltip trigger wraps, so `ml-auto` there would never reach the row. */}
        {hint ? (
          <span className="ml-auto">
            <InfoHint size="md" content={hint} />
          </span>
        ) : null}
      </h3>
      <div className="p-4">
        {/* Hiding must never make existing data invisible. When a section survives only because
            it holds something its category would otherwise hide, say so plainly — an unexplained
            section appearing on one item but not its neighbour reads as a bug. */}
        {shownDespiteHidden ? (
          <p className="mb-3 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
            {categoryName === undefined
              ? t('item.section.shownDespiteHidden')
              : t('item.section.shownDespiteHiddenNamed', { vars: { category: categoryName } })}
          </p>
        ) : null}
        {children}
      </div>
    </section>
  );
}
