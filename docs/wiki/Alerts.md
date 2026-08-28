# Alerts

The **Alerts** feed gathers everything that **needs your attention** into one place — low stock,
expiring items, overdue loans, due servicing — so nothing important slips through.

**Where to find it:** the **Alerts** screen (in the menu, when the module is enabled), and the
attention widgets on the [[dashboard|Dashboard-and-Widgets]].

![The Alerts feed of items needing attention](images/alerts.png)

## What shows up

Alerts pulls together the things that are *wrong now or soon*:

- **Low / out of stock** — items at or below their [[reorder point / threshold|Low-Stock-and-Gauges]].
- **Expiring** — [[batches|Batches-and-Lots]] and perishables approaching their date.
- **Overdue loans** — items [[out with a contact|Loans-Check-Out-and-In]] past their due date.
- **Due maintenance & warranty** — [[servicing|Maintenance-and-Servicing]] due and
  [[warranties|Warranty-and-Depreciation]] about to lapse.
- **Custom field dates** — your own date fields that you've marked as
  [[due dates|Custom-Fields-and-Capabilities]], such as a renewal, an inspection or a return-by.

Each alert links straight to the thing that raised it, so you can act on it in a click.

If one category has more alerts than the screen can list at once, Gubbins shows the **most urgent**
of them and says, under that category's heading, how many there are in total. Nothing is hidden
without being counted.

> **💡 Tip**
> The inventory **status chips** mirror these categories, so you can filter your item list to just
> the low-stock or expiring items and deal with them in bulk.

> **ℹ️ Note**
> **Alerts** is about what's wrong *now or imminently*; the **[[Upcoming agenda|Upcoming-Agenda]]**
> is the forward calendar of everything *due*. They overlap but answer different questions — "what
> needs fixing?" versus "what's coming up?".

## Clearing an alert — for now, or for good

Once you've dealt with something, you don't want to keep hearing about it. Each alert has two
controls in its top-right corner:

- **Snooze** (the alarm-clock button) hides the alert for **a day, a week or a month**, then lets
  it come back by itself. Use this when you've already acted but the situation hasn't caught up
  yet — the replacement stock is on order, the service is booked — and you'd like a nudge later if
  it still isn't sorted.
- **Dismiss** (the ✕) hides the alert until you bring it back. Nothing re-raises it while the
  situation stays as it was, so it's the right choice for something you've decided to live with.

**Show all** appears in the header whenever anything is hidden, tells you how many, and brings back
everything — snoozed and dismissed alike.

Hiding an alert hides *that* alert, not the item behind it. Gubbins raises a fresh one — and lets it
through however you cleared the last — whenever the situation moves on:

- **It gets worse.** Dismiss "Expiring soon" for the yoghurt and you'll still be told when it
  actually **expires**; the same goes for a warranty running out, a service becoming overdue, and
  a custom date passing.
- **The date changes.** Correct a best-before, re-date a batch, push a renewal back or bring it
  forward, and the alert comes back against the new date.
- **It happens again.** Restock a low item and run it down again, or log a service and let the next
  one fall due, and that's a new alert rather than a silenced one.

> **💡 Tip**
> A snooze also quietens the matching **[[notification|Reminder-Notifications]]** for as long as it
> lasts, so a snoozed alert won't buzz your phone either. When it comes back, so does the reminder.

> **ℹ️ Note**
> What you've hidden is remembered **on that device only** — it isn't [[synced|Cloud-Sync]], so
> dismissing an alert on your laptop leaves it showing on your tablet. Gubbins keeps these notes
> tidy on your behalf: the record is discarded as soon as the situation it covered is over, and in
> any case once the alert has stopped appearing for a month — its item deleted, say.

## Getting alerts as notifications

On an **installed** app, alerts can also arrive as **[[OS notifications|Reminder-Notifications]]**,
so you hear about them without opening Gubbins.

## Taking the list with you

**Export** saves the alerts as a spreadsheet or a table — a to-do list to work through away from
the app, or to hand to whoever does the ordering. It contains **every** alert, including the ones
a long category only summarises on screen; anything you've snoozed or dismissed stays out of it.
See [[Export & import|Export-and-Import]].

## Related pages

- **[[Upcoming agenda|Upcoming-Agenda]]** — the forward view.
- **[[Export & import|Export-and-Import]]** — saving the alert list to a file.
- **[[Reminder notifications|Reminder-Notifications]]** — alerts as OS notifications.
- **[[Low stock & gauges|Low-Stock-and-Gauges]]** — the thresholds behind stock alerts.
- **[[Custom fields & capabilities|Custom-Fields-and-Capabilities]]** — marking one of your own
  date fields as a due date.
