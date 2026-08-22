/**
 * Display-copy keys for a permission (issue #79 §2.3).
 *
 * Copy is keyed by *subject* and *action* rather than one key per permission key: the role
 * editor's grid is subject-rows × action-columns, so ~25 catalog entries cover ~43 keys, and a
 * new action reuses the label a sibling subject already has.
 *
 * Kept in its own module because two surfaces need it — the role editor's grid, and the
 * "you don't have permission" interstitial, which names the permission a screen wanted.
 */
import type { MessageKey } from '@/features/i18n';
import { splitGrant, type PermissionKey, type PermissionSubject } from './permission-registry';

/** A subject's display label key. Generated per subject so the grid needs no hand-written list. */
export function subjectLabelKey(subject: PermissionSubject): MessageKey {
  return `users.subject.${subject}` as MessageKey;
}

/** An action's display label key, shared across every subject that supports that action. */
export function actionLabelKey(action: string): MessageKey {
  return `users.action.${action}` as MessageKey;
}

/** The subject and action label keys for one permission key, in that order. */
export function permissionLabelKeys(key: PermissionKey): readonly [subject: MessageKey, action: MessageKey] {
  const [subject, action] = splitGrant(key);
  return [subjectLabelKey(subject as PermissionSubject), actionLabelKey(action)];
}
