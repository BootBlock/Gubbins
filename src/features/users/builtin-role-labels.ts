/**
 * Translate-only-while-default labels for the built-in roles (issue #406).
 *
 * The four shipped roles are **persisted rows**, not static copy: they are seeded from
 * `builtin-roles.ts` and an operator may rename one or rewrite its description. That rules out
 * rendering them through `t()` unconditionally — doing so would silently overwrite a name someone
 * deliberately chose, in the display layer, with no way to get it back.
 *
 * So this seam translates *conditionally*: a built-in role's name (or description) renders from the
 * catalog only while the stored value still equals the English the baseline seeded. The moment it
 * differs, the stored value wins and stays won, in every language.
 *
 * Editing is the mirror image. The editor shows the translated text — an operator should edit what
 * they can read — so submitting an untouched form would otherwise persist the translation and
 * permanently detach the row from the catalog. {@link toStoredRoleText} folds that back: text that
 * still equals what the catalog offered is stored as the English default instead, leaving the row
 * translatable.
 *
 * `builtin-roles.ts` is deliberately *not* touched by any of this — its values are hashed into the
 * baseline fingerprint, so editing it would reset every existing database (see the warning there).
 */
import type { MessageKey } from '@/features/i18n';
import {
  ADMINISTRATOR_ROLE_ID,
  BUILTIN_ROLES,
  MANAGER_ROLE_ID,
  STOCKER_ROLE_ID,
  VIEWER_ROLE_ID,
  type BuiltinRoleDef,
} from './builtin-roles';

/**
 * Catalog slug per built-in role id. A readable slug rather than the UUID, so the catalogs stay
 * legible to a translator; declared here rather than in `builtin-roles.ts` for the reason above.
 */
const BUILTIN_ROLE_SLUGS: Readonly<Record<string, string>> = {
  [ADMINISTRATOR_ROLE_ID]: 'administrator',
  [MANAGER_ROLE_ID]: 'manager',
  [STOCKER_ROLE_ID]: 'stocker',
  [VIEWER_ROLE_ID]: 'viewer',
};

/** The minimum shape this seam needs — anything carrying a role's identity and its stored text. */
export interface RoleTextSource {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

/** Just the lookup half of a translator, so the pure seam never depends on React or options. */
export type TranslateKey = (key: MessageKey) => string;

/**
 * The shipped definition for a role id — and only when it also has a catalog slug. A fifth
 * built-in role added without one would otherwise render the raw key ("roles.builtin.undefined.name")
 * on screen; requiring both means it degrades to its stored English instead. The drift guard fails
 * the build in that case regardless, so this is the belt to that braces.
 */
function builtinDef(id: string): BuiltinRoleDef | undefined {
  if (!BUILTIN_ROLE_SLUGS[id]) return undefined;
  return BUILTIN_ROLES.find((role) => role.id === id);
}

/** The catalog key holding a built-in role's shipped English name (exported for the drift guard). */
export function builtinRoleNameKey(id: string): MessageKey {
  return `roles.builtin.${BUILTIN_ROLE_SLUGS[id]}.name` as MessageKey;
}

/** The catalog key holding a built-in role's shipped English description. */
export function builtinRoleDescriptionKey(id: string): MessageKey {
  return `roles.builtin.${BUILTIN_ROLE_SLUGS[id]}.description` as MessageKey;
}

/** A built-in role's name in the active language, or the stored name once it has been edited. */
export function builtinRoleName(role: RoleTextSource, translate: TranslateKey): string {
  const def = builtinDef(role.id);
  if (!def || role.name !== def.name) return role.name;
  return translate(builtinRoleNameKey(role.id));
}

/** As {@link builtinRoleName}, for the description. `null` stays `null` — an empty row shows none. */
export function builtinRoleDescription(role: RoleTextSource, translate: TranslateKey): string | null {
  const def = builtinDef(role.id);
  if (!def || role.description !== def.description) return role.description;
  return translate(builtinRoleDescriptionKey(role.id));
}

/** The name/description a role form submits, before {@link toStoredRoleText} folds it back. */
export interface RoleText {
  readonly name: string;
  readonly description: string | null;
}

/**
 * What to persist for a role the editor showed translated text for.
 *
 * Text still identical to what {@link builtinRoleName} / {@link builtinRoleDescription} offered is
 * stored as the shipped English, so an operator who opens a built-in role and saves it unchanged
 * leaves it translatable rather than pinning it to whichever language they happened to be using.
 * Anything genuinely edited is stored verbatim.
 */
export function toStoredRoleText(
  role: RoleTextSource | null,
  edited: RoleText,
  translate: TranslateKey,
): RoleText {
  if (!role) return edited;
  const def = builtinDef(role.id);
  if (!def) return edited;
  // Only a *still-default* field can fold back. A role already renamed to "Chief" renders and
  // submits as "Chief", and rewriting that to "Administrator" would undo the operator's rename.
  const nameIsDefault = role.name === def.name;
  const descriptionIsDefault = role.description === def.description;
  return {
    name: nameIsDefault && edited.name === translate(builtinRoleNameKey(role.id)) ? def.name : edited.name,
    description:
      descriptionIsDefault && edited.description === translate(builtinRoleDescriptionKey(role.id))
        ? def.description
        : edited.description,
  };
}
