import type { ReactNode } from 'react';
import { Modal } from '@/components/foundry';
import {
  CapabilityIcon,
  CategoryIcon,
  DatasheetIcon,
  DueDateIcon,
  ImageIcon,
  SettingsIcon,
  SupplierIcon,
  TagsIcon,
} from '@/components/icons';
import type { Item } from '@/db/repositories';
import { LifecycleEditor, MaintenanceEditor } from '@/features/lifecycle';
import { AttachmentManager } from './AttachmentManager';
import { CapabilityEditor } from './CapabilityEditor';
import { CustomFieldsEditor } from './CustomFieldsEditor';
import { ImageManager } from './ImageManager';
import { SupplierDataEditor } from './SupplierDataEditor';
import { TagEditor } from './TagEditor';

/**
 * Item detail dialog (Phase 3) — the home for the per-item facets introduced this
 * phase: images (§4.2), freeform tags (§5), category custom fields (§4), and
 * datasheet links (§4). Each section is a self-contained editor wired to its own
 * Tier-1 hooks.
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
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={item.serialNo === null ? item.name : `${item.name} #${item.serialNo}`}
      description="Images, tags, capabilities, custom fields & datasheets."
      className="max-w-2xl"
    >
      <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
        <Section title="Supplier data" icon={<SupplierIcon />}>
          <SupplierDataEditor item={item} />
        </Section>
        <Section title="Lifecycle & variants" icon={<DueDateIcon />}>
          <LifecycleEditor item={item} />
        </Section>
        <Section title="Maintenance" icon={<SettingsIcon />}>
          <MaintenanceEditor itemId={item.id} />
        </Section>
        <Section title="Images" icon={<ImageIcon />}>
          <ImageManager itemId={item.id} />
        </Section>
        <Section title="Tags" icon={<TagsIcon />}>
          <TagEditor itemId={item.id} />
        </Section>
        <Section title="Capabilities" icon={<CapabilityIcon />}>
          <CapabilityEditor itemId={item.id} />
        </Section>
        <Section title="Custom fields" icon={<CategoryIcon />}>
          <CustomFieldsEditor itemId={item.id} />
        </Section>
        <Section title="Datasheets" icon={<DatasheetIcon />}>
          <AttachmentManager itemId={item.id} />
        </Section>
      </div>
    </Modal>
  );
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-muted-foreground">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}
