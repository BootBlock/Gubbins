/**
 * Display-copy keys for a permission (issue #79 §2.3, extended for issue #429).
 *
 * Copy is keyed by *subject* and *action* rather than one key per permission key: the role
 * editor's grid is subject-rows × action-columns, so a handful of catalog entries cover every
 * key, and a new action reuses the label a sibling subject already has.
 *
 * Kept in its own module because two surfaces need it — the role editor's grid, and the
 * "you don't have permission" interstitial, which names the permission a screen wanted.
 *
 * Every key here is built by interpolation and cast, which the type system cannot follow into
 * `en.json`. `permission-labels.test.ts` closes that by asserting the catalog holds a label
 * *and* a help entry for every subject, action and slot the registry declares — so adding a
 * subject without its copy fails the build rather than rendering the raw key on screen.
 */
import type { MessageKey } from '@/features/i18n';
import {
  splitGrant,
  type PermissionAction,
  type PermissionActionSlot,
  type PermissionKey,
  type PermissionSubject,
} from './permission-registry';

/** A subject's display label key. Generated per subject so the grid needs no hand-written list. */
export function subjectLabelKey(subject: PermissionSubject): MessageKey {
  return `users.subject.${subject}` as MessageKey;
}

/**
 * A subject's rich-Markdown help, shown in the role editor's `InfoHint` badge (issue #429).
 *
 * Separate from the label because the two are read at different moments and at very different
 * lengths: the label names the row at a glance, the help explains what withholding each of that
 * row's actions actually stops someone doing.
 */
export function subjectHelpKey(subject: PermissionSubject): MessageKey {
  return `users.subject.${subject}.help` as MessageKey;
}

/** An action's display label key, shared across every subject that supports that action. */
export function actionLabelKey(action: PermissionAction): MessageKey {
  return `users.action.${action}` as MessageKey;
}

/** A column heading's label key — what the grid writes above the slot. */
export function slotLabelKey(slot: PermissionActionSlot): MessageKey {
  return `users.slot.${slot}` as MessageKey;
}

/** A column heading's rich-Markdown help: what View, Change and Delete mean across the app. */
export function slotHelpKey(slot: PermissionActionSlot): MessageKey {
  return `users.slot.${slot}.help` as MessageKey;
}

/** The subject and action label keys for one permission key, in that order. */
export function permissionLabelKeys(key: PermissionKey): readonly [subject: MessageKey, action: MessageKey] {
  const [subject, action] = splitGrant(key);
  return [subjectLabelKey(subject as PermissionSubject), actionLabelKey(action as PermissionAction)];
}
