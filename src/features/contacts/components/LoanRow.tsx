import { Button, Surface, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { CheckInIcon, DueDateIcon, RenewIcon } from '@/components/icons';
import type { CheckoutWithNames } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useT } from '@/features/i18n';

/**
 * A single open-loan row: the item, who/what it is out to (a contact, project or location —
 * B4's polymorphic borrower, shown verbatim via `borrowerName`), its due date, and one-tap
 * Renew / Return affordances. Shared by the Contacts hub, the contact detail dialog and the
 * project / location loan panels so every surface renders a loan identically.
 *
 * A loan that has come back in part (issue #662) states what is **still out** rather than what
 * went out, because that is the figure the row is there to answer: the borrower has four of the
 * six, and the count beside their name should say four.
 */
export function LoanRow({
  checkout,
  onReturn,
  onRenew,
}: {
  checkout: CheckoutWithNames;
  onReturn: () => void;
  onRenew: () => void;
}) {
  const fmt = useFormatters();
  const t = useT();
  const due = checkout.dueDate ? fmt.date(checkout.dueDate) : null;
  return (
    <Surface
      className={`flex flex-wrap items-center gap-3 p-3 transition-all duration-200 ease-emphasized hover:-translate-y-0.5 hover:shadow-primary/10 ${
        checkout.isOverdue ? 'border-destructive/40' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{checkout.itemName}</p>
        <p className="text-xs text-muted-foreground">
          {/* One translated sentence rather than three spliced fragments: German puts the
              borrower last and the counts first, so a split that highlighted the name would
              not survive translation. The name gives up its emphasis in this variant. */}
          {checkout.returnedQuantity > 0 ? (
            t('contacts.loan.outstanding', {
              vars: {
                outstanding: checkout.quantity - checkout.returnedQuantity,
                quantity: checkout.quantity,
                borrower: checkout.borrowerName,
              },
            })
          ) : (
            <>
              {checkout.quantity} with <span className="text-foreground">{checkout.borrowerName}</span>
            </>
          )}
        </p>
        {/* The reason the item was lent out (B1's loan note), when one was recorded. */}
        {checkout.note ? (
          <p className="truncate text-xs italic text-muted-foreground">“{checkout.note}”</p>
        ) : null}
      </div>
      {due ? (
        <Tooltip
          content={
            checkout.isOverdue
              ? 'Past its due date — this loan is **overdue**.'
              : 'The date this loan is **due back**.'
          }
          openDelayMs={INFO_OPEN_DELAY_MS}
        >
          <span
            className={`inline-flex items-center gap-1 text-xs [&_svg]:size-3.5 ${
              checkout.isOverdue ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            <DueDateIcon />
            {due}
          </span>
        </Tooltip>
      ) : null}
      <Tooltip
        content="Change this loan’s due date without ending it. The loan keeps its original checkout date and history."
        triggerTabIndex={-1}
      >
        <span>
          <Button variant="ghost" size="sm" onClick={onRenew}>
            <RenewIcon />
            Renew
          </Button>
        </span>
      </Tooltip>
      <Tooltip
        content="Check this item back in. Stock returns to the location — and exact lot — it was lent from."
        triggerTabIndex={-1}
      >
        <span>
          <Button variant="outline" size="sm" onClick={onReturn}>
            <CheckInIcon />
            Return
          </Button>
        </span>
      </Tooltip>
    </Surface>
  );
}
