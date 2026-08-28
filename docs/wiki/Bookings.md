# Bookings

A **booking** reserves an item for a [[contact|Contacts]] over a **date range** — ahead of time,
before they take it. Perfect for shared equipment, hire kit, or anything several people want on
different days.

**Where to find it:** the **Bookings** screen (in the menu, when the module is enabled).

![The Bookings screen explaining when to reserve an asset](images/bookings.png)

## Reserving an item

Create a booking for an item and set a **start and end date**. The item is now spoken for over
that window — a plan for the future, distinct from a [[loan|Loans-Check-Out-and-In]] (which is
stock that's *out right now*).

Naming a **contact** is optional. Leave it blank to hold the slot before you know who it's for —
Gubbins asks who the item is going to when you check the booking out, and you can name someone
on the booking itself at any time before that.

Bookings are grouped by status — upcoming, active, overdue and so on — with a count beside each
heading. The screen reads as many bookings as it can at once; if you have more than that, it says
so beneath the form rather than quietly showing you part of the picture. Cancelling or deleting
bookings you've finished with keeps the list to a useful length.

## Changing a booking

Plans move. **Edit** on a booking's card changes who it's for, the dates it covers, and its note,
without giving up the reservation. New dates are checked for clashes just like a new booking, so
you can't move one on top of another.

Editing is also how you repair a booking that has lost its contact: deleting a [[contact|Contacts]]
clears them from their future bookings, and a booking with nobody's name on it can't be checked
out until one is given.

> **💡 Tip**
> You don't have to edit a booking just to check it out. If it doesn't name anyone, Gubbins asks
> who the item is going to at that moment and adds them to your contacts if they're new.

Once a booking has been **checked out** or **cancelled** it's a record of what happened, so it can
no longer be edited — the loan it became carries its own dates and note.

## Overlap detection

Gubbins checks for **clashes**: if you try to book an item that's already reserved for an
overlapping period, it tells you — so two people can't unknowingly claim the same thing on the
same day.

> **ℹ️ Note**
> If two devices are offline and each books the same asset for overlapping dates, they can't see
> each other's reservation at the time. When they next [[sync|Cloud-Sync]], Gubbins keeps the
> booking made **first** and cancels the later clashing one — see
> [[Cloud sync → overlapping bookings|Cloud-Sync]]. The same goes for *checking a booking out* on
> two offline devices: the two are merged into one loan rather than lending the asset twice.

> **⚠️ Heads-up**
> A booking outlives the item it reserves. If the asset is **removed from inventory** after the
> booking was made — by hand, or by a [[cycle count|Cycle-Counts-and-Audit-Day]] that couldn't find
> it — the reservation stays in the list, but checking it out is refused. Cancel the booking, or
> restore the item, whichever matches what actually happened.

> **💡 Tip**
> Bookings turn Gubbins into a simple shared-equipment scheduler. Reserve the good camera for a
> shoot next week, and anyone else booking it sees it's taken.

## Bookings in your agenda

Upcoming bookings and their return dates appear in the [[Upcoming agenda|Upcoming-Agenda]], so a
reservation coming up (or an item due back) is never a surprise. Bookings can also be surfaced to
your calendar via the [[iCal feed|Webhooks-MQTT-and-iCal]].

> **ℹ️ Note**
> A **booking** is a future reservation; a **[[loan|Loans-Check-Out-and-In]]** is an item that's
> physically out now. A booking typically becomes a loan when the contact actually collects the
> item.

> **💡 Tip**
> **Export** saves the whole booking list as a spreadsheet or a table — a reservation schedule to
> circulate, or to check against a diary. Each row carries the asset, who it's for, the booked days
> and its status. See [[Export & import|Export-and-Import]].

## Related pages

- **[[Loans|Loans-Check-Out-and-In]]** — checking a reserved item out when it's collected.
- **[[Export & import|Export-and-Import]]** — saving the booking list to a file.
- **[[Contacts]]** — who a booking is for.
- **[[Upcoming agenda|Upcoming-Agenda]]** — bookings alongside everything else due.
