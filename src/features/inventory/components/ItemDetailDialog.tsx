import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import { Modal } from '@/components/foundry';
import {
  CapabilityIcon,
  CategoryIcon,
  CostIcon,
  DatasheetIcon,
  DueDateIcon,
  EditIcon,
  GaugeIcon,
  HistoryIcon,
  ImageIcon,
  LocationOtherIcon,
  LowStockIcon,
  SettingsIcon,
  SupplierIcon,
  TagsIcon,
} from '@/components/icons';
import { cn } from '@/lib/utils';
import type { Item } from '@/db/repositories';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import type { FeatureId } from '@/features/modules/feature-registry';
import { LifecycleEditor, MaintenanceEditor } from '@/features/lifecycle';
import { resolveTabKey } from '../tab-keyboard';
import { ActivityLog } from './ActivityLog';
import { AttachmentManager } from './AttachmentManager';
import { CapabilityEditor } from './CapabilityEditor';
import { CustomFieldsEditor } from './CustomFieldsEditor';
import { ImageManager } from './ImageManager';
import { AssetEditor } from './AssetEditor';
import { ItemDetailsEditor } from './ItemDetailsEditor';
import { LocationEditor } from './LocationEditor';
import { OperationalMetadataEditor } from './OperationalMetadataEditor';
import { ReorderPointEditor } from './ReorderPointEditor';
import { SupplierDataEditor } from './SupplierDataEditor';
import { TagEditor } from './TagEditor';

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
  const [activeId, setActiveId] = useState(tabs[0]!.id);
  // Roving-tabindex refs for the rail buttons, so arrow-key navigation can move
  // DOM focus to the newly-selected tab (the APG automatic-activation model).
  const tabRefs = useRef(new Map<string, HTMLButtonElement | null>());

  // Guard against a stale selection if the tab set ever changes shape.
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]!;

  const select = (id: string) => {
    setActiveId(id);
    tabRefs.current.get(id)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = resolveTabKey(
      tabs.map((t) => t.id),
      active.id,
      e.key,
    );
    if (next === null) return;
    e.preventDefault();
    select(next);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={item.serialNo === null ? item.name : `${item.name} #${item.serialNo}`}
      description="Edit details — plus images, tags, capabilities, custom fields & datasheets."
      className="max-w-4xl"
    >
      {/* Fixed-height frame: the dialog stays the same size as content streams in
          and as you switch tabs, so the rail never shifts and the panel scrolls
          within rather than resizing (and re-centring) the whole modal. */}
      <div className="flex h-[74vh] gap-4 sm:gap-5">
        <div
          role="tablist"
          aria-orientation="vertical"
          aria-label="Item sections"
          className="flex shrink-0 flex-col gap-1"
        >
          {tabs.map((tab) => {
            const selected = tab.id === active.id;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current.set(tab.id, el);
                }}
                type="button"
                role="tab"
                id={`item-tab-${tab.id}`}
                aria-label={tab.label}
                aria-selected={selected}
                aria-controls={`item-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(tab.id)}
                onKeyDown={onKeyDown}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium',
                  'transition-colors ease-emphasized',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-secondary/40 hover:text-foreground',
                )}
              >
                <span
                  className={cn(
                    'grid size-7 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
                    selected ? 'bg-primary/15 text-primary' : 'bg-secondary/50 text-muted-foreground',
                  )}
                >
                  {tab.icon}
                </span>
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`item-panel-${active.id}`}
          aria-labelledby={`item-tab-${active.id}`}
          tabIndex={0}
          className="min-w-0 flex-1 space-y-4 overflow-y-auto dialog-scroll focus-visible:outline-none"
        >
          {active.sections.map((section) => (
            <Section key={section.title} title={section.title} icon={section.icon}>
              {section.content}
            </Section>
          ))}
        </div>
      </div>
    </Modal>
  );
}

interface SectionDef {
  readonly title: string;
  readonly icon: ReactNode;
  readonly content: ReactNode;
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
        { title: 'Item details', icon: <EditIcon />, content: <ItemDetailsEditor item={item} /> },
        { title: 'Location', icon: <LocationOtherIcon />, content: <LocationEditor item={item} /> },
      ],
    },
    {
      id: 'supplier',
      label: 'Supplier & ops',
      icon: <SupplierIcon />,
      sections: [
        { title: 'Supplier data', icon: <SupplierIcon />, content: <SupplierDataEditor item={item} /> },
        { title: 'Reorder point', icon: <LowStockIcon />, content: <ReorderPointEditor item={item} /> },
        {
          title: 'Operational parameters',
          icon: <GaugeIcon />,
          content: <OperationalMetadataEditor item={item} />,
        },
      ],
    },
    {
      id: 'lifecycle',
      label: 'Lifecycle',
      icon: <DueDateIcon />,
      sections: [
        { title: 'Lifecycle & variants', icon: <DueDateIcon />, content: <LifecycleEditor item={item} /> },
        {
          title: 'Asset details',
          icon: <CostIcon />,
          content: <AssetEditor item={item} />,
          feature: 'warranty',
        },
        {
          title: 'Maintenance',
          icon: <SettingsIcon />,
          content: <MaintenanceEditor itemId={item.id} />,
          feature: 'maintenance',
        },
      ],
    },
    {
      id: 'media',
      label: 'Media & docs',
      icon: <ImageIcon />,
      sections: [
        { title: 'Images', icon: <ImageIcon />, content: <ImageManager itemId={item.id} /> },
        {
          title: 'Datasheets',
          icon: <DatasheetIcon />,
          content: <AttachmentManager itemId={item.id} />,
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
          feature: 'tags-attachments',
        },
        {
          title: 'Capabilities',
          icon: <CapabilityIcon />,
          content: <CapabilityEditor itemId={item.id} />,
          feature: 'custom-fields',
        },
        {
          title: 'Custom fields',
          icon: <CategoryIcon />,
          content: <CustomFieldsEditor itemId={item.id} />,
          feature: 'custom-fields',
        },
      ],
    },
    {
      id: 'activity',
      label: 'Activity',
      icon: <HistoryIcon />,
      sections: [{ title: 'Activity log', icon: <HistoryIcon />, content: <ActivityLog itemId={item.id} /> }],
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
function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border shadow-sm">
      <h3 className="flex items-center gap-2.5 border-b border-border bg-secondary/30 px-4 py-2.5 text-sm font-semibold">
        <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">
          {icon}
        </span>
        {title}
      </h3>
      <div className="p-4">{children}</div>
    </section>
  );
}
