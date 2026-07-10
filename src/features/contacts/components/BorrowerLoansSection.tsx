import { useState } from 'react';
import type { CheckoutWithNames } from '@/db/repositories';
import { LoanRow } from './LoanRow';
import { CheckInDialog } from './CheckInDialog';
import { RenewLoanDialog } from './RenewLoanDialog';

/**
 * A self-contained panel listing the loans currently out **to** one borrower — a project or a
 * location (B4). It renders each open loan via the shared {@link LoanRow} (so a project/location
 * loan is returnable and renewable exactly like a contact loan) and owns the Return / Renew
 * dialog state so a host screen only has to feed it the borrower's open checkouts.
 *
 * Returned loans are filtered out here (the panel shows what is still out); an empty list
 * renders the caller's `emptyText`. Kept deliberately borrower-agnostic — it reads only the
 * generic `CheckoutWithNames`, never which kind of target it belongs to.
 */
export function BorrowerLoansSection({
  loans,
  emptyText,
  'data-testid': testId,
}: {
  loans: readonly CheckoutWithNames[];
  emptyText: string;
  'data-testid'?: string;
}) {
  const [returningCheckout, setReturningCheckout] = useState<CheckoutWithNames | null>(null);
  const [renewingCheckout, setRenewingCheckout] = useState<CheckoutWithNames | null>(null);

  const open = loans.filter((c) => c.status === 'OPEN');

  return (
    <div data-testid={testId}>
      {open.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {open.map((c) => (
            <li key={c.id}>
              <LoanRow
                checkout={c}
                onReturn={() => setReturningCheckout(c)}
                onRenew={() => setRenewingCheckout(c)}
              />
            </li>
          ))}
        </ul>
      )}

      {returningCheckout ? (
        <CheckInDialog open onClose={() => setReturningCheckout(null)} checkout={returningCheckout} />
      ) : null}
      {renewingCheckout ? (
        <RenewLoanDialog open onClose={() => setRenewingCheckout(null)} checkout={renewingCheckout} />
      ) : null}
    </div>
  );
}
