import { Surface } from '@/components/foundry';
import { ContactsIcon } from '@/components/icons';
import { useT } from '@/features/i18n';

/**
 * ContactsGettingStarted — the first-run panel for the Contacts screen (#424).
 *
 * Shown only when there are no contacts AND nothing currently on loan, since a page with
 * either already has something to look at. Mirrors {@link DashboardGettingStarted}'s
 * icon+heading+body shape, but as introductory prose rather than action buttons — the
 * existing "Add a contact" input and checkout flow are the calls to action.
 */
export function ContactsGettingStarted() {
  const t = useT();

  return (
    <Surface className="flex flex-col gap-4 p-5" data-testid="contacts-getting-started">
      <div className="flex items-center gap-2.5 text-muted-foreground [&_svg]:size-5">
        <ContactsIcon aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">{t('contacts.gettingStarted.heading')}</h2>
      </div>
      <p className="text-sm text-muted-foreground">{t('contacts.gettingStarted.bodyPurpose')}</p>
      <p className="text-sm text-muted-foreground">{t('contacts.gettingStarted.bodyHowTo')}</p>
    </Surface>
  );
}
