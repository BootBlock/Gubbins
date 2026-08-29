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

> **ℹ️ Note**
> An item you've **removed from inventory** can't be lent out. The **Check out** action is hidden
> on such an item, and any other route to it — an older [[booking|Bookings]], or the
> [[bridge|Bridge-Overview]] — is refused too. Restore the item first (tick **Show removed** in the
> inventory view) if you do want to lend it.

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

You can also record the item's **condition on return** and a short **return note** — both optional,
and both kept separate from the note you wrote when you lent it out.

### Returning part of a loan

Kit lent to a job rarely all comes back in one go. If you lent more than one of something, the
return asks **how many are coming back**, and it starts at everything still out — so returning the
lot is still a single tap.

Lower that number and Gubbins puts just those units back on the shelf and **leaves the loan open**
with the rest still out. The loan keeps its identity: the same due date, the same original checkout
date, and one continuous history rather than a new loan each time something trickles back. Lend six
drill bits, get two back today and four next week, and your on-hand count is right on both days.

The loan closes by itself when the last unit comes back — there is no separate "finish" step. Until
then it still counts as **on loan** everywhere: the borrower's list, the overdue reminders and the
item's on-loan badge all show it, because part of it genuinely is still out.

> **💡 Tip**
> The loan row shows what is **still with the borrower**, not what originally went out — so a loan
> reading "2 of 6 still with Sam" is telling you exactly what to chase.

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

## Lending from outside the app

If you run the [[bridge|Bridge-Overview]] and switch its **write-back** on, loans can also be
opened and closed from outside Gubbins — from
[[Home Assistant|Home-Assistant-Integration]], a script, or an
[[AI assistant|AI-Assistant-Query-MCP]]. It behaves exactly as it does in the app: stock leaves
your available count while the item is out, and a return puts it back in its original location and
lot. A return can name a **quantity** there too, so a rule can record part of a loan coming back
without closing it. Every one of those is recorded in the [[activity log|Activity-Log]] the same
way, so an automated return is as traceable as one you tapped yourself.

Loan due-backs already appear in the [[calendar feed|Webhooks-MQTT-and-iCal]], so a rule can spot
an overdue loan *and* close it once the item is back, rather than only telling you about it.

> **⚠️ Heads-up**
> Write-back is off by default and turning it on is a deliberate choice — see
> [[running the bridge|Running-the-Bridge]] for what it does and doesn't allow.

## Related pages

- **[[Contacts]]** — the people you lend to.
- **[[Bookings]]** — reserving items ahead of time.
- **[[Upcoming agenda|Upcoming-Agenda]]** — due-backs and other deadlines.
- **[[Bridge overview|Bridge-Overview]]** — lending from an automation or assistant.
- **[[Home Assistant integration|Home-Assistant-Integration]]** — lending from a smart-home rule.
