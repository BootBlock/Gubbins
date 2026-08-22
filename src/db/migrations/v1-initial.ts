import {
  ADMIN_USER_DESCRIPTION,
  ADMIN_USER_DISPLAY_NAME,
  ADMIN_USER_ID,
  ADMIN_USER_USERNAME,
  ATTACHMENT_KINDS,
  CONDITIONS,
  COSTING_MODES,
  DEAD_STOCK_MODES,
  FIELD_DUE_LEAD_DAYS_MAX,
  FIELD_DUE_LEAD_DAYS_MIN,
  FIELD_NUMBER_BOUND_LIMIT,
  FIELD_PRECISION_MAX,
  FIELD_PRECISION_MIN,
  FIELD_TYPES,
  FIELD_UNIT_MAX_LENGTH,
  FIELD_VALUE_MODES,
  IN_TRANSIT_LOCATION_ID,
  IN_TRANSIT_LOCATION_NAME,
  MAINTENANCE_BASES,
  PRICE_HISTORY_SOURCES,
  PROCUREMENT_STATUSES,
  PROJECT_STATUSES,
  PURCHASE_ORDER_STATUSES,
  REGION_SHAPES,
  RESERVATION_STATUSES,
  SYSTEM_USER_DESCRIPTION,
  SYSTEM_USER_DISPLAY_NAME,
  SYSTEM_USER_ID,
  SYSTEM_USER_USERNAME,
  TRACKING_MODES,
  UNASSIGNED_LOCATION_ID,
  UNASSIGNED_LOCATION_NAME,
  USER_KINDS,
  WEBHOOK_METHODS,
} from '../repositories/constants';
import { BUILTIN_ROLES } from '@/features/users/builtin-roles';
import { normaliseGrants } from '@/features/users/permissions';
import { TEXT_LIMITS } from '@/lib/text-limits';
import type { SqlStatement } from '../rpc/driver';
import { BASELINE_REVISION_KEY, SQL_NOW_MS, baselineFingerprint, type Migration } from './migration';

/**
 * v1 — Consolidated baseline schema (the sole migration).
 *
 * This single migration builds the **entire current schema** in one step. Gubbins is
 * pre-release with disposable developer-only data, so it carries no incremental upgrade
 * path from any older on-disk version: every historical migration — the original v1…v24
 * chain and the later forward steps v2 (`idx_items_warranty`), v3
 * (`idx_items_active_location`), v4 (`revaluations` + `items.current_value`, G9), v5
 * (`item_relations`, G6), v6 (`wishlist`, G8) and v7 (`test_records`, G7) — is folded into
 * this one baseline, so a fresh install builds the whole schema here and the target schema
 * version is simply 1. A database left ahead of v1 (e.g. a pre-squash install stranded on a
 * former forward chain) exceeds the target and is refused at boot with `SCHEMA_TOO_NEW`,
 * whose rescue screen offers the local-data reset. The migration *engine*
 * (`runMigrations`/`getUserVersion`/the strict-contiguity guard) and all its sync wiring
 * (`SYNC_TABLES`, `FK_REFS`) are unchanged.
 *
 * ## Zero schema drift — a hard contract
 * The folded forward-step statements (marked "Folded former vN" below) are re-issued
 * verbatim at the tail — purely additive indexes, columns and child tables — so the
 * resulting schema is byte-for-byte identical to what the former chain produced, only now
 * reached in one step at `user_version = 1`. ALTER-added columns are re-issued as ALTERs in
 * their original positions (SQLite stores such columns verbatim at the tail of the table's
 * stored `sql`). The `v1-initial.test.ts` golden-equivalence test locks the result against
 * the committed `__fixtures__/schema-baseline.snapshot.json`, so any *unintended* schema
 * change still fails loudly.
 *
 * The per-phase grouping is preserved as authored: tables come before the
 * children that reference them, triggers after their tables, the FTS index after its
 * `items` content table, and the recompute triggers after their ledgers — the
 * dependency order the chain already ran in. The `SQL_NOW_MS` epoch expression, the
 * `updatedAtTrigger()` helper, and the CHECK-list constants (`FIELD_TYPES`,
 * `ATTACHMENT_KINDS`, …) are reused exactly as the originals did, so the enum CHECKs
 * stay in lock-step with the application constants.
 *
 * Trigger semantics: on UPDATE the auto-stamp trigger stamps `updated_at` **only when the
 * caller left it unchanged**. An UPDATE that sets `updated_at` explicitly (as the §7.3 sync
 * engine does, applying a remote Last-Write-Wins value) is passed through untouched — exactly
 * the behaviour LWW reconciliation needs. The stamp is `MAX(now, OLD.updated_at + 1)` so an
 * edit is always strictly newer than the row it derived from even when the wall clock is too
 * coarse to show it — but the `+ 1` future-ratchet is bounded so a stamp left implausibly far
 * ahead by a since-corrected clock is re-based rather than inflated forever (issue #393) — see
 * {@link updatedAtTrigger}. Every syncable table now uses that one helper (the six that formerly
 * inlined an identical trigger were folded onto it), so the monotonic guarantee can never again
 * be applied to some tables and missed on others.
 */

/**
 * The gap, in ms, past which a stored `updated_at` sitting *ahead* of `now` is treated as clock
 * inflation to re-base rather than a value to preserve (issue #393).
 *
 * Nothing honest stamps a row this far into the future. The `+ 1` ratchet below exists to bridge
 * causes measured in milliseconds to a couple of seconds — clock coarseness (~15.6ms on Windows),
 * OS scheduler/suspend jitter, an NTP step correction, sync round-trip measurement error. A gap of
 * *minutes* has only one cause: a device whose clock was fast stamped the row that far ahead, and
 * the skew has since been corrected. Five minutes sits ~two orders of magnitude above the largest
 * honest cause, so it never re-bases a legitimately-recent row, while catching the inflation this
 * threshold exists to unstick.
 */
const FUTURE_STAMP_REBASE_MS = 5 * 60 * 1000;

/**
 * Build the canonical auto-stamp trigger for a syncable table keyed by `id` (§7.1).
 *
 * `MAX(now, OLD.updated_at + 1)` — never merely `now` — because the wall clock is too coarse
 * to order an edit against the row it edited. `unixepoch('now','subsec')` reports milliseconds,
 * but the underlying system clock ticks far more slowly (~15.6ms on Windows), so an edit made
 * shortly after the row was written or pulled reads back the *same* millisecond. That makes the
 * edit invisible to §7.3 Last-Write-Wins, which resolves an equal-timestamp pair in favour of
 * the remote — silently discarding the edit on the very next sync. Forcing the stamp strictly
 * past `OLD.updated_at` keeps an edit provably newer than what it derived from, whatever the
 * clock's resolution, so causality survives even when wall time cannot express it.
 *
 * The ratchet is one-directional, though, so on its own it can never recover from a clock that was
 * *wrong* and then corrected (issue #393): a device a week fast stamps rows a week ahead, and once
 * the system clock is fixed `now` stays far below those stamps, so every later edit takes the
 * `OLD.updated_at + 1` branch and the row drifts 1ms further into the future forever — winning LWW
 * against every other device's genuinely-newer edit indefinitely. So the ratchet is *bounded*: when
 * `OLD.updated_at` is more than {@link FUTURE_STAMP_REBASE_MS} ahead of `now` the stamp is re-based
 * straight onto `now`, un-inflating the row. That gap is far larger than any coarseness the ratchet
 * bridges (ms–seconds) and far smaller than a skew worth correcting (minutes+), so the two cases
 * never overlap: a same-millisecond edit still ratchets, an inflated stamp is brought back to real
 * time. (Both branches read `unixepoch('now')`, which SQLite evaluates once per statement, so the
 * comparison and the value it re-bases to are the same instant.)
 */
function updatedAtTrigger(table: string): string {
  return `
    CREATE TRIGGER trg_${table}_updated_at
    AFTER UPDATE ON ${table}
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE ${table} SET updated_at = CASE
        WHEN OLD.updated_at - (${SQL_NOW_MS}) > ${FUTURE_STAMP_REBASE_MS} THEN (${SQL_NOW_MS})
        ELSE MAX((${SQL_NOW_MS}), OLD.updated_at + 1)
      END WHERE id = NEW.id;
    END;
  `;
}

// Enum CHECK lists, derived from the shared application constants so a constant edit
// can never drift from the schema's CHECK constraint.
const trackingModeList = TRACKING_MODES.map((mode) => `'${mode}'`).join(', ');
const fieldTypeList = FIELD_TYPES.map((t) => `'${t}'`).join(', ');
const deadStockModeList = DEAD_STOCK_MODES.map((m) => `'${m}'`).join(', ');
const attachmentKindList = ATTACHMENT_KINDS.map((k) => `'${k}'`).join(', ');
const projectStatusList = PROJECT_STATUSES.map((s) => `'${s}'`).join(', ');
const costingModeList = COSTING_MODES.map((m) => `'${m}'`).join(', ');
const reservationStatusList = RESERVATION_STATUSES.map((s) => `'${s}'`).join(', ');
const procurementStatusList = PROCUREMENT_STATUSES.map((s) => `'${s}'`).join(', ');
const conditionList = CONDITIONS.map((c) => `'${c}'`).join(', ');
const basisList = MAINTENANCE_BASES.map((b) => `'${b}'`).join(', ');
const regionShapeList = REGION_SHAPES.map((s) => `'${s}'`).join(', ');
const userKindList = USER_KINDS.map((k) => `'${k}'`).join(', ');
const webhookMethodList = WEBHOOK_METHODS.map((m) => `'${m}'`).join(', ');
const purchaseOrderStatusList = PURCHASE_ORDER_STATUSES.map((s) => `'${s}'`).join(', ');
const priceHistorySourceList = PRICE_HISTORY_SOURCES.map((s) => `'${s}'`).join(', ');
const fieldValueModeList = FIELD_VALUE_MODES.map((m) => `'${m}'`).join(', ');

/**
 * A ceiling on how long one text column's value may be (issue #346), in the code points
 * SQLite's `length()` counts — the same unit the {@link TEXT_LIMITS} tiers are written in, so a
 * control that reports a name as too long and the column that would have stored it agree about
 * an emoji or an astral-plane CJK character.
 *
 * Every user-editable text column carries one. Nothing did before: `items.name` was a plain
 * `TEXT NOT NULL` among eighty-nine CHECKs that constrained everything except a length, so a
 * fifty-thousand-character name from one runaway import cell was stored, indexed by FTS, and
 * carried into every list row, printed label and CSV export. The tiers sit far above real data,
 * which is what makes this a backstop rather than a limit anyone types into: the app refuses an
 * over-long value first (see `text-limits.ts` and the Foundry controls), and this is what holds
 * when a write arrives from somewhere that did not — an import, a peer's sync payload, a
 * restored snapshot.
 *
 * `IS NULL OR` on every one, so a nullable column stays nullable and a NOT NULL one is
 * unaffected by the disjunct that can never be true for it.
 *
 * Columns the user cannot type into are deliberately left alone — ids, foreign keys, password
 * and token hashes, enum-valued columns that already carry their own membership CHECK, and the
 * OPFS paths the app mints for itself. A limit on those would constrain nobody and only add a
 * way for the app's own writes to fail.
 */
function lengthCheck(column: string, limit: number): string {
  return `CHECK (${column} IS NULL OR length(${column}) <= ${limit})`;
}

/**
 * The same ceilings as a block of table-level constraints, for the columns a `CREATE TABLE`
 * declares. The columns the baseline adds by `ALTER TABLE` take {@link lengthCheck} inline
 * instead, since SQLite can only attach a constraint to a column as it is added.
 */
function lengthChecks(limits: Readonly<Record<string, number>>): string {
  return Object.entries(limits)
    .map(([column, limit]) => lengthCheck(column, limit))
    .join(',\n          ');
}

/**
 * The `id` a `stock_deltas` capture trigger mints for the row it is about to write (issue #696).
 *
 * Ordinarily random, because an ordinary movement is a one-off event that nothing else will ever
 * repeat. A **one-shot terminal operation** is the exception: finalising a project can be run once
 * on each of two devices while they are offline, and issue #195 already derives every *row* id such
 * a finalise mints from the project id so the merge collapses the two runs to one artefact. The
 * stock it moves had no equivalent — each device's copy of the same draw carried a different random
 * id, so the union-by-id replay in `reconcileStockQuantity` counted both and took the quantity
 * twice.
 *
 * So while `stock_delta_capture.operation_key` holds a key (set by `withOperationKey` around
 * exactly that operation's writes), the id is derived from the key, the placement it moved and how
 * many rows the operation has already written *at that placement*:
 *
 *     <operation_key>|<item_id>|<location_id>|<batch_key>|<n>
 *
 * Both devices start from the same synced state and run the same plan, so both derive the same ids,
 * and the existing id-union collapses their two ledgers to one movement. Nothing downstream
 * changes: the merge's `INSERT OR IGNORE` simply ignores the peer's copy.
 *
 * The `<n>` ordinal is what keeps the id unique when one operation writes a placement twice — the
 * CONTAINER outcome does, when two lots sharing a batch key land in the container from different
 * shelves. It is scoped to the placement rather than to the operation as a whole so that a device
 * whose lots happen to be split differently misaligns only *that* placement, instead of shifting
 * every id the operation writes after it. Counting by an `id` prefix rather than by a column of its
 * own keeps the change inside the local-only capture table: `stock_deltas` is synced and backed up,
 * and needs no new column to carry this. The `LIKE` pattern is a bare key plus `|%` and the key is
 * always a UUID (see `withOperationKey`), so it holds no wildcard of its own; `batch_key`, which
 * can hold anything a user typed, is matched by equality and never reaches the pattern.
 *
 * `row` is the trigger alias the placement is read from — `NEW` for the INSERT and UPDATE arms,
 * `OLD` for the DELETE arm, which has no `NEW` row to name the placement it is emptying.
 */
const stockDeltaIdExpression = (row: 'NEW' | 'OLD') => {
  const key = `(SELECT operation_key FROM stock_delta_capture WHERE id = 1)`;
  const ordinal = `(SELECT COUNT(*) FROM stock_deltas d
                     WHERE d.item_id = ${row}.item_id AND d.location_id = ${row}.location_id
                       AND d.batch_key = ${row}.batch_key AND d.id LIKE ${key} || '|%')`;
  return `CASE WHEN ${key} IS NULL THEN lower(hex(randomblob(16)))
               ELSE ${key} || '|' || ${row}.item_id || '|' || ${row}.location_id || '|' ||
                    ${row}.batch_key || '|' || ${ordinal}
          END`;
};

/**
 * The baseline's DDL, separated from the migration object so its fingerprint can be computed
 * from it (the stamp statement that carries the fingerprint obviously cannot hash itself).
 */
const baselineStatements: SqlStatement[] = [
  {
    sql: `
        CREATE TABLE app_meta (
          key        TEXT    PRIMARY KEY NOT NULL,
          value      TEXT,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ value: TEXT_LIMITS.payload })}
        ) STRICT;
      `,
  },
  {
    sql: `
        CREATE TRIGGER trg_app_meta_updated_at
        AFTER UPDATE ON app_meta
        FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
        BEGIN
          UPDATE app_meta SET updated_at = (${SQL_NOW_MS}) WHERE key = NEW.key;
        END;
      `,
  },
  // --- Principals (issue #79, plan §2) -------------------------------------------------
  // `roles` and `users` are created first so every table that attributes a row to an actor
  // can reference them, and so their `SYNC_TABLES` entries can sit ahead of their children.
  {
    sql: `
        CREATE TABLE roles (
          id          TEXT    PRIMARY KEY NOT NULL,
          name        TEXT    NOT NULL,
          description TEXT,
          -- JSON array of "<subject>:<action>" permission keys. The closed union that
          -- validates them is a phase-2 concern (features/users/permission-registry.ts);
          -- storage deliberately keeps this opaque so the registry can grow without a
          -- schema change.
          permissions TEXT    NOT NULL DEFAULT '[]',
          -- A role shipped with Gubbins rather than created by an operator. Built-in roles
          -- are editable (plan §2.3) but may not be deleted, so a user can never be left
          -- pointing at a role that no longer exists.
          is_builtin  INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (is_builtin IN (0, 1)),
          ${lengthChecks({ name: TEXT_LIMITS.line, description: TEXT_LIMITS.note, permissions: TEXT_LIMITS.payload })}
        ) STRICT;
      `,
  },
  { sql: `CREATE UNIQUE INDEX idx_roles_name ON roles(name COLLATE NOCASE);` },
  { sql: updatedAtTrigger('roles') },
  {
    sql: `
        CREATE TRIGGER trg_roles_protect_builtin_delete
        BEFORE DELETE ON roles
        FOR EACH ROW
        WHEN OLD.is_builtin = 1
        BEGIN
          SELECT RAISE(ABORT, 'A built-in role cannot be deleted.');
        END;
      `,
  },
  // The four roles Gubbins ships with (plan §2.3). Seeded here — rather than by application
  // code on first boot — so a fresh database is complete the moment the baseline finishes,
  // and so `users.role_id` has something to reference. Their contents come from
  // `features/users/builtin-roles.ts`, the same module the app and the Bridge read, so the
  // roles in a database and the roles in code cannot drift.
  ...BUILTIN_ROLES.map((role) => ({
    sql: `
        INSERT INTO roles (id, name, description, permissions, is_builtin)
        VALUES (?, ?, ?, ?, 1);
      `,
    params: [role.id, role.name, role.description, JSON.stringify(normaliseGrants(role.grants))],
  })),
  {
    sql: `
        CREATE TABLE users (
          id                  TEXT    PRIMARY KEY NOT NULL,
          username            TEXT    NOT NULL,
          display_name        TEXT    NOT NULL,
          email               TEXT,
          -- Free text: what this account is for. Populated at seed time for the two built-in
          -- principals (issue #430); optional for an ordinary account.
          description         TEXT,
          -- All three are NULL together when the user has no password at all, which is a
          -- legitimate configuration on a shared household device where the point is
          -- attribution rather than secrecy (plan §1.1). The iteration count is stored
          -- per-user so it can be raised later without invalidating existing hashes.
          password_hash       TEXT,
          password_salt       TEXT,
          password_iterations INTEGER,
          is_enabled          INTEGER NOT NULL DEFAULT 1,
          disabled_message    TEXT,
          kind                TEXT    NOT NULL DEFAULT 'normal',
          -- NULL for the built-in system/admin users, whose permissions are implicit and
          -- not editable. ON DELETE RESTRICT is deliberately absent: a role that is still
          -- assigned cannot be deleted anyway, because deleting it would leave the user
          -- with no permissions at all rather than an obvious error.
          role_id             TEXT    REFERENCES roles(id) ON DELETE SET NULL,
          created_at          INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at          INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (is_enabled IN (0, 1)),
          CHECK (kind IN (${userKindList})),
          -- The password triple is all-or-nothing: a hash without its salt or iteration
          -- count is unverifiable, and a salt without a hash is meaningless.
          CHECK (
            (password_hash IS NULL AND password_salt IS NULL AND password_iterations IS NULL)
            OR (password_hash IS NOT NULL AND password_salt IS NOT NULL AND password_iterations IS NOT NULL)
          ),
          ${lengthChecks({ username: TEXT_LIMITS.line, display_name: TEXT_LIMITS.line, email: TEXT_LIMITS.line, description: TEXT_LIMITS.note, disabled_message: TEXT_LIMITS.note })}
        ) STRICT;
      `,
  },
  { sql: `CREATE UNIQUE INDEX idx_users_username ON users(username COLLATE NOCASE);` },
  { sql: `CREATE INDEX idx_users_role_id ON users(role_id);` },
  { sql: updatedAtTrigger('users') },
  // The two built-in users are protected in the same shape as the system-locked locations
  // (`trg_locations_protect_system_*`): a guard that exists only in a React component is not
  // a guard. `kind` doubles as the flag, since only the seeded rows are ever system/admin.
  {
    sql: `
        CREATE TRIGGER trg_users_protect_system_update
        BEFORE UPDATE ON users
        FOR EACH ROW
        WHEN OLD.kind = 'system'
        BEGIN
          SELECT RAISE(ABORT, 'The built-in System user cannot be modified.');
        END;
      `,
  },
  // Admin is protected in its *identity and authority*, not in every column. It must be able
  // to take a password: with the users module on, Admin is a real account someone signs in as,
  // and a full-access account that cannot be protected would be worse than no sign-in at all.
  // So the guard names the columns it defends — username, kind, role and enabled state —
  // rather than the whole row, exactly as `trg_item_history_immutable` names the substantive
  // ledger columns so an actor can still be re-pointed. `display_name` is included: Admin is a
  // well-known identity that history entries are attributed to, and renaming it would make
  // past attribution read as somebody else.
  {
    sql: `
        CREATE TRIGGER trg_users_protect_admin_update
        BEFORE UPDATE ON users
        FOR EACH ROW
        WHEN OLD.kind = 'admin'
          AND (
            NEW.username     IS NOT OLD.username
            OR NEW.display_name IS NOT OLD.display_name
            OR NEW.kind      IS NOT OLD.kind
            OR NEW.role_id   IS NOT OLD.role_id
            OR NEW.is_enabled IS NOT OLD.is_enabled
          )
        BEGIN
          SELECT RAISE(ABORT, 'The built-in Admin user cannot be renamed, disabled or re-roled.');
        END;
      `,
  },
  {
    sql: `
        CREATE TRIGGER trg_users_protect_builtin_delete
        BEFORE DELETE ON users
        FOR EACH ROW
        WHEN OLD.kind IN ('system', 'admin')
        BEGIN
          SELECT RAISE(ABORT, 'The built-in System and Admin users cannot be deleted.');
        END;
      `,
  },
  {
    sql: `
        INSERT INTO users (id, username, display_name, description, kind, is_enabled)
        VALUES (?, ?, ?, ?, 'system', 0);
      `,
    params: [SYSTEM_USER_ID, SYSTEM_USER_USERNAME, SYSTEM_USER_DISPLAY_NAME, SYSTEM_USER_DESCRIPTION],
  },
  {
    sql: `
        INSERT INTO users (id, username, display_name, description, kind, is_enabled)
        VALUES (?, ?, ?, ?, 'admin', 1);
      `,
    params: [ADMIN_USER_ID, ADMIN_USER_USERNAME, ADMIN_USER_DISPLAY_NAME, ADMIN_USER_DESCRIPTION],
  },
  // --- Bridge API tokens (issue #79, plan §1.3) ----------------------------------
  //
  // A per-user credential the Bridge resolves to an identity, replacing the single shared
  // `GUBBINS_BRIDGE_TOKEN`. It lives in the database — and therefore in the sync snapshot —
  // for the same reason `webhooks` does: syncing it *is* the delivery mechanism. The Bridge
  // owns no database of its own; it hydrates the snapshot, so a token excluded from it could
  // never authenticate anything.
  //
  // Only the **hash** is stored, never the token itself. Unlike a password this is a plain
  // SHA-256 rather than PBKDF2: the secret is 256 bits of CSPRNG output, so there is no
  // dictionary or guess to slow down, and the Bridge must resolve one on every single request
  // — a 600k-iteration KDF there would be a self-inflicted denial of service. See
  // `features/users/api-token.ts` for the full reasoning.
  //
  // `ON DELETE CASCADE` is deliberate and differs from `item_history.actor_user_id`, which
  // re-points to System. History is a record of what happened and must outlive the person; a
  // credential is authority *to act*, and must die with the account it speaks for.
  {
    sql: `
        CREATE TABLE api_tokens (
          id           TEXT    PRIMARY KEY NOT NULL,
          user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          -- Operator-facing label ("Home Assistant", "Kitchen tablet") so a token can be
          -- recognised — and revoked — without anyone having to reveal it.
          name         TEXT    NOT NULL,
          -- Lowercase hex SHA-256 of the token. UNIQUE so a presented token resolves by
          -- indexed lookup rather than a scan-and-compare over every row.
          token_hash   TEXT    NOT NULL,
          -- The token's first few characters, kept in the clear purely so the list can show
          -- *which* token a row is. Far too short to narrow the secret meaningfully.
          token_prefix TEXT    NOT NULL,
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ name: TEXT_LIMITS.line })}
        ) STRICT;
      `,
  },
  { sql: `CREATE UNIQUE INDEX idx_api_tokens_token_hash ON api_tokens(token_hash);` },
  { sql: `CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id);` },
  { sql: updatedAtTrigger('api_tokens') },
  {
    sql: `
        CREATE TABLE categories (
          id                      TEXT    PRIMARY KEY NOT NULL,
          name                    TEXT    NOT NULL,
          -- Optional decorative Unicode glyph/emoji (issue #83). When set, an item in this
          -- category shows it as a faint greyscale watermark on its Visual card. Purely
          -- presentational; nullable (no glyph). Stored verbatim as the emoji character(s).
          glyph                   TEXT,
          -- Optional category template default (backlog T1): soft-prefills a new item's
          -- tracking mode in the create form. Nullable (no default); constrained to the
          -- TRACKING_MODES SSOT exactly as items.tracking_mode is.
          default_tracking_mode   TEXT,
          -- Optional category template defaults (backlog T2): soft-prefill a new item's
          -- lifecycle facets on the create form. Both nullable (no default).
          --  · default_condition       — mirrors items.condition (CONDITIONS SSOT).
          --  · default_warranty_months — a warranty *window* in whole months; the create
          --    form turns it into an expiry date (acquired-on + N months) at submit.
          default_condition       TEXT,
          default_warranty_months INTEGER,
          -- Optional category template default maintenance schedule (backlog T2a). Unlike the
          -- soft-prefill facets above, this is *applied* after item create as a
          -- maintenance_schedules row (the item create paths honour it) rather than pre-filling a
          -- form field. Columns mirror maintenance_schedules and are independently nullable:
          --  · default_maintenance_basis          — TIME|USAGE (MAINTENANCE_BASES SSOT).
          --  · default_maintenance_interval_days  — TIME interval in days (mirrors interval_days).
          --  · default_maintenance_interval_usage — USAGE interval in units (mirrors interval_usage).
          -- The application step requires a basis *and* its matching interval both set, so a
          -- half-configured default (basis without an interval) is simply a no-op — hence no
          -- cross-column coherence CHECK, keeping partial LWW updates from the editor legal.
          default_maintenance_basis          TEXT,
          default_maintenance_interval_days  INTEGER,
          default_maintenance_interval_usage REAL,
          -- Capabilities this category's items don't have (issue #618): a JSON array of
          -- FeatureId strings. A Movie has no maintenance schedule and no warranty, so
          -- surfacing those sections on every film is noise the Modules screen cannot remove
          -- without also stripping them from the power tools in the same inventory.
          --
          -- Strictly a *narrowing* of the device's module set, never a widening: a category
          -- may hide what the device shows, but must never re-enable what the device has
          -- switched off, or the Modules screen stops being the truth about this device.
          -- Presentation only — hidden sections keep their data, keep syncing it, and keep
          -- raising their alerts, and a section that *holds* data is shown regardless.
          --
          -- Opaque TEXT with no json_valid() CHECK, for the same reason as the webhook
          -- columns below: the mapper parses tolerantly and drops members that are not
          -- strings, so a malformed value from a peer costs this one field instead of
          -- failing the whole sync apply. Nullable (nothing hidden).
          hidden_capabilities                TEXT,
          -- The open databases this category's fields can be filled from (issue #616): a JSON
          -- array of { providerId, fieldMap? } entries naming providers from the app's own
          -- curated registry. A Movie category can fill Director/Cast/Release year from an
          -- open film database; a Book category from an open book database. The binding is
          -- category-id → provider-id, never name → behaviour, so renaming the category to
          -- "Films I own" keeps its lookup and a hand-built category can attach the same one.
          --
          -- The optional per-entry fieldMap (output key → the category_fields.id to fill)
          -- overrides the provider's default name match, for a category whose field has been
          -- renamed or re-purposed. Absent means "bind by name", which is the common case.
          --
          -- Opaque TEXT with no json_valid() CHECK, exactly as hidden_capabilities above: the
          -- mapper parses tolerantly and drops malformed members, so a bad value from a peer
          -- costs this one field instead of failing the whole sync apply. Provider ids this
          -- build doesn't recognise are kept verbatim so an older device can't discard a newer
          -- peer's choice on a round-trip. Nullable (no lookups).
          lookup_sources                     TEXT,
          -- Where this category's custom fields sit in the item dialog (issue #619). A Movie
          -- exists *because* of its Format, Director and Year; a Fastener's custom fields are a
          -- footnote to its built-in ones. One position cannot be right for both, and the
          -- category is the only thing that knows which fields an item even has.
          --
          -- 'default' (or NULL) leaves them in the Classification tab; 'promoted' moves that
          -- whole tab up to sit directly after Details; 'own-tab' breaks the Custom fields
          -- section out into a tab of its own there, labelled by field_tab_label.
          --
          -- No CHECK, and no NOT NULL: an unrecognised mode written by a peer on a newer version
          -- is kept verbatim and simply reads as 'default' here, exactly as an unknown id in
          -- hidden_capabilities does. A CHECK would instead fail that peer's whole sync apply
          -- over a presentational preference.
          field_prominence                   TEXT,
          -- The label for the 'own-tab' break-out tab; NULL falls back to the built-in
          -- "Custom fields". Kept even while another mode is selected, so switching modes back
          -- and forth doesn't discard the wording the user chose.
          field_tab_label                    TEXT,
          updated_at              INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (default_tracking_mode IS NULL OR default_tracking_mode IN (${trackingModeList})),
          CHECK (default_condition IS NULL OR default_condition IN (${conditionList})),
          CHECK (default_warranty_months IS NULL OR default_warranty_months > 0),
          CHECK (default_maintenance_basis IS NULL OR default_maintenance_basis IN (${basisList})),
          CHECK (default_maintenance_interval_days IS NULL OR default_maintenance_interval_days > 0),
          CHECK (default_maintenance_interval_usage IS NULL OR default_maintenance_interval_usage > 0),
          ${lengthChecks({ name: TEXT_LIMITS.line, glyph: TEXT_LIMITS.code, hidden_capabilities: TEXT_LIMITS.payload, lookup_sources: TEXT_LIMITS.payload, field_prominence: TEXT_LIMITS.payload, field_tab_label: TEXT_LIMITS.line })}
        ) STRICT;
      `,
  },
  { sql: updatedAtTrigger('categories') },
  {
    sql: `
        CREATE TABLE locations (
          id         TEXT    PRIMARY KEY NOT NULL,
          name       TEXT    NOT NULL,
          parent_id  TEXT    REFERENCES locations(id),
          is_system  INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (parent_id IS NULL OR parent_id <> id),
          CHECK (is_system IN (0, 1)),
          ${lengthChecks({ name: TEXT_LIMITS.line })}
        ) STRICT;
      `,
  },
  { sql: `CREATE INDEX idx_locations_parent_id ON locations(parent_id);` },
  { sql: updatedAtTrigger('locations') },
  {
    sql: `
        CREATE TRIGGER trg_locations_protect_system_update
        BEFORE UPDATE ON locations
        FOR EACH ROW
        WHEN OLD.is_system = 1
        BEGIN
          SELECT RAISE(ABORT, 'The Unassigned location is system-locked and cannot be modified.');
        END;
      `,
  },
  {
    sql: `
        CREATE TRIGGER trg_locations_protect_system_delete
        BEFORE DELETE ON locations
        FOR EACH ROW
        WHEN OLD.is_system = 1
        BEGIN
          SELECT RAISE(ABORT, 'The Unassigned location is system-locked and cannot be deleted.');
        END;
      `,
  },
  {
    sql: `
        INSERT INTO locations (id, name, parent_id, is_system)
        VALUES (?, ?, NULL, 1);
      `,
    params: [UNASSIGNED_LOCATION_ID, UNASSIGNED_LOCATION_NAME],
  },
  {
    // The location activity record (issue #691) — the `item_history` counterpart for the one
    // structure in the app several people can reshape and nobody could audit. Renaming a
    // location, moving it under a different parent or archiving it used to leave nothing behind
    // but a bumped `updated_at`, so "why is this shelf under a different room?" was unanswerable.
    //
    // A **sibling table**, not a nullable subject column on `item_history`: that ledger's
    // `item_id` is NOT NULL by construction and its immutability trigger, cascade and union-by-id
    // sync all lean on it. Gubbins' precedent is a narrow typed table per need
    // (`location_tags`, `location_field_values`, `location_photos`), and this follows it.
    //
    // Three column choices carry the design:
    //
    //  - `location_id` carries **no foreign key at all** — it is a historical coordinate, the same
    //    shape `stock_deltas.location_id` takes. `item_history`'s CASCADE would destroy the record
    //    of a place at the moment it was removed, which is exactly when "what happened to it?" is
    //    worth asking; and `ON DELETE SET NULL` would keep the row but blank the id on every single
    //    `DELETED` entry — so a `location.removed` event could never tell a subscriber *which*
    //    location went. Dropping the reference keeps both the entry and its subject, and a
    //    dangling id is the correct reading of a record about something that no longer exists.
    //  - `location_name` is the snapshot of the name the location carried **when the entry was
    //    written**. It is what keeps an entry readable once its location is gone (and what lets a
    //    rename read as a rename), so it is NOT NULL and never back-filled.
    //  - `actor_user_id` mirrors `item_history` exactly, including the DEFAULT that exists for the
    //    FK action rather than for callers (see that table for the full reasoning).
    //
    // Deliberately **no immutability trigger**, unlike `item_history`. That ledger can be strictly
    // immutable because it is a bespoke union-by-id snapshot section: a merge only ever
    // `INSERT OR IGNORE`s into it, so no UPDATE is ever attempted. This table is instead an ordinary
    // LWW leaf in `SYNC_TABLES` (see `tombstone.ts`), and the shared upsert it goes through is an
    // unconditional `ON CONFLICT(id) DO UPDATE SET …` (`merge.ts`) — the LWW comparison happens in
    // JavaScript, and a byte-identical winner is skipped before any statement is built
    // (`upsertWouldNoOp` in `reconcile.ts`). So an ordinary re-sync writes nothing, but any row that
    // *does* differ from the copy we hold — a corrupt or hostile snapshot, or a restore, which has
    // no LWW gate at all — would fire the UPDATE, and a trigger there would ABORT the whole
    // transaction rather than let it through. Append-only is therefore enforced where it is actually
    // written (the repository has no UPDATE path), matching the project's other synced append-only
    // logs: `revaluations`, `test_records` and `supplier_part_price_history` all take this shape.
    sql: `
        CREATE TABLE location_history (
          id            TEXT    PRIMARY KEY NOT NULL,
          location_id   TEXT    NOT NULL,
          location_name TEXT    NOT NULL,
          action        TEXT    NOT NULL,
          note          TEXT,
          metadata      TEXT,
          actor_user_id TEXT    NOT NULL DEFAULT '${SYSTEM_USER_ID}'
                                REFERENCES users(id) ON DELETE SET DEFAULT,
          created_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ location_name: TEXT_LIMITS.line, note: TEXT_LIMITS.note, metadata: TEXT_LIMITS.payload })}
        ) STRICT;
      `,
  },
  // The per-location read (the editor's History tab) and the actor repoint, mirroring
  // `item_history`'s pair.
  { sql: `CREATE INDEX idx_location_history_location_id ON location_history(location_id, created_at);` },
  { sql: `CREATE INDEX idx_location_history_actor_user_id ON location_history(actor_user_id);` },
  // The cross-location newest-first scan the bridge's event generation pages through. Without it
  // that read sorts the whole table on every hydration generation.
  { sql: `CREATE INDEX idx_location_history_created_at ON location_history(created_at);` },
  { sql: updatedAtTrigger('location_history') },
  {
    sql: `
        CREATE TABLE items (
          id                   TEXT    PRIMARY KEY NOT NULL,
          name                 TEXT    NOT NULL,
          description          TEXT,
          notes                TEXT,
          location_id          TEXT    NOT NULL REFERENCES locations(id),
          category_id          TEXT    REFERENCES categories(id) ON DELETE SET NULL,
          tracking_mode        TEXT    NOT NULL DEFAULT 'DISCRETE',
          quantity             INTEGER NOT NULL DEFAULT 0,
          unit_of_measure      TEXT,
          gross_capacity       REAL,
          tare_weight          REAL,
          current_net_value    REAL,
          attrition_percent    REAL,
          -- What one unit of measure costs (issue #683). Money, so an INTEGER count of
          -- micro-units like every other monetary column — see the money convention comment
          -- below. A gauge holds a *measure*, not units, so quantity × unit_cost values it at
          -- zero however it is priced; this is the only per-item figure a gauge's contents can
          -- be valued from (current_net_value × cost_per_unit_of_measure). Optional: NULL
          -- means the gauge is unpriced, and valuation reports it as such rather than as 0.
          cost_per_unit_of_measure INTEGER,
          operational_metadata TEXT,
          is_active            INTEGER NOT NULL DEFAULT 1,
          is_unlimited         INTEGER NOT NULL DEFAULT 0,
          is_favourite         INTEGER NOT NULL DEFAULT 0,
          created_at           INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at           INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (tracking_mode IN (${trackingModeList})),
          CHECK (is_active IN (0, 1)),
          CHECK (quantity >= 0),
          CHECK (tracking_mode <> 'SERIALISED' OR quantity = 1),
          -- "Unlimited supply" (Phase 82) is a DISCRETE-only modifier: an item whose
          -- source is effectively infinite (tap water, mains air). The first CHECK keeps
          -- it a strict boolean; the second is the invariant that it can only sit on a
          -- DISCRETE item, mirroring the SERIALISED-quantity CHECK above.
          CHECK (is_unlimited IN (0, 1)),
          CHECK (is_unlimited = 0 OR tracking_mode = 'DISCRETE'),
          -- "Favourite" (issue #23): a user-pinned item that sorts ahead of the rest of the
          -- list. Applies to any item regardless of tracking mode, so — unlike is_unlimited —
          -- it carries only the strict-boolean CHECK, no mode restriction.
          CHECK (is_favourite IN (0, 1)),
          -- Gauge fields are mandatory and sane only for CONSUMABLE_GAUGE items.
          CHECK (
            tracking_mode <> 'CONSUMABLE_GAUGE' OR (
              unit_of_measure   IS NOT NULL AND
              gross_capacity    IS NOT NULL AND gross_capacity > 0 AND
              tare_weight       IS NOT NULL AND tare_weight >= 0 AND
              current_net_value IS NOT NULL AND current_net_value >= 0
            )
          ),
          -- Attrition (issue #89) is the proportional waste a draw costs on top of what was
          -- asked for. Unlike the gauge fields above it is *optional* — NULL means "no
          -- attrition", which is the default and the overwhelmingly common case — so it gets
          -- its own CHECK rather than joining the mandatory block. The 0–100 ceiling bounds a
          -- draw at double the requested amount, so a mistyped rate cannot empty a gauge.
          CHECK (attrition_percent IS NULL OR (attrition_percent >= 0 AND attrition_percent <= 100)),
          CHECK (attrition_percent IS NULL OR tracking_mode = 'CONSUMABLE_GAUGE'),
          -- Cost per unit of measure (issue #683) is optional in the same way, and gauge-only
          -- for the same reason: an item that counts units has no unit of measure to price.
          -- Non-negativity mirrors every other money column's CHECK (issue #349).
          CHECK (cost_per_unit_of_measure IS NULL OR cost_per_unit_of_measure >= 0),
          CHECK (cost_per_unit_of_measure IS NULL OR tracking_mode = 'CONSUMABLE_GAUGE'),
          ${lengthChecks({ name: TEXT_LIMITS.line, description: TEXT_LIMITS.note, notes: TEXT_LIMITS.note, unit_of_measure: TEXT_LIMITS.line, operational_metadata: TEXT_LIMITS.payload })}
        ) STRICT;
      `,
  },
  { sql: `CREATE INDEX idx_items_location_id ON items(location_id);` },
  { sql: `CREATE INDEX idx_items_category_id ON items(category_id);` },
  { sql: `CREATE INDEX idx_items_is_active ON items(is_active);` },
  // Order-by support for the item list reads (issue #164). Every list page sorts the matching
  // set before LIMIT/OFFSET, so without a covering index each page is a full scan + full sort.
  // Both indexes are partial (WHERE is_active = 1) because list reads default to active
  // inventory, so the index only carries the rows the reads actually visit.
  //
  //  - The default list floats favourites first, then name (issue #23):
  //    `is_favourite DESC, name COLLATE NOCASE ASC, …`. This composite matches that prefix, so
  //    the scan walks the index in order and only block-sorts the tiny per-name tie-break tail.
  {
    sql: `CREATE INDEX idx_items_favourite_name ON items(is_favourite DESC, name COLLATE NOCASE) WHERE is_active = 1;`,
  },
  //  - The Visual-Builder AST search orders by `name COLLATE NOCASE ASC, …` with no favourite
  //    prefix, so the composite above cannot order it (its leading column is is_favourite). A
  //    plain name index serves that path the same way.
  { sql: `CREATE INDEX idx_items_name ON items(name COLLATE NOCASE) WHERE is_active = 1;` },
  { sql: updatedAtTrigger('items') },
  {
    sql: `
        CREATE TABLE item_history (
          id              TEXT    PRIMARY KEY NOT NULL,
          item_id         TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          action          TEXT    NOT NULL,
          quantity_delta  INTEGER,
          net_value_delta REAL,
          note            TEXT,
          metadata        TEXT,
          -- Who performed the action (issue #79, plan §2.4). NOT NULL: every ledger entry is
          -- attributable, and the write path requires the actor as an argument so a caller
          -- that forgets one fails to compile rather than silently recording System.
          --
          -- The DEFAULT exists for the FK action, not for callers: ON DELETE SET DEFAULT
          -- re-points a deleted user's entries at System, which preserves both NOT NULL and
          -- the ledger itself. Deleting a user must never delete or falsify their history,
          -- and it must not require an UPDATE the immutability trigger would refuse. A foreign-key
          -- action does fire ordinary triggers (the recursive_triggers pragma governs a trigger's
          -- own writes, not this), so what keeps it clear is the trigger's column scope: it guards
          -- the substantive columns and exempts actor_user_id precisely so this re-point is allowed.
          actor_user_id   TEXT    NOT NULL DEFAULT '${SYSTEM_USER_ID}'
                                  REFERENCES users(id) ON DELETE SET DEFAULT,
          created_at      INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ note: TEXT_LIMITS.note, metadata: TEXT_LIMITS.payload })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_item_history_item_id ON item_history(item_id, created_at);`,
  },
  { sql: `CREATE INDEX idx_item_history_actor_user_id ON item_history(actor_user_id);` },
  // The cross-item newest-first reads (issue #524), mirroring `idx_location_history_created_at`.
  // `created_at` is only the *second* column of the per-item index above, so it can be seeked
  // within one item and nowhere else — which left every read that looks at the ledger *across*
  // items scanning the whole table. The Activity Log and the dashboard's recent-activity widget
  // (`getHistoryFeed`) then *also* sorted it into a temp B-tree, because they order by
  // `created_at`; `consumptionRate`, `movement` and `salesAnalytics` scan without sorting, as does
  // the history prune. The ledger grows per *event* rather than per item, so it is the
  // fastest-growing table here and the one least able to afford a scan.
  //
  // `valuationTrend` is deliberately absent from that list: although it writes the same
  // `created_at` range, the planner drives it from `items` (its `is_active = 1` arm seeks
  // `idx_items_is_active`) and reaches the ledger through `idx_item_history_item_id`, whose
  // second column already bounds `created_at` *within* each item. Its plan is byte-identical
  // with and without this index.
  //
  // Three deliberate choices, each checked against the query plan it actually produces — this
  // table's access patterns punish a plausible-looking guess. Timings below are best-of-5 over a
  // 200,000-row in-memory ledger with no statistics, which is how the app runs (see below);
  // treat them as ratios, not absolutes.
  //
  //  - **Single-column, and ASC — not `created_at DESC`.** The feed orders by
  //    `created_at DESC, rowid DESC`, and SQLite appends the rowid to every index on a rowid
  //    table, so this index's keys *are* `(created_at, rowid)` ascending. Walked in reverse that
  //    yields `created_at DESC, rowid DESC` — the ORDER BY exactly, tie-break included, so the
  //    sort disappears entirely (28 ms → 0.07 ms for page 1). A `DESC` index gets close but not
  //    there: its keys are `(created_at DESC, rowid ASC)`, so SQLite still walks it for the
  //    leading term and block-sorts each equal-`created_at` group —
  //    `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`. That residual sort is bounded and costs
  //    little here, but it is strictly worse for nothing gained, and it grows with the number of
  //    entries sharing a millisecond — which a bulk write produces readily, since the ledger
  //    insert takes `created_at`'s DEFAULT and a whole batch lands in one transaction.
  //  - **No `action` column.** Serving the kind-filter chips with a composite looks appealing —
  //    `WHERE h.action IN (…)` has no index today — but it is a trap. With one, the no-stats
  //    planner prefers seeking `action` and then re-sorts the matches by `created_at`; measured,
  //    that turned a three-chip filtered page from 0.07 ms *back* into 29 ms, ~400× worse, while
  //    helping only the single-chip case. Reverse-walking this index and testing `action` per row
  //    stops at the first `LIMIT` rows instead, so the chips ride the same ordered walk the
  //    unfiltered feed does (54 ms → 0.07 ms).
  //  - **Not partial.** Every read here wants the whole ledger; there is no subset to narrow to.
  //
  // Robust to the no-stats planner (Gubbins only runs `ANALYZE` on the manual "Compact database"
  // action — the same rationale as `idx_items_active_location`): a single-column index over the
  // column the reads both order *and* range-filter by is what the planner picks with or without
  // statistics, and the feed's plan is identical either way.
  //
  // What this index does **not** do is speed the reports up uniformly. For the three that do read
  // the ledger directly it makes the window seekable, and the gain scales with how narrow that
  // window is: measured on `salesAnalytics` and `movement`, ~8× at a 7-day window, ~2.5× at 30
  // days, roughly break-even by 90, and a shade *slower* at 365 — a year-long window over a year
  // of data is the whole table, so a seek has nothing to skip. The feed, not the reports, is what
  // this index is for.
  { sql: `CREATE INDEX idx_item_history_created_at ON item_history(created_at);` },
  {
    // Scoped to the substantive columns rather than the whole row: the ledger's *facts* are
    // immutable, but re-attributing an entry to System when its author is deleted is not a
    // rewrite of what happened. Leaving the trigger unscoped would make the FK's
    // SET DEFAULT unusable and force user deletion to either destroy history or dangle.
    sql: `
        CREATE TRIGGER trg_item_history_immutable
        BEFORE UPDATE OF id, item_id, action, quantity_delta, net_value_delta, note, metadata, created_at
        ON item_history
        FOR EACH ROW
        BEGIN
          SELECT RAISE(ABORT, 'item_history is an immutable, append-only ledger.');
        END;
      `,
  },
  { sql: `ALTER TABLE items ADD COLUMN serial_no INTEGER;` },
  {
    // The global **field dictionary** (issue #97). A custom field's *identity* —
    // its name, type, option list and help note — lives here once, decoupled from
    // any one category. Categories and locations both reference a definition rather
    // than owning a private copy, which is what lets a location's value for a def
    // be inherited by an item whose category uses that same def: the link is the
    // def id, so it is exact and survives a rename on either side.
    //
    // `due_lead_days` (W1a) is the DATE due-date opt-in, and it sits **here** rather than
    // on `category_fields` because it is part of what the field *means*, not a category's
    // policy about it: a field named "Renewal date" is a deadline wherever it is used,
    // while "Date acquired" is not one anywhere. The storage decides it too — item values
    // key on `def_id`, never on a category's use of one, so a def-scoped flag makes the
    // alert feed a plain join, whereas a category-scoped one would miss every value
    // inherited from a location or left behind by a category change.
    //
    // `unit` (W1b) and `min_value`/`max_value` (W1c) sit here for the same reason and are
    // decided by the same two facts: "Voltage" is measured in volts wherever it is used, and
    // a torque that must fall between 8 and 12 is out of range wherever it is entered. Because
    // values key on `def_id`, a category-scoped unit would render nothing beside a value an
    // item inherited from a location; and because the dictionary already refuses to let one
    // name carry two *types*, letting the unit fork per category would reintroduce exactly the
    // ambiguity that guard exists to prevent — the same number reading as millimetres on one
    // item and inches on another, with nothing on screen to explain why.
    //
    // `prominence` (W1d) is the fourth, and sits here for a third reason on top of those two:
    // `category_fields.position` — the obvious alternative home, beside the rest of a category's
    // policy — simply cannot reach a **location's** field values, which have no `category_fields`
    // row at all and can therefore only be ordered by name. It is also a different claim from
    // `position`: that is an *arrangement* within one category, this is "this field matters most,
    // wherever it appears". The rank sorts ahead of `position` rather than replacing it.
    //
    // Note the shape it does *not* share with the three above: no CHECK, and no `field_type`
    // term. Those three are behavioural — a lead time gates an alert, a bound refuses a save — so
    // a value they cannot honour must be refused at the storage boundary. A rank is presentational,
    // so the right failure mode is the opposite one, exactly as `categories.field_prominence`
    // already argues: keep whatever a newer peer wrote and let the render boundary narrow it,
    // rather than fail that peer's entire sync apply over a display preference. And unlike a unit
    // or a lead time, *any* field type can be the one that matters most, so nothing is cleared on
    // a retype.
    //
    // `precision` (W1e) is the fifth, and it is the one attribute here that is not purely one
    // thing or the other: it refuses a value carrying more decimals than it allows *and* decides
    // how a stored one is written wherever it is displayed (`5.5` on a two-decimal field reads
    // `5.50`). Because it refuses a save it takes the behavioural shape — a CHECK, gated on
    // `field_type = 'NUMBER'`, cleared by the write seam on a retype away from it — rather than
    // `prominence`'s tolerant one. It sits on the definition for the same two storage reasons as
    // the unit: how many decimals a measurement is quoted to is part of what the field means, and
    // a category-scoped answer would render nothing for a value inherited from a location.
    sql: `
        CREATE TABLE field_defs (
          id            TEXT    PRIMARY KEY NOT NULL,
          name          TEXT    NOT NULL,
          field_type    TEXT    NOT NULL,
          options       TEXT,                          -- JSON array for SELECT fields
          description   TEXT,                          -- optional help note shown on the control
          due_lead_days INTEGER,                       -- DATE only: days' notice; NULL = not a due date
          unit          TEXT,                          -- NUMBER only: unit of measure; NULL = unitless
          min_value     REAL,                          -- NUMBER only: lower bound; NULL = unbounded below
          max_value     REAL,                          -- NUMBER only: upper bound; NULL = unbounded above
          precision     INTEGER,                       -- NUMBER only: decimal places; NULL = as entered
          prominence    TEXT,                          -- any type: 'key' leads its siblings; NULL = ordinary
          updated_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (field_type IN (${fieldTypeList})),
          -- Only a DATE can be a deadline, and the notice period is bounded. The write seam
          -- clears the value when a field is retyped away from DATE so the user gets a clean
          -- outcome; this CHECK is the backstop under it (and under sync and restore).
          CHECK (
            due_lead_days IS NULL
            OR (field_type = 'DATE'
                AND due_lead_days >= ${FIELD_DUE_LEAD_DAYS_MIN}
                AND due_lead_days <= ${FIELD_DUE_LEAD_DAYS_MAX})
          ),
          -- Only a NUMBER carries a unit. Stored pre-trimmed and never blank, so the column
          -- has one spelling of "no unit" (NULL) rather than two; the write seam folds a blank
          -- to NULL and clears the column on a retype away from NUMBER, and this is the
          -- backstop under it.
          CHECK (
            unit IS NULL
            OR (field_type = 'NUMBER'
                AND unit = trim(unit)
                AND length(unit) BETWEEN 1 AND ${FIELD_UNIT_MAX_LENGTH})
          ),
          -- Only a NUMBER carries a range, and each bound is independently optional: NULL means
          -- unbounded on that side, so "at least 0" and "at most 100" are both expressible.
          CHECK (
            min_value IS NULL
            OR (field_type = 'NUMBER'
                AND min_value >= -${FIELD_NUMBER_BOUND_LIMIT}
                AND min_value <= ${FIELD_NUMBER_BOUND_LIMIT})
          ),
          CHECK (
            max_value IS NULL
            OR (field_type = 'NUMBER'
                AND max_value >= -${FIELD_NUMBER_BOUND_LIMIT}
                AND max_value <= ${FIELD_NUMBER_BOUND_LIMIT})
          ),
          -- An inverted range admits no value at all, so it is not a strict field but a
          -- broken one. Equal bounds are allowed and mean "exactly this".
          CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
          -- Only a NUMBER is written to a number of decimal places, and the count is a whole
          -- number in a bounded range. Zero is a legitimate setting — "whole numbers only" — so
          -- NULL is the only spelling of "as entered"; there is no second value meaning it.
          CHECK (
            precision IS NULL
            OR (field_type = 'NUMBER'
                AND precision >= ${FIELD_PRECISION_MIN}
                AND precision <= ${FIELD_PRECISION_MAX})
          ),
          ${lengthChecks({ name: TEXT_LIMITS.line, options: TEXT_LIMITS.payload, description: TEXT_LIMITS.note })}
        ) STRICT;
      `,
  },
  {
    // One definition per name: the dictionary must not fragment, or two spellings of
    // "Manufacturer" would silently break inheritance. NOCASE so case alone can't
    // fork a def — but NOCASE folds ASCII A–Z only, which leaves `Café`/`CAFÉ` free to
    // fork one anyway. The write seam therefore compares through the Unicode-aware fold
    // in `lib/name-fold` (issue #343); this index is the ASCII-level backstop below it.
    sql: `CREATE UNIQUE INDEX idx_field_defs_name ON field_defs(name COLLATE NOCASE);`,
  },
  { sql: updatedAtTrigger('field_defs') },
  {
    // A category's *use* of a dictionary definition, carrying the policy that is
    // genuinely category-local: whether the field is required of items in this
    // category, its lenient-defaulting value (§4), and its display position.
    sql: `
        CREATE TABLE category_fields (
          id            TEXT    PRIMARY KEY NOT NULL,
          category_id   TEXT    NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
          def_id        TEXT    NOT NULL REFERENCES field_defs(id) ON DELETE CASCADE,
          is_required   INTEGER NOT NULL DEFAULT 0,
          default_value TEXT,                          -- lenient-defaulting value (§4)
          position      INTEGER NOT NULL DEFAULT 0,
          updated_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          UNIQUE (category_id, def_id),
          CHECK (is_required IN (0, 1)),
          ${lengthChecks({ default_value: TEXT_LIMITS.payload })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_category_fields_category_id ON category_fields(category_id);`,
  },
  {
    sql: `CREATE INDEX idx_category_fields_def_id ON category_fields(def_id);`,
  },
  { sql: updatedAtTrigger('category_fields') },
  {
    // A location's value for a dictionary definition (issue #97). `is_inheritable`
    // is opt-in per row: a location may record a value purely as its own metadata
    // without offering it to the items inside it, which is what stops every field
    // becoming inherited by default.
    sql: `
        CREATE TABLE location_field_values (
          id             TEXT    PRIMARY KEY NOT NULL,
          location_id    TEXT    NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
          def_id         TEXT    NOT NULL REFERENCES field_defs(id) ON DELETE CASCADE,
          value          TEXT,
          is_inheritable INTEGER NOT NULL DEFAULT 0,
          updated_at     INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          UNIQUE (location_id, def_id),
          CHECK (is_inheritable IN (0, 1)),
          ${lengthChecks({ value: TEXT_LIMITS.payload })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_location_field_values_location_id ON location_field_values(location_id);`,
  },
  {
    sql: `CREATE INDEX idx_location_field_values_def_id ON location_field_values(def_id);`,
  },
  { sql: updatedAtTrigger('location_field_values') },
  {
    // Per-item values, keyed by **definition** rather than by a category's use of it,
    // so a value survives the item moving between categories that share a def.
    //
    // `mode` makes inheritance a *stored intent* rather than an absence: 'inherit'
    // means "take the nearest inheritable ancestor location's value", re-resolved on
    // every read, so moving the item to another location updates it live. That is
    // deliberately distinct from having no row at all, which means "never set" and
    // falls back to the category default (§4 lenient defaulting).
    sql: `
        CREATE TABLE item_field_values (
          id         TEXT    PRIMARY KEY NOT NULL,
          item_id    TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          def_id     TEXT    NOT NULL REFERENCES field_defs(id) ON DELETE CASCADE,
          value      TEXT,
          mode       TEXT    NOT NULL DEFAULT 'literal',
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          UNIQUE (item_id, def_id),
          CHECK (mode IN (${fieldValueModeList})),
          CHECK (mode <> 'inherit' OR value IS NULL),
          ${lengthChecks({ value: TEXT_LIMITS.payload })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_item_field_values_item_id ON item_field_values(item_id);`,
  },
  {
    sql: `CREATE INDEX idx_item_field_values_def_id ON item_field_values(def_id);`,
  },
  { sql: updatedAtTrigger('item_field_values') },
  {
    // The **effective** value of every item custom field, with location inheritance
    // already applied (issue #97). A row whose mode is 'inherit' resolves to the value
    // offered by its nearest inheritable ancestor location; a literal row passes through.
    //
    // This exists so the *query* layer sees the same value the UI does. Without it a
    // search for `field:Manufacturer=Ryobi` would silently miss every item that inherits
    // Ryobi rather than storing it — the values are NULL in the base table. Resolving it
    // once here keeps that rule in a single place instead of duplicated into each
    // predicate that touches a custom field.
    //
    // The recursive term walks each location to its root; the closure is bounded by the
    // location tree (user-scale), not by the item count.
    sql: `
        CREATE VIEW item_field_effective_values AS
        WITH RECURSIVE location_ancestors(location_id, ancestor_id, depth) AS (
          SELECT id, id, 0 FROM locations
          UNION ALL
          SELECT la.location_id, l.parent_id, la.depth + 1
          FROM location_ancestors la
          JOIN locations l ON l.id = la.ancestor_id
          WHERE l.parent_id IS NOT NULL
        )
        SELECT
          ifv.item_id AS item_id,
          ifv.def_id  AS def_id,
          CASE WHEN ifv.mode = 'inherit' THEN (
            SELECT lfv.value
            FROM location_field_values lfv
            JOIN location_ancestors la ON la.ancestor_id = lfv.location_id
            WHERE la.location_id = i.location_id
              AND lfv.def_id = ifv.def_id
              AND lfv.is_inheritable = 1
            ORDER BY la.depth ASC
            LIMIT 1
          ) ELSE ifv.value END AS value
        FROM item_field_values ifv
        JOIN items i ON i.id = ifv.item_id;
      `,
  },
  {
    sql: `
        CREATE TABLE tags (
          id         TEXT    PRIMARY KEY NOT NULL,
          name       TEXT    NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ name: TEXT_LIMITS.line })}
        ) STRICT;
      `,
  },
  { sql: `CREATE UNIQUE INDEX idx_tags_name ON tags(name COLLATE NOCASE);` },
  { sql: updatedAtTrigger('tags') },
  {
    sql: `
        CREATE TABLE item_tags (
          item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (item_id, tag_id)
        ) STRICT;
      `,
  },
  { sql: `CREATE INDEX idx_item_tags_tag_id ON item_tags(tag_id);` },
  {
    sql: `
        CREATE TABLE location_tags (
          location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
          tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (location_id, tag_id)
        ) STRICT;
      `,
  },
  { sql: `CREATE INDEX idx_location_tags_tag_id ON location_tags(tag_id);` },
  {
    sql: `
        CREATE TABLE item_images (
          id                 TEXT    PRIMARY KEY NOT NULL,
          item_id            TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          thumbnail_blob     BLOB,
          full_res_opfs_path TEXT    NOT NULL,
          position           INTEGER NOT NULL DEFAULT 0,
          created_at         INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at         INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_item_images_item_id ON item_images(item_id, position);`,
  },
  { sql: updatedAtTrigger('item_images') },
  {
    sql: `
        CREATE TABLE item_attachments (
          id         TEXT    PRIMARY KEY NOT NULL,
          item_id    TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          kind       TEXT    NOT NULL,
          value      TEXT    NOT NULL,
          label      TEXT,
          position   INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (kind IN (${attachmentKindList})),
          ${lengthChecks({ value: TEXT_LIMITS.url, label: TEXT_LIMITS.line })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_item_attachments_item_id ON item_attachments(item_id, position);`,
  },
  { sql: updatedAtTrigger('item_attachments') },
  { sql: `ALTER TABLE items ADD COLUMN mpn TEXT ${lengthCheck('mpn', TEXT_LIMITS.line)};` },
  { sql: `ALTER TABLE items ADD COLUMN manufacturer TEXT ${lengthCheck('manufacturer', TEXT_LIMITS.line)};` },
  // Money convention (issue #286): every monetary column is an INTEGER count of **micro-units** —
  // millionths of a major currency unit — not a binary REAL. A fixed 1e6 scale (six decimal
  // places, above every currency's minor unit) is exact, decouples storage from the mutable base
  // currency, and makes SQL SUMs exact and order-independent. The app works in major units on both
  // sides of the repository boundary; `src/lib/money.ts` (`toStoredMoney`/`fromStoredMoney`) is the
  // only place the scale is applied. This applies to every money column below. The CHECK (issue
  // #349) is scale-invariant — 0 and non-negativity mean the same in micro-units.
  { sql: `ALTER TABLE items ADD COLUMN unit_cost INTEGER CHECK (unit_cost IS NULL OR unit_cost >= 0);` },
  { sql: `CREATE INDEX idx_items_mpn ON items(mpn COLLATE NOCASE);` },
  // Retail barcode (GTIN — EAN/UPC): an item's own scannable article code, distinct
  // from the MPN and stored verbatim as printed. Indexed for the scanner's exact
  // lookup-by-barcode, and (below) FTS-indexed like the MPN so a barcode typed into
  // the main search finds its item.
  { sql: `ALTER TABLE items ADD COLUMN barcode TEXT ${lengthCheck('barcode', TEXT_LIMITS.line)};` },
  { sql: `CREATE INDEX idx_items_barcode ON items(barcode COLLATE NOCASE);` },
  // Intrinsic serial number (issue #90): the maker's unique per-unit identifier printed on
  // the article (distinct from `serial_no`, which is only a SERIALISED-clone instance index).
  // Stored verbatim; indexed for exact lookup and (below) FTS-indexed like the barcode so a
  // serial typed into the main search finds its item.
  {
    sql: `ALTER TABLE items ADD COLUMN serial_number TEXT ${lengthCheck('serial_number', TEXT_LIMITS.line)};`,
  },
  { sql: `CREATE INDEX idx_items_serial_number ON items(serial_number COLLATE NOCASE);` },
  {
    sql: `
        CREATE TABLE item_aliases (
          id         TEXT    PRIMARY KEY NOT NULL,
          item_id    TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          alias      TEXT    NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ alias: TEXT_LIMITS.line })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE UNIQUE INDEX idx_item_aliases_alias ON item_aliases(alias COLLATE NOCASE);`,
  },
  { sql: `CREATE INDEX idx_item_aliases_item_id ON item_aliases(item_id);` },
  { sql: updatedAtTrigger('item_aliases') },
  {
    sql: `
        INSERT INTO locations (id, name, parent_id, is_system)
        VALUES (?, ?, NULL, 1);
      `,
    params: [IN_TRANSIT_LOCATION_ID, IN_TRANSIT_LOCATION_NAME],
  },
  {
    sql: `
        CREATE TABLE projects (
          id           TEXT    PRIMARY KEY NOT NULL,
          name         TEXT    NOT NULL,
          description  TEXT,
          -- Optional icon: a canonical Lucide glyph name (PascalCase), or NULL for the default.
          icon         TEXT,
          status       TEXT    NOT NULL DEFAULT 'PLANNING',
          costing_mode TEXT    NOT NULL DEFAULT 'CURRENT_REPLACEMENT',
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (status IN (${projectStatusList})),
          CHECK (costing_mode IN (${costingModeList})),
          ${lengthChecks({ name: TEXT_LIMITS.line, description: TEXT_LIMITS.note, icon: TEXT_LIMITS.code })}
        ) STRICT;
      `,
  },
  { sql: updatedAtTrigger('projects') },
  {
    sql: `
        CREATE TABLE project_bom_lines (
          id                 TEXT    PRIMARY KEY NOT NULL,
          project_id         TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          item_id            TEXT    REFERENCES items(id) ON DELETE SET NULL,
          designator         TEXT,
          mpn                TEXT,
          manufacturer       TEXT,
          description        TEXT,
          required_qty       INTEGER NOT NULL DEFAULT 1,
          reserved_qty       INTEGER NOT NULL DEFAULT 0,
          reservation_status TEXT    NOT NULL DEFAULT 'NONE',
          procurement_status TEXT    NOT NULL DEFAULT 'NONE',
          unit_cost_snapshot INTEGER,                          -- money: integer micro-units (issue #286)
          position           INTEGER NOT NULL DEFAULT 0,
          created_at         INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at         INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (required_qty >= 0),
          CHECK (reserved_qty >= 0),
          CHECK (reservation_status IN (${reservationStatusList})),
          CHECK (procurement_status IN (${procurementStatusList})),
          ${lengthChecks({ designator: TEXT_LIMITS.line, mpn: TEXT_LIMITS.line, manufacturer: TEXT_LIMITS.line, description: TEXT_LIMITS.note })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_project_bom_lines_project_id ON project_bom_lines(project_id, position);`,
  },
  {
    sql: `CREATE INDEX idx_project_bom_lines_item_id ON project_bom_lines(item_id);`,
  },
  { sql: updatedAtTrigger('project_bom_lines') },
  {
    sql: `
        CREATE TABLE capabilities (
          id         TEXT    PRIMARY KEY NOT NULL,
          item_id    TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          key        TEXT    NOT NULL,           -- e.g. 'voltage', 'package'
          value_num  REAL,                       -- numeric magnitude (>/< comparisons)
          value_text TEXT,                        -- text/categorical value (EQUALS/HAS)
          weight     REAL    NOT NULL DEFAULT 1.0, -- relevance/salience (§4 weighted)
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (weight >= 0),
          ${lengthChecks({ key: TEXT_LIMITS.line, value_text: TEXT_LIMITS.line })}
        ) STRICT;
      `,
  },
  { sql: `CREATE INDEX idx_capabilities_item_id ON capabilities(item_id);` },
  {
    sql: `CREATE INDEX idx_capabilities_key ON capabilities(key COLLATE NOCASE);`,
  },
  {
    sql: `CREATE UNIQUE INDEX idx_capabilities_item_key ON capabilities(item_id, key COLLATE NOCASE);`,
  },
  { sql: updatedAtTrigger('capabilities') },
  {
    sql: `
        CREATE VIRTUAL TABLE items_fts USING fts5(
          name, description, notes, mpn, manufacturer, barcode, serial_number,
          content='items',
          content_rowid='rowid'
        );
      `,
  },
  {
    sql: `
        CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
          INSERT INTO items_fts(rowid, name, description, notes, mpn, manufacturer, barcode, serial_number) VALUES (new.rowid, new.name, new.description, new.notes, new.mpn, new.manufacturer, new.barcode, new.serial_number);
        END;
      `,
  },
  {
    sql: `
        CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
          INSERT INTO items_fts(items_fts, rowid, name, description, notes, mpn, manufacturer, barcode, serial_number)
          VALUES ('delete', old.rowid, old.name, old.description, old.notes, old.mpn, old.manufacturer, old.barcode, old.serial_number);
        END;
      `,
  },
  {
    sql: `
        CREATE TRIGGER items_fts_au AFTER UPDATE ON items BEGIN
          INSERT INTO items_fts(items_fts, rowid, name, description, notes, mpn, manufacturer, barcode, serial_number)
          VALUES ('delete', old.rowid, old.name, old.description, old.notes, old.mpn, old.manufacturer, old.barcode, old.serial_number);
          INSERT INTO items_fts(rowid, name, description, notes, mpn, manufacturer, barcode, serial_number) VALUES (new.rowid, new.name, new.description, new.notes, new.mpn, new.manufacturer, new.barcode, new.serial_number);
        END;
      `,
  },
  { sql: `INSERT INTO items_fts(items_fts) VALUES ('rebuild');` },
  {
    sql: `
        CREATE TABLE contacts (
          id           TEXT    PRIMARY KEY NOT NULL,
          name         TEXT    NOT NULL,
          note         TEXT,
          phone_mobile TEXT,
          phone_home   TEXT,
          email        TEXT,
          address      TEXT,
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ name: TEXT_LIMITS.line, note: TEXT_LIMITS.note, phone_mobile: TEXT_LIMITS.line, phone_home: TEXT_LIMITS.line, email: TEXT_LIMITS.line, address: TEXT_LIMITS.note })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE UNIQUE INDEX idx_contacts_name ON contacts(name COLLATE NOCASE);`,
  },
  { sql: updatedAtTrigger('contacts') },
  {
    sql: `
        CREATE TABLE checkouts (
          id             TEXT    PRIMARY KEY NOT NULL,
          item_id        TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          -- The borrower is a TAGGED UNION (B4): a loan targets exactly one of a contact
          -- (a person), a project ("out on the Henderson job") or a location ("in the van").
          -- All three FKs are nullable and the XOR CHECK below enforces that precisely one is
          -- set. Each cascades on the target's delete, mirroring the contact precedent — the
          -- app returns any open loan first (restoring stock) so a delete never strands stock.
          -- NB: a borrower location_id is the loan TARGET, distinct from source_location_id
          -- (the provenance — where the units were lent FROM), added by a later ALTER below.
          contact_id     TEXT    REFERENCES contacts(id)  ON DELETE CASCADE,
          project_id     TEXT    REFERENCES projects(id)  ON DELETE CASCADE,
          location_id    TEXT    REFERENCES locations(id) ON DELETE CASCADE,
          quantity       INTEGER NOT NULL DEFAULT 1,
          due_date       INTEGER,
          checked_out_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          returned_at    INTEGER,
          note           TEXT,
          updated_at     INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (quantity > 0),
          CHECK (returned_at IS NULL OR returned_at >= checked_out_at),
          -- Exactly one borrower: contact XOR project XOR location.
          CHECK (
            (contact_id IS NOT NULL) + (project_id IS NOT NULL) + (location_id IS NOT NULL) = 1
          ),
          ${lengthChecks({ note: TEXT_LIMITS.note })}
        ) STRICT;
      `,
  },
  { sql: `CREATE INDEX idx_checkouts_item_id ON checkouts(item_id);` },
  { sql: `CREATE INDEX idx_checkouts_contact_id ON checkouts(contact_id);` },
  { sql: `CREATE INDEX idx_checkouts_project_id ON checkouts(project_id);` },
  { sql: `CREATE INDEX idx_checkouts_location_id ON checkouts(location_id);` },
  {
    sql: `CREATE INDEX idx_checkouts_open ON checkouts(due_date) WHERE returned_at IS NULL;`,
  },
  { sql: updatedAtTrigger('checkouts') },
  {
    sql: `
        CREATE TABLE tombstones (
          table_name TEXT    NOT NULL,
          id         TEXT    NOT NULL,
          deleted_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          PRIMARY KEY (table_name, id)
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_tombstones_deleted_at ON tombstones(deleted_at);`,
  },
  {
    sql: `
        CREATE TABLE sync_meta (
          id                  INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
          last_sync_timestamp INTEGER NOT NULL DEFAULT 0,
          clock_offset        INTEGER NOT NULL DEFAULT 0,
          updated_at          INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
  },
  {
    sql: `INSERT INTO sync_meta (id, last_sync_timestamp, clock_offset) VALUES (1, 0, 0);`,
  },
  { sql: `ALTER TABLE items ADD COLUMN expiry_date INTEGER;` },
  { sql: `ALTER TABLE items ADD COLUMN batch_number TEXT ${lengthCheck('batch_number', TEXT_LIMITS.line)};` },
  { sql: `ALTER TABLE items ADD COLUMN lot_number TEXT ${lengthCheck('lot_number', TEXT_LIMITS.line)};` },
  {
    sql: `CREATE INDEX idx_items_expiry ON items(expiry_date) WHERE expiry_date IS NOT NULL;`,
  },
  {
    sql: `ALTER TABLE items ADD COLUMN condition TEXT CHECK (condition IS NULL OR condition IN (${conditionList}));`,
  },
  {
    sql: `ALTER TABLE items ADD COLUMN parent_id TEXT REFERENCES items(id);`,
  },
  { sql: `CREATE INDEX idx_items_parent_id ON items(parent_id);` },
  {
    sql: `
        CREATE TABLE maintenance_schedules (
          id                  TEXT    PRIMARY KEY NOT NULL,
          item_id             TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          name                TEXT    NOT NULL,
          basis               TEXT    NOT NULL,
          interval_days       INTEGER,
          interval_usage      REAL,
          usage_unit          TEXT,
          usage_since_service REAL    NOT NULL DEFAULT 0,
          last_performed_at   INTEGER,
          -- Derived due instant for a TIME schedule (issue #325): the app writes
          -- addCalendarDays(COALESCE(last_performed_at, created_at), interval_days) on every
          -- create/service, so a day is a DST-safe calendar day rather than a fixed 86,400,000 ms.
          -- NULL for a USAGE schedule (no calendar due date) and for any row predating this column,
          -- where reads fall back to the fixed-ms expression (see MaintenanceRepository).
          time_due_at         INTEGER,
          note                TEXT,
          created_at          INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at          INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (basis IN (${basisList})),
          CHECK (usage_since_service >= 0),
          -- A TIME schedule needs a positive day interval; a USAGE schedule a
          -- positive usage interval. (DOM-drift-style: never a silent NULL.)
          CHECK (basis <> 'TIME'  OR (interval_days  IS NOT NULL AND interval_days  > 0)),
          CHECK (basis <> 'USAGE' OR (interval_usage IS NOT NULL AND interval_usage > 0)),
          ${lengthChecks({ name: TEXT_LIMITS.line, usage_unit: TEXT_LIMITS.line, note: TEXT_LIMITS.note })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_maintenance_schedules_item_id ON maintenance_schedules(item_id);`,
  },
  { sql: updatedAtTrigger('maintenance_schedules') },
  {
    sql: `ALTER TABLE item_images ADD COLUMN full_res_downgraded_at INTEGER;`,
  },
  {
    sql: `ALTER TABLE sync_meta ADD COLUMN history_pruned_before INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    sql: `ALTER TABLE maintenance_schedules ADD COLUMN accrue_checkout_hours INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    sql: `ALTER TABLE project_bom_lines ADD COLUMN received_qty INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // Per-line "picked" flag (issue #121): marks a BOM line physically gathered during
    // the location-aware picking pass, so kitting a project becomes a walk-and-tick-off
    // task ahead of the one-shot finalise. A transient annotation on the line — not a
    // stock movement — so it needs no ledger entry; it syncs LWW like every other line
    // column.
    sql: `ALTER TABLE project_bom_lines ADD COLUMN picked INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    sql: `
        CREATE TABLE item_stock (
          id          TEXT    PRIMARY KEY NOT NULL,
          item_id     TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          location_id TEXT    NOT NULL REFERENCES locations(id),
          quantity    INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (quantity >= 0),
          UNIQUE (item_id, location_id)
        ) STRICT;
      `,
  },
  { sql: `CREATE INDEX idx_item_stock_item_id ON item_stock(item_id);` },
  {
    sql: `CREATE INDEX idx_item_stock_location_id ON item_stock(location_id);`,
  },
  {
    sql: updatedAtTrigger('item_stock'),
  },
  {
    sql: `
        INSERT INTO item_stock (id, item_id, location_id, quantity, created_at, updated_at)
        SELECT id || '|' || location_id, id, location_id, quantity, created_at, updated_at
        FROM items;
      `,
  },
  {
    sql: `
        CREATE TRIGGER trg_item_stock_recompute_ins
        AFTER INSERT ON item_stock
        FOR EACH ROW
        BEGIN
          UPDATE items
          SET quantity = (SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = NEW.item_id)
          WHERE id = NEW.item_id
            AND quantity <> (SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = NEW.item_id);
        END;
      `,
  },
  {
    sql: `
        CREATE TRIGGER trg_item_stock_recompute_upd
        AFTER UPDATE ON item_stock
        FOR EACH ROW
        BEGIN
          UPDATE items
          SET quantity = (SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = NEW.item_id)
          WHERE id = NEW.item_id
            AND quantity <> (SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = NEW.item_id);
        END;
      `,
  },
  {
    sql: `
        CREATE TRIGGER trg_item_stock_recompute_del
        AFTER DELETE ON item_stock
        FOR EACH ROW
        BEGIN
          UPDATE items
          SET quantity = (SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = OLD.item_id)
          WHERE id = OLD.item_id
            AND quantity <> (SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = OLD.item_id);
        END;
      `,
  },
  {
    sql: `ALTER TABLE checkouts ADD COLUMN source_location_id TEXT REFERENCES locations(id);`,
  },
  {
    sql: `
        CREATE TABLE stock_batches (
          id           TEXT    PRIMARY KEY NOT NULL,
          item_id      TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          location_id  TEXT    NOT NULL REFERENCES locations(id),
          batch_key    TEXT    NOT NULL,
          batch_number TEXT,
          lot_number   TEXT,
          expiry_date  INTEGER,
          quantity     INTEGER NOT NULL DEFAULT 0,
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (quantity >= 0),
          UNIQUE (item_id, location_id, batch_key),
          ${lengthChecks({ batch_number: TEXT_LIMITS.line, lot_number: TEXT_LIMITS.line })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_stock_batches_item_id ON stock_batches(item_id);`,
  },
  {
    sql: `CREATE INDEX idx_stock_batches_location_id ON stock_batches(location_id);`,
  },
  {
    sql: `CREATE INDEX idx_stock_batches_placement ON stock_batches(item_id, location_id);`,
  },
  {
    sql: `CREATE INDEX idx_stock_batches_expiry ON stock_batches(expiry_date);`,
  },
  {
    sql: updatedAtTrigger('stock_batches'),
  },
  {
    sql: `
        INSERT INTO stock_batches (id, item_id, location_id, batch_key, quantity, created_at, updated_at)
        SELECT id || '|', item_id, location_id, '', quantity, created_at, updated_at
        FROM item_stock;
      `,
  },
  {
    sql: `
        CREATE TRIGGER trg_stock_batches_recompute_ins
        AFTER INSERT ON stock_batches
        FOR EACH ROW
        BEGIN
          INSERT INTO item_stock (id, item_id, location_id, quantity)
          VALUES (
            NEW.item_id || '|' || NEW.location_id, NEW.item_id, NEW.location_id,
            (SELECT COALESCE(SUM(quantity), 0) FROM stock_batches
              WHERE item_id = NEW.item_id AND location_id = NEW.location_id)
          )
          ON CONFLICT(id) DO UPDATE SET quantity = excluded.quantity
          WHERE item_stock.quantity <> excluded.quantity;
        END;
      `,
  },
  {
    sql: `
        CREATE TRIGGER trg_stock_batches_recompute_upd
        AFTER UPDATE ON stock_batches
        FOR EACH ROW
        BEGIN
          UPDATE item_stock
          SET quantity = (SELECT COALESCE(SUM(quantity), 0) FROM stock_batches
                           WHERE item_id = NEW.item_id AND location_id = NEW.location_id)
          WHERE id = NEW.item_id || '|' || NEW.location_id
            AND quantity <> (SELECT COALESCE(SUM(quantity), 0) FROM stock_batches
                              WHERE item_id = NEW.item_id AND location_id = NEW.location_id);
        END;
      `,
  },
  {
    sql: `
        CREATE TRIGGER trg_stock_batches_recompute_del
        AFTER DELETE ON stock_batches
        FOR EACH ROW
        BEGIN
          UPDATE item_stock
          SET quantity = (SELECT COALESCE(SUM(quantity), 0) FROM stock_batches
                           WHERE item_id = OLD.item_id AND location_id = OLD.location_id)
          WHERE id = OLD.item_id || '|' || OLD.location_id
            AND quantity <> (SELECT COALESCE(SUM(quantity), 0) FROM stock_batches
                              WHERE item_id = OLD.item_id AND location_id = OLD.location_id);
        END;
      `,
  },
  {
    // The discrete-stock convergence ledger (issue #188). The discrete twin of the gauge's
    // `item_history.net_value_delta`: an append-only, immutable, union-by-id record of every
    // signed change to a `(item, location, batch)` placement's quantity, so reconciliation can
    // replay the id-unioned deltas to converge `stock_batches.quantity` instead of resolving it
    // by last-write-wins (which silently discards one device's concurrent decrement). Rows are
    // written automatically by the capture triggers below, never by hand.
    //
    // `location_id` / `batch_key` are plain columns, not foreign keys: they are the historical
    // coordinates of a movement, and a batch row may legitimately be gone (fully consumed, or its
    // location removed) while its deltas remain — an FK here would either abort a delete or,
    // RESTRICT-style, block one. `item_id` keeps its cascade so an item's deltas retire with it,
    // exactly like `item_history`.
    //
    // `asserted_quantity` is what makes a **physical count** converge correctly (issue #633).
    // Almost every row here is a *relative* movement — "three left this drawer" — and summing the
    // id-union of those is exactly right. A cycle count is not one: it is an *absolute assertion*
    // ("there are 8 of these here"), and recording it as the relative correction it happened to
    // imply means counting the same drawer on two devices before they sync applies **both**
    // corrections, converging on `physical − variance` — a figure neither counter ever saw. So a
    // count's rows carry the quantity that was physically observed, and the replay treats the
    // newest assertion as its base rather than adding it to what came before. NULL on an ordinary
    // movement, which is every row the capture triggers write outside a count.
    sql: `
        CREATE TABLE stock_deltas (
          id                TEXT    PRIMARY KEY NOT NULL,
          item_id           TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          location_id       TEXT    NOT NULL,
          batch_key         TEXT    NOT NULL,
          quantity_delta    INTEGER NOT NULL,
          created_at        INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          asserted_quantity INTEGER
        ) STRICT;
      `,
  },
  { sql: `CREATE INDEX idx_stock_deltas_item_id ON stock_deltas(item_id, created_at);` },
  {
    sql: `CREATE INDEX idx_stock_deltas_placement ON stock_deltas(item_id, location_id, batch_key);`,
  },
  {
    // Immutable, append-only — the ledger's facts never change. Scoped to every column (there is
    // no FK-action column to exempt, unlike `item_history`'s `actor_user_id`); the `items` cascade
    // still retires a row freely, because this guards UPDATE alone and a cascade DELETE is a
    // delete. Not because a foreign-key action skips triggers — it does not.
    sql: `
        CREATE TRIGGER trg_stock_deltas_immutable
        BEFORE UPDATE OF id, item_id, location_id, batch_key, quantity_delta, created_at,
                         asserted_quantity
        ON stock_deltas
        FOR EACH ROW
        BEGIN
          SELECT RAISE(ABORT, 'stock_deltas is an immutable, append-only ledger.');
        END;
      `,
  },
  {
    // Local-only capture switch (issue #188). The capture triggers below record a delta for every
    // `stock_batches` quantity change EXCEPT while this switch is off — which the sync/backup apply
    // turns off around its writes, because the rows it applies already carry their deltas via the
    // unioned `stock_deltas` section (recording a second, local delta would double-count). It is
    // device-local session state: never synced, backed up, cloned, restored or tombstoned, and —
    // like `location_item_counts` — carries no foreign key so a restore's table ordering can never
    // abort on it.
    //
    // `asserting` is the same idea for the other axis (issue #633): while it is on, the delta each
    // trigger writes also records the resulting quantity as an *asserted* one, because the write it
    // is capturing came from a physical count rather than a movement. Only the cycle-count
    // reconciliation turns it on, and only around its own `stock_batches` writes.
    //
    // `operation_key` is the third (issue #696): while it holds a key, each captured delta takes a
    // *derived* id instead of a random one, so the same one-shot operation performed offline on two
    // devices writes the same ledger rows rather than two copies of one movement. See
    // {@link stockDeltaIdExpression} for the derivation and `withOperationKey` for what may set it.
    // The CHECK pins the shape the derivation relies on — a key that held `|` could collide with
    // another operation's id across the segment boundary, and one holding a `%` or `_` would turn
    // the ordinal's `LIKE` prefix into a wildcard that counts other operations' rows.
    sql: `
        CREATE TABLE stock_delta_capture (
          id            INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
          enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          asserting     INTEGER NOT NULL DEFAULT 0 CHECK (asserting IN (0, 1)),
          operation_key TEXT CHECK (operation_key IS NULL OR operation_key NOT GLOB '*[|%_]*')
        ) STRICT;
      `,
  },
  {
    sql: `INSERT INTO stock_delta_capture (id, enabled, asserting, operation_key)
          VALUES (1, 1, 0, NULL);`,
  },
  {
    // Capture a delta for every batch placement that gains stock. `NEW.quantity - 0` on insert;
    // the recompute triggers write `item_stock`/`items`, not `stock_batches`, so this never
    // recurses (recursive_triggers is off). A zero-quantity seed row records nothing.
    //
    // `asserted_quantity` is `NEW.quantity` only while the `asserting` switch is on (issue #633).
    // Only a count naming its own lot asserts, and such a count sets that row absolutely, so the
    // resulting quantity *is* the figure physically observed. NULL otherwise, marking the row an
    // ordinary relative movement.
    //
    // `created_at` is left to the plain clock, deliberately. The replay supersedes everything
    // ordered before an assertion, so ordering is load-bearing here where a plain sum did not care,
    // and the millisecond stamp cannot separate a movement from a count committed in the same
    // instant — see `replayStockQuantity` for what that costs and why nudging an assertion's stamp
    // past the placement's newest row is a worse cure than the disease.
    sql: `
        CREATE TRIGGER trg_stock_batches_capture_ins
        AFTER INSERT ON stock_batches
        FOR EACH ROW
        WHEN NEW.quantity <> 0 AND (SELECT enabled FROM stock_delta_capture WHERE id = 1) = 1
        BEGIN
          INSERT INTO stock_deltas (id, item_id, location_id, batch_key, quantity_delta, asserted_quantity)
          VALUES (${stockDeltaIdExpression('NEW')}, NEW.item_id, NEW.location_id, NEW.batch_key, NEW.quantity,
                  CASE WHEN (SELECT asserting FROM stock_delta_capture WHERE id = 1) = 1
                       THEN NEW.quantity END);
        END;
      `,
  },
  {
    // Capture the actually-applied, CHECK-clamped change on every quantity move. `NEW - OLD` is
    // reality (the `CHECK (quantity >= 0)` has already vetoed any write that would go negative), so
    // every row records a true change whether or not it also asserts a quantity. A ledger written
    // only by this device therefore still sums to its own `stock_batches.quantity` — the three arms
    // together cover every write path, the DELETE arm below closing the one they used to miss
    // (issue #604). That stops being the reconstruction rule once a **merge** brings in another
    // device's assertion, since an assertion replaces the sum before it rather than adding to it —
    // from then on the replay, not the sum, is what reconstructs the row (issue #633; see
    // `replayStockQuantity`).
    sql: `
        CREATE TRIGGER trg_stock_batches_capture_upd
        AFTER UPDATE OF quantity ON stock_batches
        FOR EACH ROW
        WHEN NEW.quantity <> OLD.quantity AND (SELECT enabled FROM stock_delta_capture WHERE id = 1) = 1
        BEGIN
          INSERT INTO stock_deltas (id, item_id, location_id, batch_key, quantity_delta, asserted_quantity)
          VALUES (${stockDeltaIdExpression('NEW')}, NEW.item_id, NEW.location_id, NEW.batch_key,
                  NEW.quantity - OLD.quantity,
                  CASE WHEN (SELECT asserting FROM stock_delta_capture WHERE id = 1) = 1
                       THEN NEW.quantity END);
        END;
      `,
  },
  {
    // Capture the units a *removed* placement was holding (issue #604). Without this arm the
    // ledger keeps the movements that put stock into a batch row and none of the one that took
    // it away, so `stock_batches.quantity == Σ(stock_deltas)` — claimed by the UPDATE arm above,
    // and relied on by `reconcileStock`'s completeness guard — was not true of a deleted placement.
    // `LocationRepository.delete` is the path this matters on. It re-homes the units into the
    // item's Unassigned placement first — an INSERT/UPSERT, which *does* capture — and only then
    // drops the rows it emptied, so the missing half left the two ends of one move unpaired: a
    // positive at the removed location that nothing ever offsets, replicated to every peer and
    // never pruned. `-OLD.quantity` closes it, and the pair now reads as the move it is. The sync
    // tombstone apply performs the same re-home and delete, but the whole apply runs under
    // `withCaptureDisabled` — its deltas travel in the unioned ledger — so no arm fires there, the
    // DELETE arm included.
    //
    // `asserted_quantity` is always NULL here, unlike the two arms above. Emptying a placement is
    // a relative movement whatever the switch says — it is the CHECK-clamped change the row
    // actually underwent — and no path deletes a batch row under a physical count anyway (a count
    // upserts the lot's quantity, zero included; see `setBatchStatement`).
    //
    // The `EXISTS` guard excludes the one delete that must NOT be captured: the `ON DELETE CASCADE`
    // from `items`. SQLite fires an ordinary trigger for a foreign-key action even with
    // `recursive_triggers` off, and by the time the child rows go the parent is already gone — so
    // without the guard, purging an item would try to write a farewell movement whose `item_id` no
    // longer exists and abort the whole delete on the ledger's own foreign key. It is also the
    // right rule on its own terms: a placement that disappears because its *item* did needs no
    // offsetting row, since `stock_deltas.item_id` cascades the ledger away with it. Only a
    // placement removed while its item survives leaves a balance to settle. The wholesale wipes
    // (restore, TTL clone) need no guard here — they run under `withCaptureDisabled`, for the same
    // reason the re-inserts beside them do.
    sql: `
        CREATE TRIGGER trg_stock_batches_capture_del
        AFTER DELETE ON stock_batches
        FOR EACH ROW
        WHEN OLD.quantity <> 0 AND (SELECT enabled FROM stock_delta_capture WHERE id = 1) = 1
             AND EXISTS (SELECT 1 FROM items WHERE id = OLD.item_id)
        BEGIN
          INSERT INTO stock_deltas (id, item_id, location_id, batch_key, quantity_delta, asserted_quantity)
          VALUES (${stockDeltaIdExpression('OLD')}, OLD.item_id, OLD.location_id, OLD.batch_key,
                  -OLD.quantity, NULL);
        END;
      `,
  },
  { sql: `ALTER TABLE checkouts ADD COLUMN source_batch_key TEXT;` },
  // A return keeps its own note, distinct from the checkout `note`, so a return remark
  // never overwrites the loan's own note (both ends retain their text). NULL while open.
  {
    sql: `ALTER TABLE checkouts ADD COLUMN return_note TEXT ${lengthCheck('return_note', TEXT_LIMITS.note)};`,
  },
  {
    sql: `ALTER TABLE maintenance_schedules ADD COLUMN location_id TEXT REFERENCES locations(id);`,
  },
  { sql: `ALTER TABLE item_attachments ADD COLUMN origin_device_id TEXT;` },
  {
    sql: `ALTER TABLE locations ADD COLUMN description TEXT ${lengthCheck('description', TEXT_LIMITS.note)};`,
  },
  { sql: `ALTER TABLE locations ADD COLUMN color TEXT ${lengthCheck('color', TEXT_LIMITS.code)};` },
  { sql: `ALTER TABLE projects ADD COLUMN budget INTEGER;` },
  {
    sql: `
        CREATE TABLE project_budget_categories (
          id         TEXT    PRIMARY KEY NOT NULL,
          project_id TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name       TEXT    NOT NULL,
          amount     INTEGER NOT NULL DEFAULT 0,             -- money: integer micro-units (issue #286)
          position   INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (amount >= 0),
          ${lengthChecks({ name: TEXT_LIMITS.line })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_project_budget_categories_project_id
              ON project_budget_categories(project_id, position);`,
  },
  { sql: updatedAtTrigger('project_budget_categories') },
  {
    sql: `
        CREATE TABLE project_expenses (
          id          TEXT    PRIMARY KEY NOT NULL,
          project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          category_id TEXT    REFERENCES project_budget_categories(id) ON DELETE SET NULL,
          description TEXT,
          amount      INTEGER NOT NULL DEFAULT 0,            -- money: integer micro-units (issue #286)
          incurred_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          created_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (amount >= 0),
          ${lengthChecks({ description: TEXT_LIMITS.line })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_project_expenses_project_id
              ON project_expenses(project_id, incurred_at);`,
  },
  {
    sql: `CREATE INDEX idx_project_expenses_category_id ON project_expenses(category_id);`,
  },
  { sql: updatedAtTrigger('project_expenses') },
  { sql: `ALTER TABLE items ADD COLUMN reorder_point INTEGER;` },
  { sql: `ALTER TABLE items ADD COLUMN reorder_gauge_percent REAL;` },
  { sql: `ALTER TABLE items ADD COLUMN reorder_qty INTEGER;` },
  {
    sql: `
        -- Suppliers are a first-class entity so that a supplier's name, URL and currency
        -- live in exactly one place. Before this, both supplier_parts and purchase_orders
        -- carried an independent free-text name, so the same supplier spelled two ways was
        -- two unrelated strings with no way to rename or merge them.
        --
        -- Deliberately NOT folded into contacts: contacts are people-shaped (phone_mobile,
        -- phone_home, address) and are the borrower side of a checkout. Overloading them
        -- would leave half the columns null on either side and force every borrower picker
        -- to filter suppliers back out.
        CREATE TABLE suppliers (
          id         TEXT    PRIMARY KEY NOT NULL,
          name       TEXT    NOT NULL,
          -- Derived from name by supplierNameKey(): case-folded, diacritics stripped, all
          -- punctuation and spacing removed. Stored rather than computed so uniqueness is a
          -- DB guarantee and resolve-or-create is a single indexed lookup. SQLite's NOCASE
          -- collation folds only ASCII case, which would still let "RS Components" and
          -- "RS-Components" coexist — exactly the duplicate this table exists to prevent.
          -- Every write goes through SupplierRepository, which is what keeps it in sync.
          name_key   TEXT    NOT NULL,
          url        TEXT,
          currency   TEXT,
          note       TEXT,
          created_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ name: TEXT_LIMITS.line, name_key: TEXT_LIMITS.line, url: TEXT_LIMITS.url, currency: TEXT_LIMITS.code, note: TEXT_LIMITS.note })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE UNIQUE INDEX idx_suppliers_name_key ON suppliers(name_key);`,
  },
  {
    // Sort order for the supplier list; the uniqueness guarantee lives on name_key above.
    sql: `CREATE INDEX idx_suppliers_name ON suppliers(name COLLATE NOCASE);`,
  },
  { sql: updatedAtTrigger('suppliers') },
  {
    sql: `
        CREATE TABLE supplier_parts (
          id            TEXT    PRIMARY KEY NOT NULL,
          item_id       TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          -- CASCADE: a supplier part is that supplier's price for an item, so it is
          -- meaningless once the supplier is gone. Contrast purchase_orders below.
          supplier_id   TEXT    NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
          order_code    TEXT,
          unit_cost     INTEGER,                             -- money: integer micro-units (issue #286)
          currency      TEXT,
          pack_qty      INTEGER,
          min_order_qty INTEGER,
          price_breaks  TEXT,
          url           TEXT,
          is_preferred  INTEGER NOT NULL DEFAULT 0,
          is_price_source INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (is_preferred IN (0, 1)),
          CHECK (is_price_source IN (0, 1)),
          CHECK (unit_cost IS NULL OR unit_cost >= 0),
          CHECK (pack_qty IS NULL OR pack_qty > 0),
          CHECK (min_order_qty IS NULL OR min_order_qty > 0),
          ${lengthChecks({ order_code: TEXT_LIMITS.line, currency: TEXT_LIMITS.code, price_breaks: TEXT_LIMITS.payload, url: TEXT_LIMITS.url })}
        ) STRICT;
      `,
  },
  {
    // No UNIQUE (item_id, supplier_id): one supplier legitimately offers the same item under
    // several order codes or pack sizes, and each is its own row.
    sql: `CREATE INDEX idx_supplier_parts_item_id
              ON supplier_parts(item_id, is_preferred DESC, supplier_id);`,
  },
  {
    // Drives the supplier-side reads: a supplier's parts, and the RESTRICT check on delete.
    sql: `CREATE INDEX idx_supplier_parts_supplier_id ON supplier_parts(supplier_id);`,
  },
  {
    // At most one preferred and one price-source supplier part per item — enforced at the
    // schema level, not just by the app's demote-then-set writes (issues #157, #192). Two
    // offline devices that each pin a *different* supplier converge, per-row LWW, to two rows
    // both flagged; the sync engine's cross-row repair (`reconcile`) demotes all but one
    // deterministic winner before the merge applies, and these partial indexes are the backstop
    // that keeps any path — an app bug, a hand-written import — from re-introducing the state.
    sql: `CREATE UNIQUE INDEX idx_supplier_parts_one_preferred
              ON supplier_parts(item_id) WHERE is_preferred = 1;`,
  },
  {
    sql: `CREATE UNIQUE INDEX idx_supplier_parts_one_price_source
              ON supplier_parts(item_id) WHERE is_price_source = 1;`,
  },
  { sql: updatedAtTrigger('supplier_parts') },
  {
    sql: `
        CREATE TABLE purchase_orders (
          id            TEXT    PRIMARY KEY NOT NULL,
          -- Nullable + SET NULL, unlike supplier_parts' CASCADE: a purchase order is a record
          -- of money spent, so deleting a supplier must not delete the order — it just loses
          -- the link and reads as an unknown supplier.
          --
          -- SET NULL rather than RESTRICT specifically because of sync. RESTRICT cannot express
          -- a distributed delete: device A legally deletes a supplier it sees as unused while
          -- device B records an order against it, and whichever device merges second aborts its
          -- whole transaction on the foreign key — sync hard-blocks rather than degrades.
          -- Resurrecting the supplier instead just moves the failure, since A has already
          -- published the tombstone and would re-delete on its next pass. A nullable FK is the
          -- one shape that converges: it is the same choice checkouts.source_location_id makes.
          supplier_id   TEXT    REFERENCES suppliers(id) ON DELETE SET NULL,
          reference     TEXT,
          status        TEXT    NOT NULL DEFAULT 'DRAFT',
          currency      TEXT,
          created_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ordered_at    INTEGER,
          updated_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (status IN (${purchaseOrderStatusList})),
          ${lengthChecks({ reference: TEXT_LIMITS.line, currency: TEXT_LIMITS.code })}
        ) STRICT;
      `,
  },
  {
    sql: `
        CREATE TABLE purchase_order_lines (
          id               TEXT    PRIMARY KEY NOT NULL,
          po_id            TEXT    NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
          item_id          TEXT    REFERENCES items(id) ON DELETE SET NULL,
          supplier_part_id TEXT    REFERENCES supplier_parts(id) ON DELETE SET NULL,
          description      TEXT,
          ordered_qty      INTEGER NOT NULL,
          received_qty     INTEGER NOT NULL DEFAULT 0,
          unit_cost        INTEGER,                          -- money: integer micro-units (issue #286)
          created_at       INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at       INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (ordered_qty > 0),
          CHECK (received_qty >= 0),
          CHECK (unit_cost IS NULL OR unit_cost >= 0),
          ${lengthChecks({ description: TEXT_LIMITS.line })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_purchase_order_lines_po_id ON purchase_order_lines(po_id);`,
  },
  {
    sql: `CREATE INDEX idx_purchase_order_lines_item_id ON purchase_order_lines(item_id);`,
  },
  {
    sql: `CREATE INDEX idx_purchase_orders_supplier_id ON purchase_orders(supplier_id);`,
  },
  { sql: updatedAtTrigger('purchase_orders') },
  { sql: updatedAtTrigger('purchase_order_lines') },
  { sql: `ALTER TABLE items ADD COLUMN acquired_at TEXT;` },
  { sql: `ALTER TABLE items ADD COLUMN warranty_expires_at TEXT;` },
  {
    sql: `ALTER TABLE items ADD COLUMN purchase_price INTEGER CHECK (purchase_price IS NULL OR purchase_price >= 0);`,
  },
  {
    sql: `ALTER TABLE items ADD COLUMN depreciation_months INTEGER CHECK (depreciation_months IS NULL OR depreciation_months > 0);`,
  },
  // --- Intrinsic physical weight (issue #25) -----------------------------------
  // An item's mass, stored canonically in GRAMS (a single REAL column) so weights are
  // directly comparable and summable across items regardless of the unit the user reads
  // them in — the display/entry unit is the `weightUnit` preference, applied only at the
  // edges. Nullable (no weight set); non-negative, mirroring the unit_cost CHECK.
  {
    sql: `ALTER TABLE items ADD COLUMN weight REAL CHECK (weight IS NULL OR weight >= 0);`,
  },
  // --- Intrinsic physical dimensions (issue #30) -------------------------------
  // An item's bounding box: width, height and depth, each stored canonically in
  // MILLIMETRES (a REAL column apiece) so dimensions are directly comparable across
  // items regardless of the unit the user reads them in — the display/entry unit is the
  // `dimensionUnit` preference, applied only at the edges. Each is nullable (not tracked)
  // and non-negative, mirroring the weight CHECK.
  {
    sql: `ALTER TABLE items ADD COLUMN width REAL CHECK (width IS NULL OR width >= 0);`,
  },
  {
    sql: `ALTER TABLE items ADD COLUMN height REAL CHECK (height IS NULL OR height >= 0);`,
  },
  {
    sql: `ALTER TABLE items ADD COLUMN depth REAL CHECK (depth IS NULL OR depth >= 0);`,
  },
  // --- Folded former v2: asset bookings (Phase 78) ------------------------------
  {
    sql: `
        CREATE TABLE asset_bookings (
          id                    TEXT    PRIMARY KEY NOT NULL,
          item_id               TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          contact_id            TEXT    REFERENCES contacts(id) ON DELETE SET NULL,
          start_date            INTEGER NOT NULL,            -- midnight-UTC day-start UNIX-ms (inclusive)
          end_date              INTEGER NOT NULL,            -- midnight-UTC day-start UNIX-ms (inclusive)
          note                  TEXT,
          cancelled_at          INTEGER,                     -- set ⇒ derived 'cancelled'
          converted_checkout_id TEXT,                        -- set ⇒ derived 'converted' (soft pointer, not FK)
          created_at            INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at            INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (end_date >= start_date),
          ${lengthChecks({ note: TEXT_LIMITS.note })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_asset_bookings_item_id ON asset_bookings(item_id, start_date);`,
  },
  {
    sql: `CREATE INDEX idx_asset_bookings_start_date ON asset_bookings(start_date);`,
  },
  { sql: updatedAtTrigger('asset_bookings') },
  // --- Folded former v3: supplier price history (Phase 81) ----------------------
  {
    sql: `
        CREATE TABLE supplier_part_price_history (
          id               TEXT    PRIMARY KEY NOT NULL,
          supplier_part_id TEXT    NOT NULL REFERENCES supplier_parts(id) ON DELETE CASCADE,
          unit_cost        INTEGER NOT NULL,                  -- recorded cost at recorded_at (micro-units, issue #286)
          currency         TEXT,                              -- null ⇒ base currency
          source           TEXT    NOT NULL DEFAULT 'MANUAL', -- PRICE_HISTORY_SOURCES (see the CHECK)
          recorded_at      INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at       INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (unit_cost >= 0),
          CHECK (source IN (${priceHistorySourceList})),
          ${lengthChecks({ currency: TEXT_LIMITS.code })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_supplier_part_price_history_part
              ON supplier_part_price_history(supplier_part_id, recorded_at);`,
  },
  { sql: updatedAtTrigger('supplier_part_price_history') },
  // --- Folded former v4: richer location metadata -------------------------------
  { sql: `ALTER TABLE locations ADD COLUMN icon TEXT ${lengthCheck('icon', TEXT_LIMITS.code)};` },
  {
    sql: `ALTER TABLE locations ADD COLUMN capacity INTEGER CHECK (capacity IS NULL OR capacity >= 0);`,
  },
  {
    sql: `ALTER TABLE locations ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));`,
  },
  {
    // At most one location carries `is_default` — enforced at the schema level, not just by the
    // app's demote-then-set writes (issue #191). Two offline devices that each nominate a
    // *different* default converge, per-row LWW, to two rows both flagged (their demote-UPDATEs
    // touched different siblings, so neither is seen across the merge). The sync engine's cross-row
    // repair (`reconcile`) demotes all but one deterministic winner before the merge applies, and
    // this partial index is the backstop that keeps any path — an app bug, a hand-written import —
    // from re-introducing the state. `is_default` is a *global* single-default, so the index is
    // over the flag column alone: every indexed row shares the value 1, so uniqueness admits one.
    sql: `CREATE UNIQUE INDEX idx_locations_one_default ON locations(is_default) WHERE is_default = 1;`,
  },
  { sql: `ALTER TABLE locations ADD COLUMN archived_at INTEGER;` },
  // --- Stock-take G1: durable "last counted" timestamp -------------------------
  { sql: `ALTER TABLE locations ADD COLUMN last_counted_at INTEGER;` },
  // --- Kits / bundles (v1: definition + availability) ---------------------------
  // A kit is a reusable many-to-many item→component definition: the `kit_item_id`
  // item is *composed of* `quantity` units of each `component_item_id` item (e.g. a
  // first-aid kit = 2 bandages + 1 scissors). Distinct from variants (child SKUs of
  // one identity) and a project BOM (transient work). Both FKs cascade-delete from
  // `items`, so deleting either the kit or a component prunes the edge. The
  // self-reference CHECK blocks the trivial one-hop cycle; deeper transitive cycles
  // are rejected by the repository's recursive-CTE validator (a DB CHECK cannot walk
  // the graph). In SYNC_TABLES: an edge carries its own `updated_at` + auto-stamp trigger, so it
  // travels with the snapshot and the portable backup by ordinary row-level LWW (issue #151).
  {
    sql: `
        CREATE TABLE kit_components (
          id                TEXT    PRIMARY KEY NOT NULL,
          kit_item_id       TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          component_item_id TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          quantity          INTEGER NOT NULL DEFAULT 1,
          sort              INTEGER NOT NULL DEFAULT 0,
          created_at        INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at        INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (quantity > 0),
          CHECK (kit_item_id <> component_item_id),
          UNIQUE (kit_item_id, component_item_id)
        ) STRICT;
      `,
  },
  { sql: `CREATE INDEX idx_kit_components_kit_item_id ON kit_components(kit_item_id, sort);` },
  {
    sql: `CREATE INDEX idx_kit_components_component_item_id ON kit_components(component_item_id);`,
  },
  { sql: updatedAtTrigger('kit_components') },
  // --- Folded former v2: partial index on items.warranty_expires_at -------------
  // Most items carry no warranty date, so the index is partial (mirrors idx_items_expiry):
  // the warranty-attention probe / listWarrantyExpiring / alert centre seek the small set
  // that actually has one rather than scanning the whole items table.
  {
    sql: `CREATE INDEX idx_items_warranty ON items(warranty_expires_at) WHERE warranty_expires_at IS NOT NULL;`,
  },
  // --- Folded former v3: partial index on items(location_id) WHERE is_active = 1 -
  // The hot per-location active-stock reads emit `WHERE is_active = 1 AND location_id = ?`.
  // Encoding `is_active = 1` in the index's WHERE (rather than a composite second column)
  // keeps it single-column and makes the no-stats planner prefer it for exactly this query.
  {
    sql: `CREATE INDEX idx_items_active_location ON items(location_id) WHERE is_active = 1;`,
  },
  // --- Folded former v4: manual current value + revaluation log (feature-gap G9) -
  // Additive: a live manual per-unit value on items, plus an append-only LWW log of the
  // valuation points that set it (value can move up or down, independent of depreciation).
  {
    sql: `ALTER TABLE items ADD COLUMN current_value INTEGER CHECK (current_value IS NULL OR current_value >= 0);`,
  },
  {
    sql: `
        CREATE TABLE revaluations (
          id          TEXT    PRIMARY KEY NOT NULL,
          item_id     TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          value       INTEGER NOT NULL,                    -- recorded per-unit value at revalued_at (micro-units, issue #286)
          revalued_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}), -- effective date of the valuation (UNIX-ms)
          note        TEXT,
          created_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (value >= 0),
          ${lengthChecks({ note: TEXT_LIMITS.note })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_revaluations_item_id ON revaluations(item_id, revalued_at);`,
  },
  {
    sql: updatedAtTrigger('revaluations'),
  },
  // --- Folded former v5: related-items cross-links (feature-gap G6) --------------
  // A synced many-to-many relation between items, distinct from variants (items.parent_id)
  // and kits. Deterministic `from|to|kind` primary key so two devices minting the same
  // logical relation converge by LWW.
  //
  // `kind` carries NO CHECK, deliberately and for the same reason as the `webhooks` JSON
  // columns below: a constraint that rejects a row on hydration would let one value from a
  // newer peer — a kind that release simply added — abort a whole sync apply, instead of
  // costing that one relation. The vocabulary is `RELATION_KINDS`
  // (`features/inventory/item-relations.ts`); the mapper keeps an unknown kind verbatim so it
  // round-trips, and the display seam (`describeItemRelations`) filters what this build does
  // not understand. Deliberately not restated here: the list moved once already while this
  // comment still claimed the old one. `enum-checks.test.ts` asserts the column stays
  // unconstrained, so adding a CHECK is a decision, not a slip.
  {
    sql: `
        CREATE TABLE item_relations (
          id           TEXT    PRIMARY KEY NOT NULL,   -- canonical "from|to|kind" (deterministic)
          from_item_id TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          to_item_id   TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          kind         TEXT    NOT NULL,               -- RELATION_KINDS; no CHECK (see note above)
          note         TEXT,                           -- optional free-text context for the link
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (from_item_id <> to_item_id),
          ${lengthChecks({ kind: TEXT_LIMITS.line, note: TEXT_LIMITS.note })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_item_relations_from ON item_relations(from_item_id);`,
  },
  {
    sql: `CREATE INDEX idx_item_relations_to ON item_relations(to_item_id);`,
  },
  {
    sql: updatedAtTrigger('item_relations'),
  },
  // --- Folded former v6: manual "to-buy" / wishlist (feature-gap G8) -------------
  // A standalone dictionary table (no FK, like contacts/projects) of wanted-but-not-owned
  // things. `priority` carries no CHECK for the sync-forward reason given on
  // `item_relations.kind` above; its vocabulary is `WISHLIST_PRIORITIES`
  // (`features/purchasing/wishlist.ts`), softened on read by `normaliseWishlistPriority`.
  {
    sql: `
        CREATE TABLE wishlist (
          id           TEXT    PRIMARY KEY NOT NULL,
          name         TEXT    NOT NULL,
          note         TEXT,                           -- optional free-text context
          url          TEXT,                           -- optional http(s) link (app-sanitised)
          target_price INTEGER CHECK (target_price IS NULL OR target_price >= 0), -- money: micro-units (issue #286)
          priority     TEXT    NOT NULL DEFAULT 'NONE', -- WISHLIST_PRIORITIES; no CHECK (see note)
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ name: TEXT_LIMITS.line, note: TEXT_LIMITS.note, url: TEXT_LIMITS.url, priority: TEXT_LIMITS.code })}
        ) STRICT;
      `,
  },
  {
    sql: updatedAtTrigger('wishlist'),
  },
  // --- Folded former v7: per-instance test / calibration / service records (G7) --
  // An append-only LWW child of items (structured pass/fail + reading log per serialised
  // unit). `kind` and `result` carry no CHECK for the sync-forward reason given on
  // `item_relations.kind` above; their vocabularies are `TEST_RECORD_KINDS` and
  // `TEST_RESULTS` (`features/inventory/test-records.ts`), softened on read by
  // `normaliseTestRecordKind` / `normaliseTestResult`. `reading` is deliberately
  // unconstrained (may be negative).
  {
    sql: `
        CREATE TABLE test_records (
          id           TEXT    PRIMARY KEY NOT NULL,
          item_id      TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          kind         TEXT    NOT NULL DEFAULT 'TEST',   -- TEST_RECORD_KINDS; no CHECK (see note)
          name         TEXT    NOT NULL,                  -- the check / test name
          result       TEXT    NOT NULL DEFAULT 'PASS',   -- TEST_RESULTS; no CHECK (see note)
          reading      REAL,                              -- optional measured value (may be negative)
          unit         TEXT,                              -- optional unit for the reading (e.g. "MΩ")
          note         TEXT,
          performed_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}), -- effective date of the record (UNIX-ms)
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ kind: TEXT_LIMITS.line, name: TEXT_LIMITS.line, result: TEXT_LIMITS.line, unit: TEXT_LIMITS.line, note: TEXT_LIMITS.note })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_test_records_item_id ON test_records(item_id, performed_at);`,
  },
  {
    sql: updatedAtTrigger('test_records'),
  },

  // --- Saved container tares (issue #94) -----------------------------------------
  // A small library of "what does this container weigh empty" entries the user can pull
  // into any tare field instead of typing the number from memory each time. Tare is
  // already a first-class concept — `items.tare_weight` for a CONSUMABLE_GAUGE, and the
  // per-reading tare of a weigh-in — so this table holds only the *reusable* value, never
  // a second copy of an item's own tare.
  //
  // `tare_grams` is canonical **grams**, exactly like `items.weight` (issue #25), so a
  // preset stays comparable regardless of the unit the user reads it in.
  //
  // The app also ships a built-in catalogue of common spools and containers in code
  // (`features/inventory/tare-presets.ts`). Those are NOT seeded here: they are reference
  // values that improve with each release, and seeding them would freeze one release's
  // numbers into every database and sync them between devices as if the user had measured
  // them. This table is only ever what *this user* saved — which is also why it is a plain
  // independent LWW leaf with no FK, like `wishlist`.
  //
  // `kind` carries no CHECK for the sync-forward reason given on `item_relations.kind`
  // above; its vocabulary is `TARE_PRESET_KINDS` (`features/inventory/tare-presets.ts`),
  // softened on read by `normaliseTarePresetKind`.
  {
    sql: `
        CREATE TABLE tare_presets (
          id         TEXT    PRIMARY KEY NOT NULL,
          name       TEXT    NOT NULL,                  -- what the user calls it ("Flour jar")
          brand      TEXT,                              -- optional maker, for spools bought by brand
          kind       TEXT    NOT NULL DEFAULT 'OTHER',  -- TARE_PRESET_KINDS; no CHECK (see note)
          tare_grams REAL    NOT NULL CHECK (tare_grams >= 0),
          note       TEXT,
          created_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ name: TEXT_LIMITS.line, brand: TEXT_LIMITS.line, kind: TEXT_LIMITS.line, note: TEXT_LIMITS.note })}
        ) STRICT;
      `,
  },
  {
    sql: updatedAtTrigger('tare_presets'),
  },

  // --- Dead-stock reporting opt-in (issue #92) ------------------------------------
  // Flagging stock that has not moved for a long time is opt-in: an inventory where
  // everything is reported is noise. Both columns default to 'inherit', so an untouched
  // database reports nothing until the user asks for it — on an item, or on a location so
  // that everything stored there is covered without touching each item.
  //
  // `locations.dead_stock_days` is deliberately independent of the mode: a location can set
  // a house threshold ("anything in deep storage is dead after a year") without also opting
  // its contents in. NULL defers up the tree, and ultimately to the global preference.
  // The resolution rules live in the pure `features/reports/dead-stock` seam.
  {
    sql: `ALTER TABLE items ADD COLUMN dead_stock_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (dead_stock_mode IN (${deadStockModeList}));`,
  },
  {
    sql: `ALTER TABLE locations ADD COLUMN dead_stock_mode TEXT NOT NULL DEFAULT 'inherit' CHECK (dead_stock_mode IN (${deadStockModeList}));`,
  },
  {
    sql: `ALTER TABLE locations ADD COLUMN dead_stock_days INTEGER CHECK (dead_stock_days IS NULL OR dead_stock_days > 0);`,
  },
  // --- Volumetric locations (issue #457) ---------------------------------------
  // A location's internal size: width, height and depth, each stored canonically in
  // MILLIMETRES (a REAL column apiece) exactly as an item's bounding box is (issue #30),
  // so a container's dimensions are directly comparable with the items placed in it — the
  // display/entry unit is the `dimensionUnit` preference, applied only at the edges. Each is
  // nullable (not measured) and non-negative, mirroring the item dimension CHECKs. From these
  // a usable internal volume is derived; `usable_volume` is an optional explicit override for a
  // container that isn't a perfect box (a bag, a bin with sloped walls), stored canonically in
  // cubic MILLIMETRES (mm³), and `packing_factor` is an optional per-location packing-efficiency
  // fraction (0 < f ≤ 1). Both default NULL (derive from W×H×D / defer to the global preference).
  // Phase 1 ships the W×H×D entry UI only; the two override columns sit NULL until Phase 2.
  {
    sql: `ALTER TABLE locations ADD COLUMN width REAL CHECK (width IS NULL OR width >= 0);`,
  },
  {
    sql: `ALTER TABLE locations ADD COLUMN height REAL CHECK (height IS NULL OR height >= 0);`,
  },
  {
    sql: `ALTER TABLE locations ADD COLUMN depth REAL CHECK (depth IS NULL OR depth >= 0);`,
  },
  {
    sql: `ALTER TABLE locations ADD COLUMN usable_volume REAL CHECK (usable_volume IS NULL OR usable_volume >= 0);`,
  },
  {
    sql: `ALTER TABLE locations ADD COLUMN packing_factor REAL CHECK (packing_factor IS NULL OR (packing_factor > 0 AND packing_factor <= 1));`,
  },
  // --- Walk order: a location's position on a physical picking sweep (issue #461) --------
  // An optional, non-negative ordinal placing this location on the route a user walks when
  // gathering a project's parts — "by the door" (1) before "far shelving" (9). The picking
  // worksheet presents each part and its locations in ascending walk order so a multi-item
  // pick is one fluid sweep rather than a back-and-forth. NULL = unplaced, which sorts after
  // every placed location, so the worksheet's long-standing busiest-first order is exactly
  // what remains until a user assigns any walk order. A deliberately lightweight alternative
  // to physical X/Y/Z coordinates + pathfinding: no graph to maintain, themable to any space.
  {
    sql: `ALTER TABLE locations ADD COLUMN walk_order INTEGER CHECK (walk_order IS NULL OR walk_order >= 0);`,
  },
  // --- Custom-field value attribution: which device recorded it (#621, W1g) --------------
  // The device a custom-field value was authored on, as `lib/env/device-id` supplies it —
  // the same identity, and the same NULL-means-unattributed rule, as the older
  // `item_attachments.origin_device_id` above. It exists for one reader: a `FILE` value
  // holding a *path* is only meaningful on the device that can reach that path, so a value
  // synced from elsewhere has to be able to say so instead of showing a dead string.
  //
  // Stamped on **every** literal value write rather than only on a `FILE` one, and carrying
  // no CHECK. Both follow from where the column sits: a value row holds only `def_id`, so
  // the field's type lives in another table — which puts a `field_type` CHECK (the shape
  // `due_lead_days`, `unit`, `min_value`, `max_value` and `precision` all take on
  // `field_defs`) out of reach, since a CHECK may not reference another row. What is stored
  // is therefore the plain fact of the write; deciding it *matters* is the render boundary's
  // job (`inventory/device-origin.ts`), which is also why an unrecognised value can do no
  // harm and a peer's whole sync apply must never fail over one (`categories.field_prominence`
  // and `field_defs.prominence` take that same position).
  //
  // Not an FK: a device id is a synthetic identity with no row to point at, exactly as the
  // attachments column is — so no `FK_REFS` entry. It *does* sync (it is absent from
  // `SYNC_EXCLUDED_COLUMNS`), because comparing it against the reading device is the whole
  // point of storing it.
  { sql: `ALTER TABLE item_field_values ADD COLUMN origin_device_id TEXT;` },
  { sql: `ALTER TABLE location_field_values ADD COLUMN origin_device_id TEXT;` },
  // The report filters to opted-in items, so the mode is a selective predicate on a
  // table that grows to 100k+ rows. A partial index keeps it off the full scan while
  // costing nothing for the overwhelmingly common 'inherit' default.
  {
    sql: `CREATE INDEX idx_items_dead_stock_mode ON items(dead_stock_mode) WHERE dead_stock_mode <> 'inherit';`,
  },

  // --- Webhook subscriptions (issue #87) ------------------------------------------
  // "Call this URL when this happens." The app *configures* subscriptions here and syncs
  // them like any other user record; the **bridge** is the sole deliverer (it reads them
  // from the database it already hydrates), because a browser cannot reliably reach the
  // endpoints users actually own — CSP pins the outbound origin list at build time, a
  // signed cross-origin POST is preflighted and most receivers send no CORS headers, an
  // HTTPS page cannot call a plain-`http` LAN box, and nothing delivers with the tab shut.
  //
  // An independent LWW leaf with no FK, exactly like `wishlist` / `tare_presets`: a
  // subscription is about *events*, not about any one item, category or location, so
  // narrowing is expressed by the declarative `filter` rather than by a foreign key that
  // would delete the subscription along with whatever it happened to point at.
  //
  // The JSON-bearing columns (`event_types`, `filter`, `headers`) are opaque TEXT here and
  // parsed at the repository boundary. SQLite could validate them with `json_valid()`, but a
  // CHECK that rejects a row on hydration would let one malformed value from a peer break a
  // whole sync apply; the mapper softens instead, so a bad payload costs that one field.
  //
  // The signing secret is deliberately two columns, not one (plan §6.1):
  //  · `secret_ref` — the *name* of a secret held in the bridge's git-ignored config. The
  //    recommended option and the one the UI steers to: the value never enters the database,
  //    and therefore never enters the sync artefact (which by design sits on a NAS or in a
  //    cloud drive) or a backup.
  //  · `secret` — the value itself, for zero-setup convenience. It travels with synced data,
  //    which the UI and the wiki must say plainly.
  // The CHECK enforces "at most one of the two": a row carrying both would leave which
  // secret actually signs a delivery ambiguous. Neither is legal — an unsigned webhook to a
  // trusted LAN endpoint is a reasonable thing to want.
  //
  // No index: this table holds a handful of rows per user and every read is a full list
  // (the bridge takes the whole enabled set on each hydrate), so an index on `enabled` would
  // be write cost for a scan the planner would skip anyway.
  {
    sql: `
        CREATE TABLE webhooks (
          id          TEXT    PRIMARY KEY NOT NULL,
          name        TEXT    NOT NULL,                  -- user label, e.g. "Home Assistant"
          url         TEXT    NOT NULL,                  -- absolute http(s) endpoint
          method      TEXT    NOT NULL DEFAULT 'POST',
          enabled     INTEGER NOT NULL DEFAULT 1,
          secret      TEXT,                              -- HMAC secret held in-row (syncs!)
          secret_ref  TEXT,                              -- name of a bridge-side secret (preferred)
          event_types TEXT    NOT NULL,                  -- JSON array of dotted types, or ["*"]
          filter      TEXT,                              -- JSON filter expression, or NULL (all)
          template    TEXT,                              -- payload template, or NULL (default envelope)
          headers     TEXT,                              -- JSON object of extra static headers
          created_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (method IN (${webhookMethodList})),
          CHECK (enabled IN (0, 1)),
          CHECK (secret IS NULL OR secret_ref IS NULL),
          ${lengthChecks({ name: TEXT_LIMITS.line, url: TEXT_LIMITS.url, secret_ref: TEXT_LIMITS.line, event_types: TEXT_LIMITS.payload, filter: TEXT_LIMITS.payload, template: TEXT_LIMITS.payload, headers: TEXT_LIMITS.payload })}
        ) STRICT;
      `,
  },
  {
    sql: updatedAtTrigger('webhooks'),
  },

  // --- Shared settings: preferences that travel live between devices (issue #382) -
  //
  // The user's preferences live in `localStorage` as one Zustand blob per store, which is the
  // right home for them: they hydrate synchronously before first paint, work offline, and cost
  // no query. What that shape cannot do is *reconcile*. Sync resolves rows by Last-Write-Wins on
  // a per-row `updated_at`, and a blob is one opaque string with no per-preference identity — so
  // syncing it wholesale would mean changing the theme on a phone silently discarded the alert
  // threshold tuned on a desktop, because the two edits are the same "row".
  //
  // This table is that missing identity, and *only* that: one row per (store, preference), so
  // each preference reconciles on its own timestamp against the same preference on every other
  // device. It is a shared noticeboard, not the source of truth — the stores still read and write
  // `localStorage`, a device publishes a row when the user changes an eligible preference, and
  // applies a row a peer wrote when a sync brings a newer one in. Nothing here is required for
  // the app to work: with settings sync off (the shipped default) the table simply stays empty.
  //
  // `id` is *derived* — `<store key>#<field>` — rather than a random UUID, so the same preference
  // is the same row id on every device without any coordination. That is what makes LWW resolve
  // "my theme" against "your theme" instead of accumulating one row per device, and it is why the
  // table needs no `UNIQUE_KEY_SPECS` entry (there is no random id for a unique-key collision to
  // reconcile). `store_key` and `field` are stored alongside rather than re-split from `id` at
  // every read: `#` is legal inside a field name, so the split is not reliably reversible.
  //
  // `value` is the JSON encoding of one preference value — a string, number, boolean, array or
  // object. It arrives from a peer, so it is untrusted: the apply path shape-checks it against
  // the value the store currently holds and drops anything that doesn't match, exactly as a
  // restored backup's settings are trusted only as far as the stores' own read-side normalising.
  // No CHECK on it for the reason webhooks' JSON columns carry none: one malformed value from a
  // peer must cost that one preference, not abort the whole sync apply.
  //
  // Deliberately NOT here: the `device` settings group (bridge address, kiosk mode, snooze
  // timestamps) and the bridge access token. See `features/backup/settings-groups.ts`, which owns
  // the eligibility answer for both this and the backup file.
  //
  // No index: a device holds at most a few dozen rows and every read is the whole table.
  {
    sql: `
        CREATE TABLE settings (
          id         TEXT    PRIMARY KEY NOT NULL,  -- '<store key>#<field>' — derived, identical on every device
          store_key  TEXT    NOT NULL,              -- the persisted store, e.g. 'gubbins:preferences'
          field      TEXT    NOT NULL,              -- the preference's field name within that store
          value      TEXT    NOT NULL,              -- JSON encoding of the value (app-validated on apply)
          created_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
  },
  {
    sql: updatedAtTrigger('settings'),
  },

  // --- Location photos & item regions (issue #81) --------------------------------
  //
  // A photo of a location, onto which named *regions* are drawn; items reference a region
  // many-to-many. A region is a place ("Top shelf") that exists independently of what is in
  // it, which is why the link is a join table rather than an `item_id` on the region: the
  // layer beneath already lets one item sit in several locations (`item_stock`'s UNIQUE is
  // per item+location *pair*), so forcing one position per item would contradict it.
  //
  // Storage mirrors `item_images` exactly, including the §4.2.1 Anti-Base64 Directive: the
  // full-resolution WebP is a raw OPFS file and only its path is stored here, while a tiny
  // WebP `thumbnail_blob` lives in the row so a peer can render without the original. The
  // blob column keeps that exact name deliberately — `features/sync/blob-codec.ts` matches
  // on it by name, and a differently-named column would not error, it would silently sync a
  // corrupt `{"0":…}` object.
  {
    sql: `
        CREATE TABLE location_photos (
          id                     TEXT    PRIMARY KEY NOT NULL,
          location_id            TEXT    NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
          caption                TEXT,
          thumbnail_blob         BLOB,
          full_res_opfs_path     TEXT    NOT NULL,
          full_res_downgraded_at INTEGER,
          natural_width          INTEGER NOT NULL,
          natural_height         INTEGER NOT NULL,
          position               INTEGER NOT NULL DEFAULT 0,
          created_at             INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at             INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ caption: TEXT_LIMITS.line })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_location_photos_location_id ON location_photos(location_id, position);`,
  },
  { sql: updatedAtTrigger('location_photos') },

  // `natural_width`/`natural_height` are stored rather than read from the image because
  // region geometry is normalised: rendering the overlay needs the aspect ratio *before* the
  // full-res file decodes, and on a peer device that file may never arrive at all (only the
  // thumbnail syncs). Without them the overlay would jump into place on load.
  {
    sql: `
        CREATE TABLE location_regions (
          id         TEXT    PRIMARY KEY NOT NULL,
          photo_id   TEXT    NOT NULL REFERENCES location_photos(id) ON DELETE CASCADE,
          name       TEXT    NOT NULL,
          shape      TEXT    NOT NULL CHECK (shape IN (${regionShapeList})),
          geometry   TEXT    NOT NULL,
          color      TEXT,
          position   INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ${lengthChecks({ name: TEXT_LIMITS.line, geometry: TEXT_LIMITS.payload, color: TEXT_LIMITS.code })}
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_location_regions_photo_id ON location_regions(photo_id, position);`,
  },
  { sql: updatedAtTrigger('location_regions') },

  // The M:N link. Deliberately carries **no timestamps**, exactly like `location_tags`: it is
  // reconciled by *membership* (2P-set — union minus edge tombstones), not Last-Write-Wins,
  // and the membership path writes `INSERT OR IGNORE` over the key columns alone. A
  // `created_at` here would look harmless but would silently re-default on every peer apply.
  {
    sql: `
        CREATE TABLE item_regions (
          item_id   TEXT NOT NULL REFERENCES items(id)            ON DELETE CASCADE,
          region_id TEXT NOT NULL REFERENCES location_regions(id) ON DELETE CASCADE,
          PRIMARY KEY (item_id, region_id)
        ) STRICT;
      `,
  },
  // The reverse lookup ("which regions hold this item?") drives the item-side panel; the
  // composite PK already covers the forward direction.
  {
    sql: `CREATE INDEX idx_item_regions_region_id ON item_regions(region_id);`,
  },

  // --- Per-location live item counts (issue #167) ---------------------------------
  // The sidebar tree shows an item count beside every location, and it used to derive them
  // with `locations LEFT JOIN items … GROUP BY l.id` — an aggregate over the *whole* items
  // table. Most item writes invalidate the tree, so the count of every location was recomputed
  // from scratch on each create, move and delete: O(items) work on a hot path that only ever
  // needs O(locations) numbers.
  //
  // This is the counter that replaces it, maintained incrementally by the triggers below so a
  // read is a bounded join and a write touches one row. It is **derived state, not data**:
  // nothing else may write it, it is not synced, and it carries no timestamps — a peer's copy
  // of a count would be meaningless, and the triggers re-derive it from whatever rows a
  // restore or a sync apply lands in `items`.
  //
  // Deliberately **no foreign key** to `locations`. A restore inserts tables in an order this
  // table has no say in, so an FK here could abort one (see the snapshot FK-integrity work) for
  // a row that is pure cache. A count for a location that no longer exists is instead swept by
  // the locations delete trigger, and unreachable anyway — every read starts from `locations`.
  {
    sql: `
        CREATE TABLE location_item_counts (
          location_id TEXT    PRIMARY KEY NOT NULL,
          item_count  INTEGER NOT NULL DEFAULT 0,
          CHECK (item_count >= 0)
        ) STRICT;
      `,
  },
  // Seeds the counter from whatever is already in `items`. A no-op on a fresh database (the
  // baseline builds an empty one), but it keeps the table's contents a pure function of `items`
  // at every point in the DDL rather than something that only becomes true once a trigger fires.
  {
    sql: `
        INSERT INTO location_item_counts (location_id, item_count)
        SELECT location_id, COUNT(*) FROM items WHERE is_active = 1 GROUP BY location_id;
      `,
  },
  {
    sql: `
        CREATE TRIGGER trg_location_item_counts_ins
        AFTER INSERT ON items
        FOR EACH ROW WHEN NEW.is_active = 1
        BEGIN
          INSERT INTO location_item_counts (location_id, item_count) VALUES (NEW.location_id, 1)
          ON CONFLICT (location_id) DO UPDATE SET item_count = item_count + 1;
        END;
      `,
  },
  {
    sql: `
        CREATE TRIGGER trg_location_item_counts_del
        AFTER DELETE ON items
        FOR EACH ROW WHEN OLD.is_active = 1
        BEGIN
          UPDATE location_item_counts
          SET item_count = MAX(item_count - 1, 0)
          WHERE location_id = OLD.location_id;
        END;
      `,
  },
  // An update only matters when it changes which bucket the row belongs to — its location, or
  // whether it counts at all (`is_active`, i.e. the soft delete and its undo). Both sides are
  // guarded so a move between two locations decrements the old and increments the new, while a
  // soft delete in place only decrements.
  {
    sql: `
        CREATE TRIGGER trg_location_item_counts_upd
        AFTER UPDATE ON items
        FOR EACH ROW WHEN OLD.location_id IS NOT NEW.location_id OR OLD.is_active IS NOT NEW.is_active
        BEGIN
          UPDATE location_item_counts
          SET item_count = MAX(item_count - 1, 0)
          WHERE OLD.is_active = 1 AND location_id = OLD.location_id;

          INSERT INTO location_item_counts (location_id, item_count)
          SELECT NEW.location_id, 1 WHERE NEW.is_active = 1
          ON CONFLICT (location_id) DO UPDATE SET item_count = item_count + 1;
        END;
      `,
  },
  // Keeps the cache from outliving what it counts. Locations are deleted rarely and re-parent
  // their items to Unassigned first, so by the time this fires the count is already 0.
  {
    sql: `
        CREATE TRIGGER trg_location_item_counts_sweep
        AFTER DELETE ON locations
        FOR EACH ROW
        BEGIN
          DELETE FROM location_item_counts WHERE location_id = OLD.id;
        END;
      `,
  },
];

/** The fingerprint of the DDL above — see {@link baselineFingerprint}. */
export const BASELINE_REVISION = baselineFingerprint(baselineStatements);

export const v1Initial: Migration = {
  version: 1,
  name: 'initial-baseline',
  statements: [
    ...baselineStatements,
    // --- Baseline fingerprint stamp (issue #84) ------------------------------------
    // Records which revision of this squashed baseline built the database, so boot can tell a
    // current database from one built by an *older* revision of v1 — both of which read as
    // `user_version = 1`. Derived from the DDL, so editing the baseline updates it
    // automatically. Data, not DDL, so the golden-equivalence schema snapshot is unaffected.
    {
      sql: `INSERT INTO app_meta (key, value) VALUES (?, ?);`,
      params: [BASELINE_REVISION_KEY, BASELINE_REVISION],
    },
  ],
};
