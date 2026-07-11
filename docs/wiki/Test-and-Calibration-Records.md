# Test & calibration records

For **serialised** units that need a proper audit trail — calibration, PAT testing, QA, service
checks — Gubbins records structured **pass/fail results with readings** against the individual
serial number, beyond the free-form [[maintenance history|Maintenance-and-Servicing]].

**Where to find it:** the **Lifecycle** tab of a **serialised** item's details, once the
capability is enabled ([[Modular UI|Modular-UI]]).

## What a record captures

Each record is a dated entry against a specific serialised unit, with:

- A **kind** — Test, Calibration, or Service.
- A **result** — Pass, Fail, Limit, or N/A.
- An optional **reading** — a measured value (which may be negative).
- A name/label and notes.

Over time these build a **chronological log** per unit — the audit trail a lab, calibration
house or maker keeps against a serial number.

> **ℹ️ Note**
> Test records are for **serialised** items only — they attach to an individual unit, so a Bulk
> or Consumable line (which has no single instance) doesn't have them. Set an item's tracking to
> **Serialised** to record results against it (see [[Tracking modes|Tracking-Modes]]).

> **💡 Tip**
> Use the **Limit** result for a reading that's within tolerance but close to the edge — it's a
> useful early signal that a unit is drifting and may fail its next check.

## Related pages

- **[[Tracking modes|Tracking-Modes]]** — serialising an item so it can hold per-unit records.
- **[[Maintenance & servicing|Maintenance-and-Servicing]]** — scheduled servicing and free-form
  history.
- **[[Condition grading|Condition-Grading]]** — the item's overall condition, including *Out for
  Calibration*.
