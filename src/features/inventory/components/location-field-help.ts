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

export const HINT_DEFAULT =
  'Pre-select this location when adding a new item, so your most-used spot is one click away. ' +
  'Only **one** location can be the default; choosing this clears it from any other.';
