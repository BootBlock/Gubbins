# Camera scanning

Point your device's camera at a barcode or QR code and Gubbins finds the item — no typing. It's
the fastest way to look something up, check it out, or move it.

**Where to find it:** the **Scan** button on the Inventory screen, once the **Live camera
scanning** capability is enabled ([[Modular UI|Modular-UI]]).

## How it works

Gubbins reads codes using your browser's built-in barcode detector where available, and falls
back to an off-thread software decoder (WASM) where it isn't — so scanning works across a wide
range of devices, including older ones. It reads **QR codes**, the full family of common retail
barcodes — EAN‑13, EAN‑8, UPC‑A, UPC‑E — and the usual 1‑D part labels and 2‑D codes (Code 128,
Code 39, Code 93, Codabar, ITF, Data Matrix, Aztec and PDF417), skipping frames adaptively to stay
smooth. Where your camera supports it, Gubbins keeps the picture in focus automatically so a code
held at reading distance stays sharp.

Scan a code and Gubbins matches it to an item by its barcode, then lets you act on it — view it,
adjust stock, [[check it out|Loans-Check-Out-and-In]], or move it.

> **💡 Tip**
> Scanning every kind of code at once is convenient, but if you only ever scan one type — say
> **EAN‑13** for retail products — choosing just that under **[[Settings → Scanning &
> labels|Camera-Scanning]]** makes each read faster and more reliable. Leave it on *all supported
> codes* if you scan a mix.

While the camera is live you'll see a large framing box with a moving sweep line and a
**Scanning…** indicator, so it's always clear the camera is working and looking for a code.
Gubbins reads the picture **inside that box**, so a barcode framed in it is read on its own terms —
you don't have to fill the whole screen with it, whether you're on a phone or a larger screen.
Hold the code inside the box; good light and a steady hand still help most.

> **💡 Tip**
> If a code won't read, centre it in the framing box and move it a little nearer so it fills the
> box, steady your hand for a moment, and make sure it's well lit. You can always type or paste the
> code into the box at the bottom instead.

> **💡 Tip**
> Add a product's barcode to its **Details** (there's a **Scan** button right on the field) so
> future scans jump straight to it. A barcode Gubbins doesn't recognise can also trigger a
> [[product lookup|Scraping-Supplier-Data]].

> **💡 Tip**
> Typing a barcode by hand instead? Gubbins checks it as you move on. Retail barcodes carry a
> built-in check digit, so a mistyped or swapped digit is spotted and flagged under the field —
> which matters, because a barcode that's a digit out will never be found by a future scan. It's
> only a warning: you can still save whatever you typed, and codes that aren't retail barcodes
> (an internal shelf code, say) are left alone.

> **ℹ️ Note**
> Some packaging carries a **marketing QR code** (a website link) next to the real barcode. If
> you scan one into the **Barcode** field, Gubbins spots that it's a link rather than a barcode
> and offers to **open it** — it's never quietly saved as the item's barcode. Point at the
> product's own barcode to record that instead.

> **ℹ️ Note**
> The camera is only used while you're actively scanning, on your device — no image ever leaves
> it. Live scanning is separate from printed [[labels|QR-Codes-and-Label-Printing]]: turning the
> camera capability off doesn't affect your printed QR codes. See
> [[Privacy & security|Privacy-and-Security]].

## Tap-to-scan with NFC

On a supported phone, the scanner can also read **NFC tags** — no camera, no line-of-sight. When
the **NFC tags** capability is on and your device supports it, a **Ready — tap an NFC tag**
indicator appears at the top of the scanner. Hold a tag you've written from an item's label flat
against the back of your phone and Gubbins opens that item straight away, just like scanning its QR
code. It works right alongside the camera, so you can tap a tag or point at a code — whichever is
handier.

> **💡 Tip**
> NFC is perfect for a **closed or crammed** bin: stick a tag inside the lid, and a tap on the
> outside opens the item without opening the box or hunting for a label. See
> [[writing NFC tags|QR-Codes-and-Label-Printing]] to set them up.

> **ℹ️ Note**
> Tapping to scan needs a device with **Web NFC** — currently Android phones using a
> Chromium-based browser (Chrome, Samsung Internet, Opera). On other devices the indicator simply
> doesn't appear and camera scanning works as normal. The first tap asks your permission to use
> NFC.

## When a code isn't found

A barcode with no matching item isn't an error — it just means nothing's linked to it yet. Gubbins
offers to **add an item** with the barcode already saved to it, and — right there in the scanner —
to **look the product up** so its name and brand are filled in for you before you add it. That
lookup is optional: it happens only when you tap **Look up**, and you're asked once before the
first time (see [[Barcode → product lookup|Scraping-Supplier-Data]]).

## Related pages

- **[[Continuous scan & batch actions|Continuous-Scan-and-Batch-Actions]]** — scan many items in
  a row and act on them together.
- **[[QR codes & label printing|QR-Codes-and-Label-Printing]]** — the labels you scan, and writing
  NFC tags.
- **[[Receipt & label OCR|Receipt-and-Label-OCR]]** — reading text, not just codes.
