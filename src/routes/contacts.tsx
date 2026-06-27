import { createFileRoute } from '@tanstack/react-router';
import { ContactsScreen } from '@/features/contacts/ContactsScreen';

export const Route = createFileRoute('/contacts')({
  component: ContactsScreen,
});
