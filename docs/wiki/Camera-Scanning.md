# Camera scanning

Point your device's camera at a barcode or QR code and Gubbins finds the item — no typing. It's
the fastest way to look something up, check it out, or move it.

**Where to find it:** the **Scan** button on the Inventory screen, once the **Live camera
scanning** capability is enabled ([[Modular UI|Modular-UI]]).

## How it works

Gubbins reads codes using your browser's built-in barcode detector where available, and falls
back to an off-thread software decoder (WASM) where it isn't — so scanning works across a wide
range of devices, including older ones. It handles common **barcode symbologies** and **QR
codes**, and skips frames adaptively to stay smooth.

Scan a code and Gubbins matches it to an item by its barcode, then lets you act on it — view it,
adjust stock, [[check it out|Loans-Check-Out-and-In]], or move it.

While the camera is live you'll see a large framing box with a moving sweep line and a
**Scanning…** indicator, so it's always clear the camera is working and looking for a code. Hold
the code so it roughly fills the box — closer and larger reads far more reliably than small and
far away, especially on a lower-quality camera.

> **💡 Tip**
> If a code won't read, move it nearer so it fills more of the frame, steady your hand for a
> moment, and make sure it's well lit. You can always type or paste the code into the box at the
> bottom instead.

> **💡 Tip**
> Add a product's barcode to its **Details** (there's a **Scan** button right on the field) so
> future scans jump straight to it. A barcode Gubbins doesn't recognise can also trigger a
> [[product lookup|Scraping-Supplier-Data]].

> **ℹ️ Note**
> The camera is only used while you're actively scanning, on your device — no image ever leaves
> it. Live scanning is separate from printed [[labels|QR-Codes-and-Label-Printing]]: turning the
> camera capability off doesn't affect your printed QR codes. See
> [[Privacy & security|Privacy-and-Security]].

## When a code isn't found

A barcode with no matching item isn't an error — it just means nothing's linked to it yet. You
can create an item for it, or (for groceries) try a [[product lookup|Scraping-Supplier-Data]].

## Related pages

- **[[Continuous scan & batch actions|Continuous-Scan-and-Batch-Actions]]** — scan many items in
  a row and act on them together.
- **[[QR codes & label printing|QR-Codes-and-Label-Printing]]** — the labels you scan.
- **[[Receipt & label OCR|Receipt-and-Label-OCR]]** — reading text, not just codes.
