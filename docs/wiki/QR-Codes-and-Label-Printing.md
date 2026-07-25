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

## Long names on a small label

A name only has so much room. Where one is too long for the label, Gubbins keeps it to **two
lines** and finishes it with an ellipsis (…) rather than letting it run on. On a die-cut label the
QR code gives up a little height to make room, so the name and the code both stay whole.

> **💡 Tip**
> The preview in the print dialog is the label: it shortens the name in exactly the same place the
> printed one will, so what you approve on screen is what comes out. If the shortened name is
> ambiguous, choose a larger label size or fewer columns per sheet, or turn on another field —
> a part number or location — under **Show on label** to tell similar items apart.

## QR code or barcode?

Each label can carry a **QR code**, a **Code 128 barcode**, **both**, or **no code at all** — pick
under **Code** in the print dialog.

- **QR** holds a full link, so scanning one with any phone camera opens that exact item or
  location in Gubbins. It stays readable at small sizes, which makes it the right choice for most
  labels.
- **Code 128** is the familiar striped barcode, for a handheld laser scanner of the kind used in
  warehouses. It carries an item's **part number** — or a location's **name** — as plain text, so
  scanning one types that value wherever your cursor is.

> **⚠️ Heads-up**
> A Code 128 barcode is *wide*: every character adds another group of bars, so a long value on a
> small label collapses into a grey smear no scanner can read. Gubbins won't print one. If the
> value is too long for the label, the barcode carries a short code for that item or location
> instead, and the print dialog says so above the preview. That short code needs a label **a little
> over 32 mm wide**, so on the smallest sizes — the 30 × 15 mm labels, say — only a genuinely short
> name or part number prints as a barcode at all; anything longer leaves the barcode off entirely.
> Choose a wider label size, use fewer columns per sheet, or switch to a QR code. Either
> way the barcode prints its own value underneath in plain
> characters — so if you want the full name or part number on the label as well, turn on the
> matching field under **Show on label**.

> **ℹ️ Note**
> A Code 128 barcode can only carry plain unaccented characters, so Gubbins writes accented
> letters in their nearest plain form: a location called **Café Störage** prints a barcode reading
> `Cafe Storage`, and **Größe** becomes `Grosse`. Curly quotes, dashes and the like are squared off
> the same way. Where there is no plain equivalent at all — a name in Japanese, Greek or Cyrillic,
> or one carrying an emoji or a currency sign — the barcode carries the item's or location's short
> code instead of a half-written name. The QR code is unaffected: it always links to the exact
> record, whatever the name is written in, and so does the name printed on the label itself.

## Choosing the address labels point to

A printed code carries a full web address, so a label is only useful if the device scanning it can
reach that address. By default Gubbins uses whatever address you opened the app from — which is
fine day to day, but a label printed from `localhost`, or from one machine's own network address,
won't open on a phone.

**Settings → Labels & QR codes → Link host** sets the address printed codes point to instead. Leave
it blank to use the current address, or enter a stable name every device can reach — for example
`http://gubbins.local`. The preview underneath shows the exact link a code will carry, so you can
check it before printing anything.

> **⚠️ Heads-up**
> A QR code can only hold so much text. If the host you enter is long enough to push the link past
> that limit, Gubbins says so directly under the field — shorten the name or address and the
> warning clears. Labels printed while the warning shows would come out without a QR code.

## Related pages

- **[[Camera scanning|Camera-Scanning]]** — scanning the codes you print, and tapping NFC tags.
- **[[Continuous scan & batch actions|Continuous-Scan-and-Batch-Actions]]** — processing many
  labelled items quickly.
- **[[Locations & stock|Locations-and-Stock]]** — labelling where things live.
