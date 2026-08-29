# QR codes & label printing

Give your items and locations **printed labels** with QR codes, so a quick scan jumps straight to
the right record. Ideal for bins, drawers, shelves and asset tags.

**Where to find it:** an item's actions (**Print label**), and the batch label sheet in the
Inventory tools, once the **Label printing** capability is enabled ([[Modular UI|Modular-UI]]).

## Per-item QR codes

Every item can produce a **deep-link QR code** — scanning it opens that exact item in Gubbins.
Stick one on the thing itself (or its box) and you've got an instant link between the physical
object and its record.

## Writing to NFC tags

On a supported phone you can also write an item's link to a **blank NFC tag** — a cheap sticker
you can hide inside a bin's lid or under a shelf. Open an item's **Print label** dialog and tap
**Write to tag**, then hold a blank tag flat against the back of your phone until it saves. From
then on, a tap of that tag opens the item in Gubbins, exactly like scanning its QR code — no
line-of-sight, no camera, no need to find the printed label.

> **💡 Tip**
> NFC shines where a camera struggles: a closed component bin, a densely-packed drawer, or dim
> light. Tap the outside of the bin and Gubbins opens the item inside.

> **ℹ️ Note**
> Writing tags needs a device with **Web NFC** — currently Android phones using a Chromium-based
> browser (Chrome, Samsung Internet, Opera). The **Write to tag** button only appears where it's
> supported and the **NFC tags** capability is enabled ([[Modular UI|Modular-UI]]); everywhere
> else, printed QR codes do the same job. See [[Camera scanning|Camera-Scanning]] for reading tags
> back.

## Batch label sheets

Need lots of labels at once? Gubbins lays out a **printable A4 sheet** of QR labels you can run
off in one go — perfect for labelling a new storage system or a batch of assets.

> **💡 Tip**
> Label your **locations** as well as items. A QR code on each shelf or bin means you can scan
> *where you are* and instantly filter to what should be there — a huge help during a
> [[cycle count|Cycle-Counts-and-Audit-Day]].

## Printing onto a sheet of sticker labels

Choose **A4 sheet** under **Label size** and a second setting appears: **Sheet layout**. This is
where you say what you are printing *onto*.

Every entry says how many labels the sheet carries and how big one label is — **18 per sheet —
60 × 42 mm**, say — with what the sheet is beside it: the code the stock is usually sold under,
or *Plain paper* for the first entry.

- **Plain paper** — the default. Labels are laid out generously across a blank sheet with a faint
  outline round each one to cut along.
- **A named sticker sheet** — pick the one that matches the packet in your printer. Gubbins then
  uses that sheet's own columns, rows, margins and gutters, so every label lands squarely on a
  sticker rather than across the gap between two.
- **Custom…** — enter the columns, rows, page margins and gutters yourself, for stock that isn't
  listed.

Whichever you pick, the size one label works out to is shown underneath as **Each label: …**, so
you can check it against the packet before printing anything.

Beside it sits **Print cut guides**. Leave it on for plain paper, where the outline is the only
thing telling you where one label ends and the next begins; turn it off for a pre-cut sheet, where
it would just print a grey box inside every sticker. Choosing a named sheet turns it off for you.

### Print at 100%, or the labels miss the die-cuts

A named sheet is laid out to that stock's published geometry down to a hundredth of a millimetre,
so the one thing that decides whether each label lands on its sticker is your browser's own print
dialog. Two of its settings undo the layout:

- **Scale** — set it to **100%** (some browsers call it *Actual size*). Anything else, including
  *Fit to page*, shrinks or grows the whole grid. A fraction of a percent is invisible on the first
  row and half a sticker out by the last.
- **Margins** — leave them as the document sets them (**Default**, or whatever your browser calls
  the option that does not override the page). *Minimum* or *None* moves the grid on the page.

The same goes for a **Custom…** grid: stock the list does not carry needs the settings to be right
just as much, with no preset to fall back on. Gubbins cannot see or set either one — the browser
applies them to the finished page — so it says so in the print dialog whenever you choose anything
other than plain paper.

> **💡 Tip**
> Run one sheet on **ordinary paper** first and hold it against a sheet of the real labels up to
> the light. It costs one sheet of paper instead of a sheet of stickers — and it is the only way to
> see the scale is right before you spend the stock.

> **ℹ️ Note**
> Every label on the sheet is given the same fixed size, so a long name on one label can never
> push the labels below it down the page. If a name is too long for the label you have chosen, it
> is the name that gets cut short — the alignment holds.

> **ℹ️ Note**
> Printed labels are independent of [[live camera scanning|Camera-Scanning]] — they keep working
> whether or not the camera capability is enabled, and any phone camera app can open the deep
> link.

## Label size: A4 sheet or die-cut labels

**Label size** in the print dialog decides the shape of the whole job.

- **A4 sheet (grid)** tiles labels across an ordinary sheet of paper, as many per row as
  **Columns per sheet** says. Each one gets a light border to cut or guillotine along. This is the
  right choice for ordinary printers and for blank sticker sheets.
- A **die-cut size** — one of the common roll sizes, from 30 × 15 mm up to a 100 × 150 mm shipping
  label, or **Custom…** for an exact width × height you type — prints **one label per page at that
  exact physical size**, for a thermal or die-cut label printer of the kind that feeds pre-cut
  labels off a roll.

Gubbins keeps a small **safe margin** clear at every edge of a die-cut label, and nothing is
printed into it. Labels drift a fraction of a millimetre as the roll feeds, and the die itself is
cut to a tolerance, so a design laid out right to the edge loses whatever the drift happens to be —
a clipped corner off the QR code, or the last letter of a name. The margin absorbs that; the label
is still printed at the full size you chose.

> **⚠️ Heads-up**
> A die-cut size only comes out right on a printer loaded with **that** label. Choose one and the
> print dialog reminds you of the exact size to set as the printer's paper size. Send the same job
> to an ordinary A4 printer and there is nothing Gubbins can do about it: the browser either blows
> the tiny page up to fill the sheet or crops it against the printer's own unprintable border, with
> no warning of its own. Print on ordinary paper with **A4 sheet (grid)** instead.

> **💡 Tip**
> Choose the size first. It sets how much room the code and text have, so it decides how many lines
> of text fit — and whether a barcode can print at all (see below).

## The short code — the label's fallback identifier

Every label also prints a **short code**: eight characters such as `A1B2C3D4`, on the last line,
underneath the name and any other fields. It is the same for the life of the item or location, and
no two records you are likely to hold share one.

It is there for the day the code stops working. A QR gets scuffed against a toolbox, a barcode
smudges, a corner tears off in a damp shed — and a label carrying only a name identifies nothing in
particular, especially if two bins hold the same part or the name has been edited since. Type the
short code into the box at the bottom of the [[scanner|Camera-Scanning]] instead and Gubbins opens
the item, or jumps to the location, exactly as scanning would have.

Turn it off with the **Short code** tick under **Show on label** if you need the room for something
else.

> **💡 Tip**
> The short code is worth reading out too. "Which one have you got — A1B2C3D4?" settles over the
> phone what a name and a photo often cannot.

> **ℹ️ Note**
> Where the barcode has already fallen back to that same short code (see *QR code or barcode?*
> below), it is not printed twice — the characters under the bars are the short code, and the extra
> line is dropped so the label keeps the space.

## What a location label prints

A **location** label carries a QR code of the shelf or bin itself, so scanning it opens Gubbins at
that location. Three ticks in the **Print location label** dialog decide what is printed around it:

- **Show location** — the location's own name, such as *Storage Box 4*, under the code. On by
  default. It is the line you read without a scanner, so leave it on unless the bin is already
  named on the outside, or the label is small enough that the QR code needs every millimetre.
- **Show full path** — the ancestors above it, such as *Garage ▸ Shelf B*, on the line below the
  name. On by default, and only offered where the location has a parent. It tells same-named bins
  apart at a glance.
- **Short code** — the fallback identifier described above.

Clear all three and you get a code-only sticker: still scannable, but nothing on it says which
location it belongs to until you scan it.

> **⚠️ Heads-up**
> Each line you turn on takes height from the QR code. Turning them all on for a small die-cut
> label can leave the code too small for a phone camera — Gubbins says so in the dialog when it
> does. The preview is the label, so check it before you print a sheet.

## Long names on a small label

A name only has so much room. Where one is too long for the label, Gubbins keeps it to **two
lines** and finishes it with an ellipsis (…) rather than letting it run on. On a die-cut label the
QR code gives up a little height to make room, so the name and the code both stay whole.

> **💡 Tip**
> The preview in the print dialog is the label: it shortens the name in exactly the same place the
> printed one will, so what you approve on screen is what comes out. If the shortened name is
> ambiguous, choose a larger label size or fewer columns per sheet, or turn on another field —
> a part number or location — under **Show on label** to tell similar items apart. The **short
> code** already on the label tells them apart for certain, if not at a glance.

## QR code or barcode?

Each label can carry a **QR code**, a **Code 128 barcode**, **both**, or **no code at all** — pick
under **Code** in the print dialog.

- **QR** holds a full link, so scanning one with any phone camera opens that exact item or
  location in Gubbins. It packs that link into a square instead of a row of bars, so it stays
  readable on far smaller labels than a barcode does — which makes it the right choice for most
  labels.
- **Code 128** is the familiar striped barcode, for a handheld laser scanner of the kind used in
  warehouses. It carries an item's **part number** — or a location's **name** — as plain text, so
  scanning one types that value wherever your cursor is.

> **⚠️ Heads-up**
> A QR code has its limits too. The link it carries fixes how many squares — *modules* — it is
> made of, so the smaller the label, the smaller each one prints; below about a quarter of a
> millimetre a phone camera stops resolving them, and the code is a tidy little square that simply
> never scans. The print dialog says so above the preview whenever the size you have chosen would
> take it past that point, so you find out before the labels are on the boxes. **Choose a larger
> label size, a sheet layout with larger labels, or show fewer lines of text** — every line of text
> takes its height out of the code. The code is still printed either way; the warning is there
> because only you can decide whether it is worth a sheet of stickers.
>
> A longer **link host** (see [Choosing the address labels point to](#choosing-the-address-labels-point-to)
> below) makes the code denser, so a shorter one buys back a little room on small labels.

> **⚠️ Heads-up**
> A Code 128 barcode is *wide*: every character adds another group of bars, so a long value on a
> small label collapses into a grey smear no scanner can read. Gubbins won't print one. If the
> value is too long for the label, the barcode carries the item's or location's **short code**
> instead, and the print dialog says so above the preview. That short code needs a label **a little
> over 32 mm wide**, so on the smallest sizes — the 30 × 15 mm labels, say — only a genuinely short
> name or part number prints as a barcode at all; anything longer leaves the barcode off entirely.
> Choose a wider label size, a sheet layout with wider labels, or switch to a QR code. Either
> way the barcode prints its own value underneath in plain
> characters — so if you want the full name or part number on the label as well, turn on the
> matching field under **Show on label**.

> **ℹ️ Note**
> A Code 128 barcode can only carry plain unaccented characters, so Gubbins writes accented
> letters in their nearest plain form: a location called **Café Störage** prints a barcode reading
> `Cafe Storage`, and **Größe** becomes `Grosse`. Curly quotes, dashes and the like are squared off
> the same way. Where there is no plain equivalent at all — a name in Japanese, Greek or Cyrillic,
> or one carrying an emoji or a currency sign — the barcode carries the item's or location's
> **short code** instead of a half-written name. The QR code is unaffected: it always links to the exact
> record, whatever the name is written in, and so does the name printed on the label itself.

## Choosing the address labels point to

A printed code carries a full web address, so a label is only useful if the device scanning it can
reach that address. By default Gubbins uses whatever address you opened the app from — which is
fine day to day, but a label printed from `localhost`, or from one machine's own network address,
won't open on a phone.

**Settings → Labels & QR codes → Link host** sets the address printed codes point to instead. Leave
it blank to use the current address, or enter a stable name every device can reach — for example
`https://gubbins.local`. The preview underneath shows the exact link a code will carry, so you can
check it before printing anything.

The address has to be an `https://` one — or `localhost` while you are testing on the same machine.
Browsers only grant Gubbins the storage it needs on a secure address, so the app cannot open from a
plain `http://` one at all, and a code pointing there would scan to an error rather than to the
item. If you leave the `https://` off, Gubbins fills it in for you — except for `localhost`,
where it fills in `http://`, because that is the one address a browser trusts without it.

Enter the **whole** address, including any folder the app is served from — `https://example.com/Gubbins/`,
not just `example.com`. The Link host replaces the address entirely, so a missing folder is dropped
from every printed link. The preview shows what you will actually get.

> **⚠️ Heads-up**
> Gubbins warns you under the field in two cases: the address is a plain `http://` one the app can
> never open, or it is long enough to push the link past what a QR code can hold. Labels printed
> while a warning shows are wasted — a dead link in the first case, no QR code at all in the second.
> Fix the host and the warning clears.

## If nothing happens when you press Print

Gubbins builds the label sheet inside the page itself and hands it straight to your browser's own
print dialog, so no extra window has to open. Where a browser refuses even that, the label dialog
says so in a notice rather than leaving you pressing a button that appears to do nothing.

> **⚠️ Heads-up**
> A pop-up blocker, a content blocker or a workplace browser policy is the usual cause. Allow
> pop-ups for the address Gubbins is served from, then press **Print** again.

## Related pages

- **[[Camera scanning|Camera-Scanning]]** — scanning the codes you print, and tapping NFC tags.
- **[[Continuous scan & batch actions|Continuous-Scan-and-Batch-Actions]]** — processing many
  labelled items quickly.
- **[[Locations & stock|Locations-and-Stock]]** — labelling where things live.
