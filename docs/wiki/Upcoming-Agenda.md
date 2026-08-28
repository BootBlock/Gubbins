# Upcoming agenda

The **Upcoming** agenda is a single forward-looking calendar of **everything due** — booking
returns, loan due-backs, servicing, warranty expiries — so you can see what's coming and plan for
it.

**Where to find it:** the **Upcoming** screen (in the menu, when the module is enabled).

![The Upcoming agenda of everything due](images/upcoming.png)

## One agenda for everything due

Rather than checking several places, Upcoming unifies every kind of deadline into one
chronological list:

- **[[Booking|Bookings]]** starts and returns.
- **[[Loan|Loans-Check-Out-and-In]]** due-backs.
- **[[Maintenance & servicing|Maintenance-and-Servicing]]** that's due.
- **[[Warranty|Warranty-and-Depreciation]]** expiries.
- **[[Expiring batches|Batches-and-Lots]]** and perishables.
- **Your own [[date fields marked as due dates|Custom-Fields-and-Capabilities]]** — renewals,
  inspections, return-bys, anything you've defined.

Each entry links to the item or record behind it.

> **ℹ️ Note**
> A custom date field appears here as soon as you record it, however far off it is — Upcoming is
> the forward calendar. The **days' notice** you set on the field decides when it also starts
> raising an [[alert|Alerts]].

> **💡 Tip**
> Glance at Upcoming at the start of a week to get ahead — service the tools due soon, chase the
> loans coming back, and prep for the bookings on the way.

> **ℹ️ Note**
> **Upcoming** is the *forward calendar*; **[[Alerts]]** is *what's wrong now*. Something overdue
> appears in both — Alerts because it needs fixing, Upcoming because it was on the schedule.

## How far back Overdue reaches

Overdue entries are things that have already passed their date but are still worth acting on, so
the agenda keeps them at the top of the list. Two kinds of entry need a limit, because they never
get "done" and would otherwise pile up forever:

- **Warranty expiries** and **expiry dates** are listed while they are still in the future, and for
  **one year** after they pass. Anything that lapsed longer ago than that is history, and Upcoming
  says so under the Overdue section rather than filling it with dates from years back.

Everything else is bounded by its own lifecycle instead of by a date window. Servicing stays listed
until you record it as done, a loan stays listed until it comes back, and a booking drops off after
its last booked day.

> **ℹ️ Note**
> To see an older warranty or expiry date, open the item itself — the date is always on the item,
> whether or not the agenda still lists it.

## When there is more than fits

Upcoming reads every entry it has, but a very large inventory can hold more of one kind than the
screen can list. When that happens Upcoming names the kinds it had to cut short, just under the
filter chips, so a short list is never mistaken for a complete one. Use the chips to narrow the
agenda to the kind you care about, or the source screen — **[[Alerts]]**,
**[[Maintenance & servicing|Maintenance-and-Servicing]]**, **[[Bookings]]** — for the full picture.

## On your calendar

Upcoming deadlines can also be published to your own calendar app via an
**[[iCal feed|Webhooks-MQTT-and-iCal]]**, so Gubbins' agenda sits alongside the rest of your
schedule.

## Related pages

- **[[Alerts]]** — what needs action now.
- **[[Bookings]]**, **[[Loans|Loans-Check-Out-and-In]]**, **[[Maintenance & servicing|Maintenance-and-Servicing]]**
  — the sources of agenda items.
- **[[Custom fields & capabilities|Custom-Fields-and-Capabilities]]** — adding your own dated
  deadlines to this list.
- **[[Webhooks, MQTT & iCal|Webhooks-MQTT-and-iCal]]** — subscribing from your calendar.
