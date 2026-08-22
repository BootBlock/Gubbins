# Calculations in number fields

Any number box in Gubbins can do **quick maths for you**. Instead of reaching for a calculator,
type the sum straight into the field — `500/2` — and Gubbins works out the value (`250`) when you
press **Enter** or click away.

**Where to find it:** every numeric field — quantities, unit costs, capacities, weights,
reorder points, warranty windows, and the rest.

## How it works

1. Click into a number field and type a calculation, e.g. `24/2` or `12*3`.
2. A small **preview** appears at the edge of the field showing the running result (`= 12`).
3. Press **Enter**, or simply click/tab away, and the field settles to the answer.

If what you typed isn't a valid sum, the field is left exactly as you typed it — nothing is
guessed or thrown away — so you can fix it and try again.

## What a number box will accept

A number box only takes characters a figure can contain: digits, a full stop for decimals, the
operators listed below, and the `e` of an exponent. A letter, a symbol or a pasted line break
simply does not appear as you type it, so `12kg` leaves `12` in the box. Enter the unit somewhere
it belongs — a note, or the field's own unit setting — rather than in the figure.

A **comma is the one exception**: it stays in the box and is reported as unusable rather than
removed. `1,250` means one thousand two hundred and fifty in English and `250,00` means two
hundred and fifty in German, so dropping the character would have to guess which you meant.
Retype the figure with no separator, using a full stop for any decimals.

## Staying inside the allowed range

Many fields accept only part of the number line: a pack size is at least `1`, a percentage runs
from `0` to `100`, a label is between `10 mm` and `300 mm` across.

- **The arrow keys step the value.** Press **Up** or **Down** to move it by one step — or by the
  field's own increment, such as `0.1` for a label size — and it stops at either end of the
  range rather than running past it.
- **The box itself does not rewrite what you type.** A figure outside the range is marked as
  out of range and left alone, so working out `500/2` is the only thing that ever changes a
  number you entered. Where a field also shows a message beneath it, that message explains what
  is wrong.
- **A few screens do settle a value for you.** Label sizes and some Settings thresholds bring an
  out-of-range figure back to the nearest one they accept as you leave the box. Where that
  happens you see the new figure straight away, before anything is saved.

> **ℹ️ Note**
> Some fields carry no message of their own, and simply keep their button unavailable until the
> figure is one they can use. Check the range shown in the field's help if a button stays greyed
> out.

## What you can type

| You type | You get | Notes |
| --- | --- | --- |
| `500/2` | `250` | Divide |
| `12*3` | `36` | Multiply (`×` works too) |
| `40+8` | `48` | Add |
| `50-6` | `44` | Subtract (`−` works too) |
| `(2+3)*4` | `20` | Parentheses set the order |
| `200*15%` | `30` | `%` means "divide by 100", so this is 15% of 200 |
| `2^10` | `1024` | `^` raises to a power |

Spaces are ignored, so `500 / 2` is fine. Ordinary priority applies — `2+3*4` is `14`, not `20`.

> **💡 Tip**
> This is perfect for splitting a pack (`kg` you bought ÷ number of items), scaling a recipe or
> a bill of materials, or working out a percentage discount without leaving the field.

> **ℹ️ Note**
> The calculator only ever changes the **single field** you typed into. It's a convenience for
> entering a value, not a formula that stays linked to anything — the field just holds the number
> you worked out.

## Accessibility

The feature is built to be usable by everyone:

- Each number field tells assistive technology that it **accepts calculations**, so the help is
  never hidden behind a hover.
- The **worked-out result is announced** when the field settles, so you don't have to see the
  preview to know what it became.
- Everything works from the keyboard — type the sum and press **Enter**, and use **Up** and
  **Down** to step a field that has a range.
- A field with a range reports that range to assistive technology, along with the value it
  currently holds, so its limits are spoken rather than only shown.
- A value outside the range is **marked as invalid** for assistive technology, so it is announced
  and not only outlined.

## Related pages

- **[[Items]]** — where you'll enter quantities, costs and capacities.
- **[[Locations & stock|Locations-and-Stock]]** — capacities and on-hand counts.
- **[[Low stock & gauges|Low-Stock-and-Gauges]]** — reorder points and thresholds.
- **[[Command palette & shortcuts|Command-Palette-and-Shortcuts]]** — more keyboard-first conveniences.
