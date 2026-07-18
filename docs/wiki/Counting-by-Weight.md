# Counting by weight

Counting 150 tiny M3 screws or 80 LEDs by hand is tedious and error-prone. If Gubbins knows what
**one** of them weighs, it can count a handful for you: put them on a scale, type in the reading,
and Gubbins works out how many are there.

**Where to find it:** **Count by weight…** in an item's **More** menu.

## Setting it up

Counting by weight needs one thing recorded against the item: its **weight** — the mass of a
single unit. Edit the item and set it once (for example, one M3 screw at `0.5 g`), and every
future count uses it.

The weight is stored for the item as a whole, so it's worth being reasonably precise: weigh ten
or a hundred units on a kitchen scale and divide, rather than trusting a single unit reading on a
scale that only resolves to the nearest gram.

> **💡 Tip**
> Weights are entered and shown in whatever unit you've chosen under
> [[language & region|Language-and-Region]] — grams, kilograms, ounces or pounds. Gubbins stores
> them in one canonical unit behind the scenes, so changing the setting never alters your data.

## Counting a handful

Open **Count by weight…** on the item and fill in:

- **Weight on scale** — the total reading, including anything the parts are sitting in.
- **Container weight** — optional. The weight of the empty tray, bag or pot. Leave it blank if
  the parts are loose on the scale, or if you zeroed the scale with the empty container already
  on it. **Pick a container…** fills it from the
  [[container weights|Container-Weights]] library, so a tray you use often needn't be re-weighed.

Gubbins subtracts the container, divides by the unit weight, and shows the count along with how
it compares to the quantity already recorded. **Apply count** adjusts the item's stock and notes
in the [[activity log|Activity-Log]] how the new figure was arrived at — so a jump in quantity is
never unexplained.

## Reading the scale automatically

If your scale is connected to **Home Assistant**, Gubbins can read it directly instead of you
reading the display and typing the figure in. The dialog then shows a **scale picker** and a
**Read the scale** button; the current reading drops straight into **Weight on scale**, and
everything after that works exactly as it does for a typed figure.

There is a second button, **Read the container**, which does the same thing for the tare: put the
empty tray on the scale, press it, and its weight lands in **Container weight**. Weigh the empty
tray, then tip the parts in and press **Read the scale** — neither figure has to be typed.

This is entirely optional, and typing the reading in yourself always works — nothing here is a
prerequisite for counting by weight.

**What you need:**

1. The optional **[[bridge|Bridge-Overview]]** running, with its URL and access token filled in
   under **Settings → Sync**, and
2. the bridge configured to read Home Assistant, and pointed at your instance.

See **[[Home Assistant integration|Home-Assistant-Integration]]** for setting that up. Once it is
running, any Home Assistant entity that reports a weight appears in the picker; choose yours once
and Gubbins remembers it on that device.

> **💡 Tip**
> The choice of scale is remembered **per device**, so a tablet in the workshop and a phone in the
> stockroom can each read their own bench scale.

The list of scales is fetched once and then kept for the rest of your session, so opening the
dialog for item after item doesn't re-ask Home Assistant each time. If you have **just** added a
scale in Home Assistant and it isn't in the picker yet, use the **refresh** button beside the
picker to fetch the list again — no page reload needed.

Gubbins converts the reading into your chosen weight unit for you, so a sensor reporting
kilograms works fine even if you read everything in grams.

> **⚠️ Heads-up**
> If the sensor reports a unit Gubbins can't convert, it says so rather than guessing — a
> misread unit could be out by a factor of a thousand and would quietly wreck your stock figure.
> The same applies if the scale is switched off or unreachable: you get a plain explanation
> instead of a reading. You can always type the weight in by hand instead.

## How much to trust the number

A scale reading is never perfectly exact, so Gubbins tells you how well the reading lines up with
a whole number of units rather than quietly rounding:

- **Nothing said** — the reading landed on a whole number of units. Good count.
- **Slightly off** — the count is almost certainly right, but something is drifting a little.
- **Doesn't line up** — the reading sits well away from any whole number of units.

> **⚠️ Heads-up**
> A reading that doesn't line up usually means one of three things: the container weight is wrong,
> the recorded unit weight is wrong, or something that isn't one of these parts is on the scale.
> Gubbins still lets you apply the count — you may know your scale is imprecise — but it's worth
> checking first.

Accuracy depends on the ratio between your scale's resolution and the unit weight. A scale that
reads to `1 g` cannot reliably count `0.5 g` screws one at a time, but weighing a larger handful
averages the error out — the more units on the scale, the tighter the count.

## Where it applies

Counting by weight is offered on items using **[[bulk tracking|Tracking-Modes]]** with a finite
quantity — the countable, interchangeable units the technique makes sense for. Serialised assets
are tracked individually rather than counted, and
[[consumable gauges|Low-Stock-and-Gauges]] have their own weigh-in that measures how much is
*left* rather than how many there are.

## Related pages

- **[[Container weights|Container-Weights]]** — saving the empty weight of trays, jars and spools.
- **[[Items]]** — where a unit weight is recorded.
- **[[Tracking modes|Tracking-Modes]]** — which items can be counted by weight.
- **[[Low stock & gauges|Low-Stock-and-Gauges]]** — weighing a consumable to gauge what's left.
- **[[Cycle counts & audit day|Cycle-Counts-and-Audit-Day]]** — reconciling stock across a whole
  location.
- **[[Activity log|Activity-Log]]** — where an applied count is recorded.
- **[[Home Assistant integration|Home-Assistant-Integration]]** — connecting a scale so Gubbins can
  read it.
