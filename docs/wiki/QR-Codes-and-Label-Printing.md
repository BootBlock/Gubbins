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
> over 30 mm wide**, so on the smallest sizes — the 30 × 15 mm labels, say — only a genuinely short
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
