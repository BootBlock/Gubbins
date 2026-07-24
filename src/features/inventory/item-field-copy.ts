/**
 * Shared field copy for an item's core identity fields — the guidance a user reads when
 * adding an item must match what they read when editing it later, so it lives here rather
 * than being copied into each dialog.
 *
 * The gauge fields keep their own copy in `gauge-field-copy.ts`; this is the general-item
 * counterpart.
 */

/**
 * InfoHint copy for an item's **Name** field (issue #413). Answers the recurring question —
 * where does the maker go? — by pointing at the dedicated **Manufacturer** / **MPN** fields
 * rather than the name, and steers towards specific, consistent names so similar things sort
 * together.
 */
export const ITEM_NAME_HINT =
  'The item’s display name — how it appears in lists, search and on labels.\n\n' +
  'Name it by **what it is**, specifically and consistently, so similar things sort ' +
  'together:\n\n' +
  '| Prefer | Avoid |\n' +
  '| --- | --- |\n' +
  '| `M3 × 10 socket screws` | `screws` |\n' +
  '| `Q27 monitor` | `thing from the shop` |\n\n' +
  '> The **maker** has its own **Manufacturer** field and part codes go in **MPN**, so you ' +
  'needn’t repeat them here. Leading with the brand (*ASUS Q27 monitor*) is fine when it’s ' +
  'how you’d recognise it — just stay consistent.';

/**
 * The name hint as shown when *editing* — the same guidance plus the one note only an edit
 * raises: a rename is recorded in the activity log (the editor logs a `RENAMED` history entry).
 */
export const ITEM_NAME_EDIT_HINT = ITEM_NAME_HINT + '\n\nRenames are recorded in the activity log.';
