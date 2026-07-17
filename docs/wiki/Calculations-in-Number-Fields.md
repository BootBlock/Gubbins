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
- Everything works from the keyboard — type the sum and press **Enter**.

## Related pages

- **[[Items]]** — where you'll enter quantities, costs and capacities.
- **[[Locations & stock|Locations-and-Stock]]** — capacities and on-hand counts.
- **[[Low stock & gauges|Low-Stock-and-Gauges]]** — reorder points and thresholds.
- **[[Command palette & shortcuts|Command-Palette-and-Shortcuts]]** — more keyboard-first conveniences.
