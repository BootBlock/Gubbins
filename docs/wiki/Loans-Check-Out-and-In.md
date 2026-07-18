# Loans — check out & in

Lend a tool to a friend, sign kit out to a colleague, take something home for the weekend —
**loans** track items that are temporarily *out* with a [[contact|Contacts]], and bring them back
to exactly where they came from.

**Where to find it:** an item's actions (**Check out**), and the **Contacts** screen for what's
currently out.

## Checking out

**Check out** an item to a contact and Gubbins records who has it and, optionally, when it's due
back. The stock leaves your available count while it's out, so your numbers stay truthful.

If the contact doesn't exist yet, you can create them right from the checkout — no need to set up
the [[contact|Contacts]] first.

### Prerequisites go with it

If the item you're lending **requires** another one — an access point that needs its power
injector, a printer that needs a particular build plate — the checkout lists those prerequisites
and offers to lend them at the same time. Each shows how many are on hand, and the ones you have
stock for start ticked, so the common case is a single click.

Untick anything you don't want to send. A prerequisite with nothing on hand is still listed, so
you can see the gap, but it can't be selected.

> **ℹ️ Note**
> This is a prompt, not a block — the loan always goes ahead whether or not you bring the
> prerequisites along. Record the dependency on the **Related** tab of the item that needs it; see
> [[Related items|Tags-Attachments-and-Related-Items]].

## Checking in

When the item comes back, **check it in**. Gubbins returns the stock to its **original location
and lot**, so a returned item lands exactly where it belongs rather than in a limbo pile.

## Overdue tracking & audit trail

- A loan with a due date that passes becomes **overdue** and surfaces in [[Alerts|Alerts]] and the
  [[Upcoming agenda|Upcoming-Agenda]].
- Every checkout and return is recorded in the [[activity log|Activity-Log]], giving a full
  history of who had what, and when.
- Time on loan accrues **checkout-hours**, which can drive usage-based
  [[maintenance|Maintenance-and-Servicing]].

> **💡 Tip**
> Set a due date when you lend something out — it's the difference between "I think Sam has it"
> and a clear overdue reminder that prompts you to chase it up.

> **ℹ️ Note**
> A loan is temporary and comes back. To reserve an item for someone *in advance* over a date
> range, use a **[[booking|Bookings]]**; to record something leaving for good, use
> **[[sales & disposals|Sales-and-Disposals]]**.

## Related pages

- **[[Contacts]]** — the people you lend to.
- **[[Bookings]]** — reserving items ahead of time.
- **[[Upcoming agenda|Upcoming-Agenda]]** — due-backs and other deadlines.
