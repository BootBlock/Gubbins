/**
 * Translate-only-while-default description for the two built-in accounts (issue #430).
 *
 * System and Admin are seeded rows, not static copy — `users.description` is a real, persisted
 * column — but neither can be edited through the UI (the edit button is hidden for a built-in
 * account, and `trg_users_protect_system_update` refuses any update to System at the schema
 * layer regardless). So unlike a built-in role's name/description (`builtin-role-labels.ts`),
 * there is no fold-back half to this seam: nothing ever writes a translated string back over
 * the stored English default.
 *
 * The read half is the same idea though — a still-default description renders from the catalog
 * so it appears in the active language; the moment the stored value differs from the shipped
 * default (an import, a restore, a future edit path), the stored value wins verbatim.
 */
import type { MessageKey } from '@/features/i18n';
import {
  ADMIN_USER_DESCRIPTION,
  ADMIN_USER_ID,
  SYSTEM_USER_DESCRIPTION,
  SYSTEM_USER_ID,
} from '@/db/repositories/constants';

const BUILTIN_USER_SLUGS: Readonly<Record<string, string>> = {
  [SYSTEM_USER_ID]: 'system',
  [ADMIN_USER_ID]: 'admin',
};

/** The shipped English default for a built-in account id, or `undefined` for an ordinary one. */
function builtinDefaultDescription(id: string): string | undefined {
  if (id === SYSTEM_USER_ID) return SYSTEM_USER_DESCRIPTION;
  if (id === ADMIN_USER_ID) return ADMIN_USER_DESCRIPTION;
  return undefined;
}

/** The catalog key holding a built-in account's shipped English description. */
export function builtinUserDescriptionKey(id: string): MessageKey {
  return `users.builtin.${BUILTIN_USER_SLUGS[id]}.description` as MessageKey;
}

/** The minimum shape this seam needs — anything carrying a user's identity and stored text. */
export interface UserTextSource {
  readonly id: string;
  readonly description: string | null;
}

/**
 * A user's description in the active language — the stored value for an ordinary account
 * (`null` if they haven't set one), or the translated shipped default for System/Admin while it
 * hasn't diverged from what the baseline seeded.
 */
export function builtinUserDescription(
  user: UserTextSource,
  translate: (key: MessageKey) => string,
): string | null {
  const def = builtinDefaultDescription(user.id);
  if (def === undefined || user.description !== def) return user.description;
  return translate(builtinUserDescriptionKey(user.id));
}
