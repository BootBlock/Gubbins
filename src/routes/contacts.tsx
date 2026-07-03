import { createFileRoute } from '@tanstack/react-router';
import { ContactsScreen } from '@/features/contacts/ContactsScreen';
import { ModuleGuard } from '@/features/modules/ModuleGuard';

export const Route = createFileRoute('/contacts')({
  component: () => (
    <ModuleGuard feature="contacts">
      <ContactsScreen />
    </ModuleGuard>
  ),
});
