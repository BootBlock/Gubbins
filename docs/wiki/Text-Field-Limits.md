# How long a text field can be

Every box you type words into has a **maximum length**. The limits are generous — far longer than
anything you would normally write — and they exist to catch a runaway entry, such as a whole
document pasted into a name box or one bad cell in an imported spreadsheet.

**Where to find it:** every text field in Gubbins — item names, descriptions, notes, tags,
location names, custom-field values, manufacturer and part numbers, serials, and the rest.

## The limits

| The kind of field | How much it holds |
| --- | --- |
| A name, title or label — an item name, a location name, a tag, a manufacturer, a part number, a serial | 500 characters |
| A web address | 2,048 characters |
| A description, a note or a comment | 20,000 characters |
| A paste-in box for importing a file, or a webhook body template | 1,000,000 characters |

A character means a character: an emoji or a Chinese character counts as one, not two.

## What you see as a field fills up

- **Near the limit**, a small count appears under the field — *42 characters left* — so the
  ceiling never arrives as a surprise.
- **Past the limit**, the count is replaced by a message saying how far over you are, and the
  field is outlined as invalid. Saving is refused until it fits.

> **ℹ️ Note**
> **Nothing you type or paste is ever thrown away.** Gubbins does not cut a long paste down to
> the limit behind your back — it keeps every character and tells you it is too long, so you can
> decide what to shorten. This is the same rule number fields follow: see
> **[[Calculations in number fields|Calculations-in-Number-Fields]]**.

## Importing

An imported row whose cell is too long is reported as a problem with **that row**, and the rest of
the file still imports. See **[[Export & import|Export-and-Import]]**.

> **💡 Tip**
> If a name is bumping against the 500-character limit, it is almost certainly a description
> rather than a name. Put the detail in the item's **Description** or **Notes**, which hold forty
> times as much, and keep the name to something you can pick out of a list.

## Accessibility

- Going over the limit **marks the field as invalid** for assistive technology, and the message
  explaining it is announced as soon as it appears.
- The running count is left unannounced on purpose: it changes with every keystroke, and reading
  it out would talk over your typing. The message that matters — the one saying the entry is too
  long — is announced.

## Related pages

- **[[Items]]** — names, descriptions and notes.
- **[[Custom fields & capabilities|Custom-Fields-and-Capabilities]]** — text, long-text and link
  fields you define yourself.
- **[[Calculations in number fields|Calculations-in-Number-Fields]]** — the same rules applied to
  figures.
- **[[Export & import|Export-and-Import]]** — where an over-long cell shows up.
