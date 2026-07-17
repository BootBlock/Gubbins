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

## Related pages

- **[[Camera scanning|Camera-Scanning]]** — scanning the codes you print, and tapping NFC tags.
- **[[Continuous scan & batch actions|Continuous-Scan-and-Batch-Actions]]** — processing many
  labelled items quickly.
- **[[Locations & stock|Locations-and-Stock]]** — labelling where things live.
