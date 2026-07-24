/**
 * Shared Markdown help strings for the location fields, surfaced via the Foundry
 * `InfoHint` / `FormField hint` `i` badges in the Add and Edit location dialogs. Kept in
 * one place so both dialogs explain each field identically (no drift), and comprehensively
 * enough that a newcomer understands how Gubbins uses the value.
 */

export const HINT_NAME =
  "The location's display name — e.g. **Workshop**, **Cabinet A**, **Drawer 3**. It appears " +
  'throughout Gubbins: the location tree, item lists, pickers and printed labels. The text is ' +
  'tinted with the colour you pick below.';

/**
 * Name-field help for the **Add** dialog only — extends {@link HINT_NAME} with the nested-create
 * shortcut (path nesting + sibling fan-out), which applies when creating (the Edit dialog just
 * renames a single location).
 */
export const HINT_NAME_CREATE =
  HINT_NAME +
  '\n\nUse a **`/`** (or **`\\`**) to create several nested levels at once: typing ' +
  '**`Workshop/Cabinet A/Drawer 3`** makes *Drawer 3* inside *Cabinet A* inside *Workshop*. ' +
  'Any level that already exists is reused rather than duplicated, so only the missing ones are ' +
  'added.' +
  '\n\nUse a **comma** to add several locations side by side at the last level: ' +
  '**`Garage/Box 1, Box 2, Box 3`** makes *Box 1*, *Box 2* and *Box 3* as siblings inside ' +
  '*Garage*. They each take the type, colour and capacity you set below.' +
  '\n\nNeed a comma **in** a name? Type it twice — **`Bay 1,, 2`** creates a single location ' +
  'called *Bay 1, 2*.';

export const HINT_PARENT =
  'Nest this location inside another to build your storage hierarchy ' +
  '(Building → Room → Cabinet → Drawer). Leave as **Top level** for a root location. You can ' +
  "re-parent it later; a location can't be moved inside itself or one of its own children.";

export const HINT_DESCRIPTION =
  'An optional note about what lives here, for your own reference. It rides as a tooltip on the ' +
  'location in the tree and shows in its Edit panel.';

export const HINT_KIND =
  'The kind of place this is (Cabinet, Shelf, Drawer, Vehicle…). It sets the **icon** shown for ' +
  'this location in the tree and pickers, so you can recognise it at a glance. Optional — ' +
  'untyped locations use a plain folder.';

export const HINT_COLOUR =
  "An optional tint applied to this location's **name** everywhere it appears — the tree, " +
  'pickers and labels — so it stands out. Purely visual; it changes no behaviour.';

export const HINT_CAPACITY =
  'An optional limit on how many items this location should hold. When set, Gubbins shows a ' +
  '**fullness gauge** and warns you when you add an item to a full location. Leave blank for no ' +
  'limit.';

/**
 * Shared help for the internal-dimension fields (issue #457). One string covers all three
 * (width / height / depth) since they mean the same thing on each axis — the dialogs splice the
 * axis name in. Explains the mm-stored / display-unit-at-the-edges model the item editor uses.
 */
export const HINT_DIMENSIONS =
  "The location's **internal** width, height and depth — the usable space inside, in your chosen " +
  'dimension unit (change the unit in **Settings**). Enter all three and Gubbins works out the ' +
  '**volume** shown just below.\n\nSizes are stored independently of the unit, so switching units ' +
  'just re-displays the same measurements — nothing is converted or lost. Leave them blank if you ' +
  "don't measure this location.";

export const HINT_DEAD_STOCK_MODE =
  'Whether items stored here are flagged on the **Dead stock** report once they go unused ' +
  '— a handy way to watch a whole cupboard without setting each item individually.\n\n' +
  '- **Inherit** — follow the location above; if nothing above opts in, items here are not ' +
  'reported.\n' +
  '- **Report** — flag items stored here (and in its sub-locations) once they go unmoved.\n' +
  '- **Ignore** — never flag items here, even if a location above reports everything.\n\n' +
  'An individual item can always override this from its own **Dead-stock reporting** panel.';

export const HINT_DEAD_STOCK_DAYS =
  'How long items stored here must sit unmoved before they count as dead stock. Leave blank ' +
  'to use the value from the location above, or the global default in **Settings → Reports**.\n\n' +
  'Useful when one place keeps different time to the rest: deep storage might only be worth ' +
  'flagging after a year, while a workbench goes stale in a month.';

export const HINT_DEFAULT =
  'Pre-select this location when adding a new item, so your most-used spot is one click away. ' +
  'Only **one** location can be the default; choosing this clears it from any other.';
