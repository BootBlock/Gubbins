# Users & ACLs — implementation plan

> **Status:** 🟢 ACTIVE — phases 1 (schema, built-in users, attribution), 2 (permission engine),
> 3 (authentication & session) and 4 (module, gating & admin UI) shipped; phase 5 (Bridge tokens)
> next.

Gubbins has no concept of a user. Every action is anonymous, `item_history` records *what*
happened but never *who*, and the Bridge authenticates with a single all-or-nothing bearer
token. This plan introduces users, roles and permissions as a first-class, **optional** feature —
the app keeps working exactly as it does today unless the operator turns the module on.

Tracked by [issue #79](https://github.com/BootBlock/Gubbins/issues/79).

## 1. Scope decisions

These were settled before design and are the constraints everything below hangs off.

### 1.1 Authentication is a soft boundary, not a cryptographic one

Gubbins is a backend-less local PWA: the SQLite database lives on the device and is readable by
anyone who has that device. A password therefore **cannot** protect the data at rest, and this
plan does not pretend otherwise.

- Passwords are hashed (PBKDF2-HMAC-SHA-256 via WebCrypto, per-user random salt, iteration count
  stored alongside so it can be raised later) and verified at sign-in.
- Sign-in gates **the UI and the permission engine**. It attributes actions to a person and stops
  a household member wandering into the audit log. It is not a defence against an adversary with
  the device.
- **A user may have no password at all.** This is legitimate for a shared family device where the
  point is attribution, not secrecy. Where a user has no password the UI must say so plainly —
  a warning on the user's row in the admin list, and on the sign-in tile.
- The wiki must state this limitation in the user's own terms. Overstating the protection would be
  worse than offering none.

Deliberately **not** doing: encryption at rest. It would make a lost password mean permanent data
loss, and would require the key to reach sync and the Bridge. That is a separate project, not a
sub-task of this one.

### 1.2 Permissions are role- and entity-type-based

The issue asks for "a set of read/write permissions" per object. Per-**object** ACL rows
(an `acl` table joined into every list and search query) were rejected: the cost lands on every
query in the app and the management UI for per-record grants is large, while none of the issue's
own examples need it.

Instead permissions are granted per **entity type** and per **capability**, and grouped into
**roles**. This covers every case the issue names, including "only specific users can view audit
history". The schema is shaped so per-object overrides *could* be layered on later without a
redesign, but they are not in scope.

### 1.3 The Bridge gets per-user API tokens

`GUBBINS_BRIDGE_TOKEN` is replaced by tokens minted per user in the app. The Bridge resolves a
presented token to a user, enforces that user's permissions on every route, and attributes writes
to them. The existing env capability flags remain as an outer bound — a flag that is off stays off
regardless of who is calling.

### 1.4 No backwards compatibility

Confirmed with the maintainer: nothing is preserved. The schema change folds into the
`v1-initial` baseline (per the squashed-baseline convention), the snapshot fixture is regenerated,
and existing development databases are refused at boot with `SCHEMA_STALE` and reset. There is no
incremental migration, no shim, and no compatibility path for the old Bridge token.

## 2. Data model

All new tables carry `id TEXT PRIMARY KEY` + `updated_at` with the standard auto-stamp trigger,
so they take part in LWW sync.

### 2.1 `users`

| Column | Notes |
| --- | --- |
| `id` | TEXT PK |
| `username` | UNIQUE, NOCASE — the sign-in handle |
| `display_name` | shown throughout the UI and in audit entries |
| `email` | optional |
| `password_hash`, `password_salt`, `password_iterations` | all NULL when the user has no password (§1.1) |
| `is_enabled` | 0 disables sign-in |
| `disabled_message` | optional text shown on a blocked sign-in attempt |
| `kind` | `'system'` / `'admin'` / `'normal'` — see §2.2 |
| `role_id` | FK → `roles`, NULL for `system`/`admin` (their permissions are implicit) |
| `created_at`, `updated_at` | |

Optional contact details (phone numbers, address, note) reuse the shape already established by
`contacts` rather than inventing a second one. A user is **not** a contact — a contact is a person
as *data* (a loan borrower), a user is a principal. They stay separate tables.

### 2.2 The two built-in users

A fresh install always has exactly two, created by the baseline, neither deletable nor disableable,
and neither having its permissions editable:

- **`System`** (`kind: 'system'`) — the actor for anything the app itself does: maintenance,
  pruning, sync reconciliation, imports run by a schedule. Never signs in; has no password and no
  sign-in tile.
- **`Admin`** (`kind: 'admin'`) — full access to everything, always. This is the user that
  single-user mode transparently acts as.

Enforcement is at the repository layer *and* by SQL trigger, not merely in the UI: a delete or a
disable targeting a `system`/`admin` row must ABORT, the same way `trg_item_history_immutable`
protects history. A permission check that only exists in a React component is not a check.

### 2.3 `roles` and permissions

`roles`: `id`, `name`, `description`, `is_builtin`, `permissions` (JSON array of permission keys),
`created_at`, `updated_at`.

A permission key is `"<subject>:<action>"`, drawn from a closed union in a new
`src/features/users/permission-registry.ts` — the SSOT, in the same spirit as `feature-registry.ts`.
Subjects are entity types (`items`, `locations`, `projects`, `contacts`, `suppliers`,
`purchase-orders`, `bookings`, …) and cross-cutting capabilities (`audit`, `settings`, `users`,
`backup`, `sync`, `bridge`). Actions are `read`, `write`, `delete`, plus subject-specific ones
where genuinely needed (`audit:view`, `users:manage`).

Built-in roles ship as a starting point and are editable except where noted:
**Administrator** (all), **Manager** (everything bar `users:manage`), **Stocker**
(items/locations read+write, no delete, no audit), **Viewer** (read-only, no audit).

### 2.4 Actor attribution

`item_history` gains `actor_user_id` (FK → `users`, never NULL). Every other append-only or
audit-bearing table gains the same column. Because a column added to an already-synced table needs
no sync registration, this is cheap.

The critical part is that attribution is **not optional at the call site**. The write path in
`src/db/repositories/item/history.ts` must require an actor argument, so a caller that forgets one
fails to compile rather than silently writing `System`. Callers that genuinely have no user
(maintenance, migration, sync reconciliation) pass the System user explicitly.

## 3. Single-user mode

The `users` module is **off by default**, and with it off Gubbins behaves exactly as it does today.

- With the module off: no sign-in screen, no user UI, no permission checks fail. Every action is
  performed as `Admin`, and history records `Admin` as the actor. The user never sees the concept.
- With the module on: sign-in is required, permissions are enforced, and the user admin screen
  appears.
- **Turning the module off again must not lock anyone out or lose data.** Users, roles and
  historical attribution all persist; the app simply stops enforcing and reverts to acting as
  `Admin`. This is the behaviour to test hardest — a one-way door here would be a data-loss bug.

The module registers in `feature-registry.ts` as `users` (`kind: 'page'`, `group: 'core'`) with a
`/users` route behind `ModuleGuard`, and a `NAV_DESTINATIONS` entry gated on the same id.

## 4. Phases

Each phase lands on `main` on its own — implemented, verified, reviewed and merged — rather than
as one enormous diff.

### Phase 1 — Schema, built-in users, attribution

Baseline tables (`users`, `roles`), the protective triggers, the two built-in users, `actor_user_id`
on `item_history` and friends, repository layer, sync registration (`SYNC_TABLES` order, `FK_REFS`,
`UNIQUE_KEY_SPECS` for `users.username`), regenerated schema snapshot. Threading the actor through
every history write is the bulk of the work. No UI. **Ships with the module still absent** — the
app runs as `Admin` throughout, so this phase is invisible to the user.

#### Phase 1 as built — decisions worth knowing before phase 2

Four things were settled during implementation that the design above did not pin down:

- **The actor reaches the ledger through a resolver, not through every method signature.**
  `historyStatement(itemId, action, actorUserId, fields?)` takes the actor as a *required*
  argument, so the compile-time guarantee §2.4 asks for holds at the ledger seam. Repository
  methods pass `this.actorId()`, backed by `RepositoryOptions.resolveActor` and wired once in
  `repositories/index.ts`. **Phase 3 changes that single arrow to a session lookup** and every
  write in the app follows; no public repository signature or call site needs to change.
  Callers with no user — sync reconciliation, the Bridge — pass `SYSTEM_USER_ID` explicitly.
- **`item_history.actor_user_id` is `NOT NULL … ON DELETE SET DEFAULT`, and the immutability
  trigger is scoped to the substantive columns.** Deleting a user must not delete or dangle
  their history, so SQLite re-points their entries at System itself — locally and through
  sync — with no extra statements. That requires the ledger's `BEFORE UPDATE` guard to name
  the columns it protects rather than the whole row; re-attributing an orphaned entry is not
  a rewrite of what happened.
- **The built-in users are excluded from the sync snapshot** (`TABLE_FILTER: users → WHERE
  kind = 'normal'`), exactly as the system-locked locations are. They are seeded with constant
  ids on every device and protected by triggers a remote UPSERT would trip. Consequently
  `reconcile` must add them back into the surviving-user set by hand, or every Admin-attributed
  row arriving from a peer is re-attributed to System.
- **Built-in *roles* are not seeded yet.** §2.3 lists Administrator/Manager/Stocker/Viewer, but
  their contents are permission keys, and the registry that defines those keys is phase 2. The
  `roles` table, its triggers and its repository exist; seeding the four ships alongside the
  registry so no guessed key is ever baked into the baseline.

### Phase 2 — Permission engine

`permission-registry.ts`, role resolution, the pure `can(user, permission)` seam and its tests,
plus repository-level enforcement. Pure and exhaustively unit-testable; no UI. The engine must be
side-effect-free and independent of React so the Bridge can import it too.

#### Phase 2 as built — decisions worth knowing before phase 3

- **`stock` is a subject in its own right, separate from `items`.** §2.3 listed subjects as
  entity types, but moving, adjusting, counting and writing off quantity is a different
  capability from editing an item record — and it is exactly the line the **Stocker** role
  exists to draw. It has no `delete`: stock is written down or written off, never deleted.
  Two other subjects departed from the uniform `read`/`write`/`delete` triple for the same
  "don't mint a key nothing can check" reason: `audit` is `view`/`delete` (the ledger is
  immutable, so there is no writing one), and `users` is `read`/`manage` (anyone who can edit
  an account can grant themselves a role, so a separate `users:delete` protects nothing).
- **Roles store *grants*, which may be wider than a key.** A stored grant is a key, a subject
  wildcard (`items:*`) or the global wildcard (`*`). **Administrator holds `*`** so that a
  role defined as "everything" still means everything after a later release adds a key —
  enumerating today's keys into the baseline would have quietly left it short. The other
  three enumerate deliberately, so a new capability does *not* silently reach a restricted
  role. A grant this build does not recognise is preserved on write and never matches on
  read, so editing a role on an older device cannot strip what a newer one granted.
- **Enforcement is `BaseRepository.assertPermission(key)`, wired through
  `RepositoryOptions.resolveAuthority`** — the same shape as `resolveActor`, and phase 3
  changes that one arrow to the session's authority. Production and every test fixture
  resolve to `UNRESTRICTED_AUTHORITY` today, so all guards are inert and single-user mode is
  untouched. **Writes are gated; reads are not** — gating every list and search query is a
  phase-4 concern that belongs with the UI that hides the screens.
- **The rule the keys follow:** `<entity>:delete` means deleting the *entity*. Editing an
  entity's child records — an attachment, capability, relation, BOM line, budget expense,
  category field, photo region — is `<entity>:write`. Without that rule the keys drift into
  "delete means any statement containing DELETE", which is not a permission a user can reason
  about.
- **The built-in roles are seeded by the baseline, which imports `builtin-roles.ts`** — the
  same module the app and the Bridge read, so a database's roles and the code's roles cannot
  drift. Their ids are constant UUIDs for the reason the built-in user ids are: four devices
  seeding random ids would produce four duplicate roles on first sync. Note this made three
  phase-1 tests collide on `roles.name` (they created roles called `Stocker`, `Viewer`,
  `Manager`); operator-defined test roles now use names no built-in takes.

### Phase 3 — Authentication & session

Password hashing helpers, sign-in screen, session store (who is signed in, persisted per device),
sign-out, disabled-user handling with `disabled_message`, and the no-password warning. Adds the
`gubbins:session` storage key to the registry.

#### Phase 3 as built — decisions worth knowing before phase 4

- **The built-in Admin can now take a password, and the trigger was narrowed to allow it.**
  §2.2 said Admin was immutable, which made the account single-user mode acts as the one
  account that could never be protected — with the module on, that is an unprotected
  full-access sign-in. `trg_users_protect_builtin_update` is therefore split in two:
  `trg_users_protect_system_update` (System, still wholly immutable — it is an actor, never a
  person) and `trg_users_protect_admin_update`, which names the columns it defends (`username`,
  `display_name`, `kind`, `role_id`, `is_enabled`) so the password triple can change and
  nothing else. Same move as the phase-1 ledger trigger. **This changed the baseline**, so the
  schema snapshot was re-captured and `schemaVersion` bumped.
- **Sign-in is a gate, not a route.** `SignInGate` wraps the router inside `BootGate`. A
  `/sign-in` route would be reachable by URL, leave the app mounted behind it and let the back
  button step past it. For the same reason the screen does **not** use `PageContainer` /
  `PageHeader`: those mount `AppNav` and the command palette, either of which walks around the
  gate. It uses the boot-screen shell instead.
- **The session stores an id and a display name — nothing else, and `partialize` enforces it.**
  A device can edit its own localStorage, so anything persisted is something it can award
  itself. The resolved `Authority` and actor id live in the same store but are **derived and
  in-memory only**; `authority-refresh.ts` recomputes them from the database. That is also why
  a restored session renders nothing until the first refresh resolves — otherwise the guards
  answer from the store's unrestricted default for a moment.
- **`resolveActor` / `resolveAuthority` now read the session store**, which is the single arrow
  phases 1–2 were built to leave swappable; no repository signature or call site changed. With
  the module off the store's defaults (Admin, unrestricted) are returned untouched, so shipped
  behaviour is identical.
- **`usersModuleEnabled()` returns `false` unconditionally** (`features/users/module.ts`).
  Phase 4 rewires that one function to the modules store. It is deliberately not registered in
  `feature-registry.ts` yet: turning enforcement on before there is any way to administer
  accounts would offer a door with no key cut for it.
- **A deleted account denies rather than falling back to Admin.** A session can outlive its
  user (deleted on another device, arriving by sync); resolving that to full access is the
  exact failure this feature exists to prevent. Attribution, by contrast, follows the person
  even when their authority denies everything — a disabled user's writes are still theirs.
- Signing in and out both invalidate the query cache. One user's data left resident for the
  next person to sign in is the obvious way this would leak.

### Phase 4 — Module, gating & admin UI

The `users` feature-registry entry, `/users` route, the admin screen (list, create, edit, enable/
disable, assign role), the roles editor, and per-screen/per-action gating driven by the phase-2
engine. This is the largest UI phase and the one where design-token and Foundry-primitive
discipline matters most.

#### Phase 4 as built — decisions worth knowing before phase 5

- **The feature registry gained `defaultOff`, and it is load-bearing.** `useModulesStore` reads a
  *missing* intent key as **on**, so simply registering `users` would have switched sign-in and
  permission enforcement on for every existing install the moment this shipped — the exact
  opposite of §3. A feature may now declare itself opt-in, in which case absence means off, the
  `everything` preset skips it (`PRESETABLE_FEATURE_IDS`), and "reset to everything" leaves it
  off. `users` is the first such module; a preset can still turn one *off*, which is the safe
  direction.
- **`usersModuleEnabled()` is `isFeatureEnabled('users')` and nothing else.** Components that must
  re-render on the toggle call `useFeature('users')` directly rather than a second hook-shaped
  copy of the question. `SignInGate` subscribes that way, so the gate goes up and comes down
  without a reload, and it refreshes the authority on the **off** transition too — skipping that
  would leave the previous restricted authority resident and make the toggle a one-way door.
- **The Users screen stays readable with the module off**, and says which mode you are in. The
  accounts and roles survive the toggle (§3), so hiding the screen would make the data look
  deleted; it also lets an operator set an account up *before* turning enforcement on.
- **Enabling is confirmed against a live check that some account can still sign in**; a failed or
  unfinished read blocks the confirm rather than assuming it is safe. The closure is computed
  first and carried through the dialog, so the confirmation does not opt out of the dependency
  cascade if `users` ever gains a `dependsOn`.
- **The sign-in screen carries an escape hatch** that switches the module off on this device.
  Without it the Modules manager — the only way back — sits behind the very gate a forgotten
  password closes. This weakens nothing that was ever true: §1.1 already states sign-in is a soft
  boundary, and the dialog says so plainly rather than implying otherwise. Confirmed with the
  maintainer before building.
- **A session whose account is deleted or disabled is dropped, not left stranded.** `no-role` and
  `no-permissions` deliberately do *not* end the session — they are states an administrator fixes
  by granting a role, and bouncing them to sign-in would simply loop.
- **Phase 3 shipped `useSignOut` with no caller.** Phase 4 adds the nav row, gated on the module
  and a live session. It is split into its own component so `useQueryClient` is only reached on
  the branch that renders — otherwise every consumer of `AppNav`, which `PageHeader` mounts on
  every screen, would need a `QueryClientProvider` even in single-user mode.
- **Role editing goes through the pure `role-grants.ts` seam.** A checkbox grid cannot express the
  global wildcard, a subject wildcard, or a grant a newer peer synced, and a naive "read the boxes,
  write the keys" editor destroys all three. A subject wildcard survives until its row is touched,
  at which point it converts to the exact keys shown — a deliberate act, not a silent one.
- **Permission copy is keyed by subject and action** (`users.subject.*`, `users.action.*`), not one
  key per permission key as §2.3 anticipated. The grid is subject-rows × action-columns, so ~25
  keys cover it instead of ~48, and a new action reuses the label a sibling subject already has.

### Phase 5 — Bridge

Per-user API tokens: minting and revocation in the app, resolution and permission enforcement in
the Bridge, write attribution, and the `bridge/README.md` permission matrix rewritten around
identities rather than a single token. `npm run smoke:bridge` is mandatory here — the Bridge's
strip-only loader forbids TS parameter properties and enums, which a new permission class could
easily reintroduce.

### Phase 6 — Wiki & i18n sweep

User-facing pages for users, roles, permissions and Bridge tokens, with generated screenshots
against synthetic data; the honest statement of what a password does and does not protect (§1.1);
and confirmation every string added across phases 1–5 exists in both `en.json` and `de.json`.

Strings are added via `t()` **in the phase that introduces them**, not deferred to phase 6 — the
catalog tests enforce full `de.json` coverage, so a deferred translation fails that phase's build.

## 5. Risks

- **Attribution threading is wide, not deep.** Phase 1 touches many call sites shallowly. Making
  the actor a required argument turns "did I miss one?" into a compile error, which is why it is
  specified that way rather than defaulting.
- **Turning the module off must be safe** (§3). Test it explicitly, both directions.
- **The Bridge's trust boundary shifts** in phase 5. Until then it keeps its shared token; the
  cutover must not leave a window where routes are unauthenticated.
- **A UI-only permission check is not a check.** Enforcement belongs at the repository layer, with
  the UI merely reflecting it.
- **Sync ordering.** `users` and `roles` must precede any table referencing them in `SYNC_TABLES`,
  or an UPSERT batch trips a foreign key.
