import { Button, Surface, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { CheckInIcon, DueDateIcon, RenewIcon } from '@/components/icons';
import type { CheckoutWithNames } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';

/**
 * A single open-loan row: the item, who/what it is out to (a contact, project or location —
 * B4's polymorphic borrower, shown verbatim via `borrowerName`), its due date, and one-tap
 * Renew / Return affordances. Shared by the Contacts hub, the contact detail dialog and the
 * project / location loan panels so every surface renders a loan identically.
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
          {checkout.quantity} with <span className="text-foreground">{checkout.borrowerName}</span>
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
