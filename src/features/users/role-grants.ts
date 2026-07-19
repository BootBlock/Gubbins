/**
 * Pure maths for the role editor (issue #79, plan §2.3, phase 4).
 *
 * Editing a role means editing **grants**, which are wider than the permission keys a checkbox
 * grid can express: a role may hold the global wildcard `*`, a subject wildcard `items:*`, or a
 * grant this build has never heard of (synced from a newer peer). A naive "read the boxes, write
 * the keys" editor would silently destroy all three, so the conversion between grants and a grid
 * lives here, separately and exhaustively tested, rather than inside a dialog.
 *
 * The rules it implements:
 *
 * - **`*` is a mode, not a row.** A role holding it grants everything including capabilities
 *   added by a later release, which no set of ticked boxes can represent. The editor offers it
 *   as its own switch; while it is on the grid is disabled, because showing every box ticked
 *   would imply that un-ticking one is possible without changing what the role fundamentally is.
 * - **A subject wildcard survives until the row is touched.** `items:*` renders as "every
 *   action, including future ones" with its boxes ticked. Changing any box in that row is an
 *   explicit act, and converts the row to the exact keys now shown — the user can see precisely
 *   what they are choosing.
 * - **Unrecognised grants are carried through untouched.** They are invisible to the grid (they
 *   match no subject this build knows) and are re-emitted on save, so editing a role on an older
 *   device cannot strip what a newer one granted.
 */
import {
  GRANT_ALL,
  isPermissionGrant,
  PERMISSION_SUBJECT_IDS,
  permissionKeysFor,
  splitGrant,
  type PermissionKey,
  type PermissionSubject,
} from './permission-registry';

/** How one subject's row is currently granted. */
export type SubjectRowMode =
  /** Explicit per-action keys — the ordinary case; `keys` is what is ticked. */
  | { readonly mode: 'explicit'; readonly keys: ReadonlySet<PermissionKey> }
  /** A `<subject>:*` wildcard: every action, including ones added later. */
  | { readonly mode: 'wildcard' };

/** The grid the editor renders, plus everything it must preserve but cannot show. */
export interface RoleGrantModel {
  /** True when the role holds the global `*`. The grid is inert while this is set. */
  readonly grantsEverything: boolean;
  /** Per-subject state, for every subject in registry order. */
  readonly subjects: ReadonlyMap<PermissionSubject, SubjectRowMode>;
  /**
   * Grants this build does not recognise, preserved verbatim so a round-trip through an older
   * device does not strip permissions a newer one granted.
   */
  readonly unknown: readonly string[];
}

/** An empty row set — every subject explicit, nothing ticked. */
function emptySubjects(): Map<PermissionSubject, SubjectRowMode> {
  return new Map(PERMISSION_SUBJECT_IDS.map((id) => [id, { mode: 'explicit', keys: new Set() }] as const));
}

/** Parse stored grants into the editor's model. */
export function toGrantModel(grants: readonly string[]): RoleGrantModel {
  const subjects = emptySubjects();
  const unknown: string[] = [];
  let grantsEverything = false;

  for (const grant of grants) {
    if (grant === GRANT_ALL) {
      grantsEverything = true;
      continue;
    }
    if (!isPermissionGrant(grant)) {
      unknown.push(grant);
      continue;
    }
    const [subject, action] = splitGrant(grant);
    const id = subject as PermissionSubject;
    if (action === '*') {
      subjects.set(id, { mode: 'wildcard' });
      continue;
    }
    const row = subjects.get(id);
    // A subject already known to be wildcarded stays that way: `items:*` plus `items:read` is
    // still "every action", and narrowing it to the one explicit key would lose permissions.
    if (row?.mode !== 'explicit') continue;
    subjects.set(id, { mode: 'explicit', keys: new Set([...row.keys, grant as PermissionKey]) });
  }

  return { grantsEverything, subjects, unknown };
}

/** Serialise the editor's model back to storable grants. */
export function fromGrantModel(model: RoleGrantModel): readonly string[] {
  // The global wildcard subsumes every row, so emitting the rows alongside it would store
  // redundant grants that re-appear as ticked boxes if the switch is later turned off — making
  // "grants everything" look like it silently authored a specific permission set.
  if (model.grantsEverything) return [GRANT_ALL, ...model.unknown];

  const grants: string[] = [];
  for (const subject of PERMISSION_SUBJECT_IDS) {
    const row = model.subjects.get(subject);
    if (!row) continue;
    if (row.mode === 'wildcard') {
      grants.push(`${subject}:*`);
      continue;
    }
    for (const key of permissionKeysFor(subject)) {
      if (row.keys.has(key)) grants.push(key);
    }
  }
  return [...grants, ...model.unknown];
}

/** Whether a given key reads as ticked in the grid. */
export function isKeyTicked(model: RoleGrantModel, key: PermissionKey): boolean {
  if (model.grantsEverything) return true;
  const [subject] = splitGrant(key);
  const row = model.subjects.get(subject as PermissionSubject);
  if (!row) return false;
  return row.mode === 'wildcard' || row.keys.has(key);
}

/**
 * Tick or un-tick one key.
 *
 * Touching a wildcarded row converts it to the exact keys currently shown, then applies the
 * change — so the row means what the boxes say from that point on. This is why the conversion is
 * driven by a deliberate click rather than happening on load.
 */
export function toggleKey(model: RoleGrantModel, key: PermissionKey, ticked: boolean): RoleGrantModel {
  const [subject] = splitGrant(key);
  const id = subject as PermissionSubject;
  const row = model.subjects.get(id);
  if (!row) return model;

  const current = row.mode === 'wildcard' ? new Set(permissionKeysFor(id)) : new Set(row.keys);
  if (ticked) current.add(key);
  else current.delete(key);

  const subjects = new Map(model.subjects);
  subjects.set(id, { mode: 'explicit', keys: current });
  return { ...model, subjects };
}

/** Tick or un-tick every action on one subject at once (the row's select-all control). */
export function toggleSubject(
  model: RoleGrantModel,
  subject: PermissionSubject,
  ticked: boolean,
): RoleGrantModel {
  const subjects = new Map(model.subjects);
  subjects.set(subject, {
    mode: 'explicit',
    keys: ticked ? new Set(permissionKeysFor(subject)) : new Set(),
  });
  return { ...model, subjects };
}

/** Turn the global wildcard on or off, leaving the grid's rows untouched underneath. */
export function setGrantsEverything(model: RoleGrantModel, grantsEverything: boolean): RoleGrantModel {
  return { ...model, grantsEverything };
}
