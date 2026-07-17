import { type ReactNode } from 'react';
import { InfoHint, RailModal, type RailTab } from '@/components/foundry';
import {
  AssemblyIcon,
  CapabilityIcon,
  CategoryIcon,
  CostIcon,
  DatasheetIcon,
  DueDateIcon,
  EditIcon,
  GaugeIcon,
  HistoryIcon,
  ImageIcon,
  LinkIcon,
  LocationOtherIcon,
  LowStockIcon,
  SettingsIcon,
  SubstituteIcon,
  SupplierIcon,
  TagsIcon,
  TestRecordIcon,
} from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import type { FeatureId } from '@/features/modules/feature-registry';
import { KitEditor, LifecycleEditor, MaintenanceEditor } from '@/features/lifecycle';
import { ActivityLog } from './ActivityLog';
import { AttachmentManager } from './AttachmentManager';
import { CapabilityEditor } from './CapabilityEditor';
import { CustomFieldsEditor } from './CustomFieldsEditor';
import { ImageManager } from './ImageManager';
import { AssetEditor } from './AssetEditor';
import { ItemDetailsEditor } from './ItemDetailsEditor';
import { RarityBadge } from './RarityBadge';
import { itemRarity } from '../rarity';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { suppressesFlourish } from '@/features/settings/theme-registry';
import { LocationEditor } from './LocationEditor';
import { OperationalMetadataEditor } from './OperationalMetadataEditor';
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
  const tabs = buildTabs(item, enabledFeatures);

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
      <Section key={section.title} title={section.title} icon={section.icon} hint={section.hint}>
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
}

interface TabDef {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly sections: readonly SectionDef[];
}

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

const SECTION_HINT_LOCATION =
  'Where this item **physically lives** in your storage tree — the room, cabinet, drawer or bin ' +
  'it sits in.\n\n' +
  '- Moving it here routes through the stock ledger, so the change is **logged**, not a silent edit.\n' +
  '- **Unassigned** and **In Transit** are the holding pens for stock not yet shelved or still on ' +
  'its way in.\n\n' +
  '> **Tip:** split a quantity across several locations from the **Lifecycle** tab.';

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

const SECTION_HINT_ACTIVITY =
  'A dated **history** of everything that’s happened to this item — moves, quantity changes, ' +
  'condition updates, maintenance, kit builds and more.\n\n' +
  'It’s recorded automatically as you work, giving you a full audit trail with no bookkeeping on ' +
  'your part.';

/**
 * The facet editors, grouped into six tabs. Built per-render (the editors
 * close over `item`); only the active tab's panel is mounted, so switching tabs
 * unmounts the others — each editor persists to the DB through its own hooks, so
 * there is no shared in-flight state to preserve across a switch. "Details" leads:
 * it is the edit-item home for the core identity fields (name, description, notes,
 * MPN, manufacturer, cost, category) plus the item's location.
 *
 * `enabled` is the resolved feature set: feature-gated sections whose capability is off are
 * dropped, and any tab left with no surviving sections is dropped entirely (§4, Phase 6).
 */
export function buildTabs(item: Item, enabled: ReadonlySet<FeatureId>): readonly TabDef[] {
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
        {
          title: 'Location',
          icon: <LocationOtherIcon />,
          content: <LocationEditor item={item} />,
          hint: SECTION_HINT_LOCATION,
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
          // The variants sub-block is itself gated on the `variants` capability, so the
          // heading drops "& variants" when that module is off (the editor still owns
          // expiry/batch/condition — the "lifecycle" half — which is always present).
          title: enabled.has('variants') ? 'Lifecycle & variants' : 'Lifecycle',
          icon: <DueDateIcon />,
          content: <LifecycleEditor item={item} />,
          // The hint mirrors the retitle: it only promises variants when that module is on.
          hint: enabled.has('variants') ? SECTION_HINT_LIFECYCLE_VARIANTS : SECTION_HINT_LIFECYCLE,
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
        },
        {
          title: 'Capabilities',
          icon: <CapabilityIcon />,
          content: <CapabilityEditor itemId={item.id} />,
          hint: SECTION_HINT_CAPABILITIES,
          feature: 'custom-fields',
        },
        {
          title: 'Custom fields',
          icon: <CategoryIcon />,
          content: <CustomFieldsEditor itemId={item.id} />,
          hint: SECTION_HINT_CUSTOM_FIELDS,
          feature: 'custom-fields',
        },
      ],
    },
    {
      id: 'activity',
      label: 'Activity',
      icon: <HistoryIcon />,
      sections: [
        {
          title: 'Activity log',
          icon: <HistoryIcon />,
          content: <ActivityLog itemId={item.id} />,
          hint: SECTION_HINT_ACTIVITY,
        },
      ],
    },
  ];

  // Drop feature-gated sections whose capability is off, then any tab left with no sections.
  return tabs
    .map((tab) => ({
      ...tab,
      sections: tab.sections.filter((s) => s.feature === undefined || enabled.has(s.feature)),
    }))
    .filter((tab) => tab.sections.length > 0);
}

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
  children,
}: {
  title: string;
  icon: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
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
      <div className="p-4">{children}</div>
    </section>
  );
}
