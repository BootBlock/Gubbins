import {
  ADMIN_USER_DISPLAY_NAME,
  ADMIN_USER_ID,
  ADMIN_USER_USERNAME,
  ATTACHMENT_KINDS,
  CONDITIONS,
  COSTING_MODES,
  DEAD_STOCK_MODES,
  FIELD_TYPES,
  IN_TRANSIT_LOCATION_ID,
  IN_TRANSIT_LOCATION_NAME,
  MAINTENANCE_BASES,
  PROCUREMENT_STATUSES,
  PROJECT_STATUSES,
  REGION_SHAPES,
  RESERVATION_STATUSES,
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
 * the behaviour LWW reconciliation needs. The stamp is now `MAX(now, OLD.updated_at + 1)` so an
 * edit is always strictly newer than the row it derived from even when the wall clock is too
 * coarse to show it — see {@link updatedAtTrigger}. Every syncable table now uses that one
 * helper (the six that formerly inlined an identical trigger were folded onto it), so the
 * monotonic guarantee can never again be applied to some tables and missed on others.
 */

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
 */
function updatedAtTrigger(table: string): string {
  return `
    CREATE TRIGGER trg_${table}_updated_at
    AFTER UPDATE ON ${table}
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE ${table} SET updated_at = MAX((${SQL_NOW_MS}), OLD.updated_at + 1) WHERE id = NEW.id;
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
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
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
          CHECK (is_builtin IN (0, 1))
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
          )
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
        CREATE TRIGGER trg_users_protect_builtin_update
        BEFORE UPDATE ON users
        FOR EACH ROW
        WHEN OLD.kind IN ('system', 'admin')
        BEGIN
          SELECT RAISE(ABORT, 'The built-in System and Admin users cannot be modified.');
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
        INSERT INTO users (id, username, display_name, kind, is_enabled)
        VALUES (?, ?, ?, 'system', 0);
      `,
    params: [SYSTEM_USER_ID, SYSTEM_USER_USERNAME, SYSTEM_USER_DISPLAY_NAME],
  },
  {
    sql: `
        INSERT INTO users (id, username, display_name, kind, is_enabled)
        VALUES (?, ?, ?, 'admin', 1);
      `,
    params: [ADMIN_USER_ID, ADMIN_USER_USERNAME, ADMIN_USER_DISPLAY_NAME],
  },
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
          updated_at              INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (default_tracking_mode IS NULL OR default_tracking_mode IN (${trackingModeList})),
          CHECK (default_condition IS NULL OR default_condition IN (${conditionList})),
          CHECK (default_warranty_months IS NULL OR default_warranty_months > 0),
          CHECK (default_maintenance_basis IS NULL OR default_maintenance_basis IN (${basisList})),
          CHECK (default_maintenance_interval_days IS NULL OR default_maintenance_interval_days > 0),
          CHECK (default_maintenance_interval_usage IS NULL OR default_maintenance_interval_usage > 0)
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
          CHECK (is_system IN (0, 1))
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
          CHECK (attrition_percent IS NULL OR tracking_mode = 'CONSUMABLE_GAUGE')
        ) STRICT;
      `,
  },
  { sql: `CREATE INDEX idx_items_location_id ON items(location_id);` },
  { sql: `CREATE INDEX idx_items_category_id ON items(category_id);` },
  { sql: `CREATE INDEX idx_items_is_active ON items(is_active);` },
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
          -- and it must not require an UPDATE the immutability trigger would refuse — SQLite
          -- applies FK actions internally without firing triggers (recursive_triggers is off).
          actor_user_id   TEXT    NOT NULL DEFAULT '${SYSTEM_USER_ID}'
                                  REFERENCES users(id) ON DELETE SET DEFAULT,
          created_at      INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_item_history_item_id ON item_history(item_id, created_at);`,
  },
  { sql: `CREATE INDEX idx_item_history_actor_user_id ON item_history(actor_user_id);` },
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
    sql: `
        CREATE TABLE field_defs (
          id          TEXT    PRIMARY KEY NOT NULL,
          name        TEXT    NOT NULL,
          field_type  TEXT    NOT NULL,
          options     TEXT,                            -- JSON array for SELECT fields
          description TEXT,                            -- optional help note shown on the control
          updated_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (field_type IN (${fieldTypeList}))
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
          CHECK (is_required IN (0, 1))
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
          CHECK (is_inheritable IN (0, 1))
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
          CHECK (mode IN ('literal', 'inherit')),
          CHECK (mode <> 'inherit' OR value IS NULL)
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
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
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
          CHECK (kind IN (${attachmentKindList}))
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_item_attachments_item_id ON item_attachments(item_id, position);`,
  },
  { sql: updatedAtTrigger('item_attachments') },
  { sql: `ALTER TABLE items ADD COLUMN mpn TEXT;` },
  { sql: `ALTER TABLE items ADD COLUMN manufacturer TEXT;` },
  { sql: `ALTER TABLE items ADD COLUMN unit_cost REAL;` },
  { sql: `CREATE INDEX idx_items_mpn ON items(mpn COLLATE NOCASE);` },
  // Retail barcode (GTIN — EAN/UPC): an item's own scannable article code, distinct
  // from the MPN and stored verbatim as printed. Indexed for the scanner's exact
  // lookup-by-barcode, and (below) FTS-indexed like the MPN so a barcode typed into
  // the main search finds its item.
  { sql: `ALTER TABLE items ADD COLUMN barcode TEXT;` },
  { sql: `CREATE INDEX idx_items_barcode ON items(barcode COLLATE NOCASE);` },
  // Intrinsic serial number (issue #90): the maker's unique per-unit identifier printed on
  // the article (distinct from `serial_no`, which is only a SERIALISED-clone instance index).
  // Stored verbatim; indexed for exact lookup and (below) FTS-indexed like the barcode so a
  // serial typed into the main search finds its item.
  { sql: `ALTER TABLE items ADD COLUMN serial_number TEXT;` },
  { sql: `CREATE INDEX idx_items_serial_number ON items(serial_number COLLATE NOCASE);` },
  {
    sql: `
        CREATE TABLE item_aliases (
          id         TEXT    PRIMARY KEY NOT NULL,
          item_id    TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          alias      TEXT    NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
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
          CHECK (costing_mode IN (${costingModeList}))
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
          unit_cost_snapshot REAL,
          position           INTEGER NOT NULL DEFAULT 0,
          created_at         INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at         INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (required_qty >= 0),
          CHECK (reserved_qty >= 0),
          CHECK (reservation_status IN (${reservationStatusList})),
          CHECK (procurement_status IN (${procurementStatusList}))
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
          CHECK (weight >= 0)
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
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
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
          )
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
  { sql: `ALTER TABLE items ADD COLUMN batch_number TEXT;` },
  { sql: `ALTER TABLE items ADD COLUMN lot_number TEXT;` },
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
          note                TEXT,
          created_at          INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at          INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (basis IN (${basisList})),
          CHECK (usage_since_service >= 0),
          -- A TIME schedule needs a positive day interval; a USAGE schedule a
          -- positive usage interval. (DOM-drift-style: never a silent NULL.)
          CHECK (basis <> 'TIME'  OR (interval_days  IS NOT NULL AND interval_days  > 0)),
          CHECK (basis <> 'USAGE' OR (interval_usage IS NOT NULL AND interval_usage > 0))
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
          UNIQUE (item_id, location_id, batch_key)
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
  { sql: `ALTER TABLE checkouts ADD COLUMN source_batch_key TEXT;` },
  // A return keeps its own note, distinct from the checkout `note`, so a return remark
  // never overwrites the loan's own note (both ends retain their text). NULL while open.
  { sql: `ALTER TABLE checkouts ADD COLUMN return_note TEXT;` },
  {
    sql: `ALTER TABLE maintenance_schedules ADD COLUMN location_id TEXT REFERENCES locations(id);`,
  },
  { sql: `ALTER TABLE item_attachments ADD COLUMN origin_device_id TEXT;` },
  { sql: `ALTER TABLE locations ADD COLUMN description TEXT;` },
  { sql: `ALTER TABLE locations ADD COLUMN color TEXT;` },
  { sql: `ALTER TABLE projects ADD COLUMN budget REAL;` },
  {
    sql: `
        CREATE TABLE project_budget_categories (
          id         TEXT    PRIMARY KEY NOT NULL,
          project_id TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name       TEXT    NOT NULL,
          amount     REAL    NOT NULL DEFAULT 0,
          position   INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (amount >= 0)
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
          amount      REAL    NOT NULL DEFAULT 0,
          incurred_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          created_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (amount >= 0)
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
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
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
          unit_cost     REAL,
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
          CHECK (min_order_qty IS NULL OR min_order_qty > 0)
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
          CHECK (status IN ('DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'))
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
          unit_cost        REAL,
          created_at       INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at       INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (ordered_qty > 0),
          CHECK (received_qty >= 0),
          CHECK (unit_cost IS NULL OR unit_cost >= 0)
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
    sql: `ALTER TABLE items ADD COLUMN purchase_price REAL CHECK (purchase_price IS NULL OR purchase_price >= 0);`,
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
          start_date            INTEGER NOT NULL,            -- day-start UNIX-ms (inclusive)
          end_date              INTEGER NOT NULL,            -- day-start UNIX-ms (inclusive)
          note                  TEXT,
          cancelled_at          INTEGER,                     -- set ⇒ derived 'cancelled'
          converted_checkout_id TEXT,                        -- set ⇒ derived 'converted' (soft pointer, not FK)
          created_at            INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at            INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (end_date >= start_date)
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
          unit_cost        REAL    NOT NULL,                  -- the recorded cost at recorded_at
          currency         TEXT,                              -- null ⇒ base currency
          source           TEXT    NOT NULL DEFAULT 'MANUAL', -- 'MANUAL' | 'SCRAPE'
          recorded_at      INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at       INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (unit_cost >= 0),
          CHECK (source IN ('MANUAL', 'SCRAPE'))
        ) STRICT;
      `,
  },
  {
    sql: `CREATE INDEX idx_supplier_part_price_history_part
              ON supplier_part_price_history(supplier_part_id, recorded_at);`,
  },
  { sql: updatedAtTrigger('supplier_part_price_history') },
  // --- Folded former v4: richer location metadata -------------------------------
  { sql: `ALTER TABLE locations ADD COLUMN kind TEXT;` },
  {
    sql: `ALTER TABLE locations ADD COLUMN capacity INTEGER CHECK (capacity IS NULL OR capacity >= 0);`,
  },
  {
    sql: `ALTER TABLE locations ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));`,
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
  // the graph). Not in SYNC_TABLES for v1 — kit definitions are device-local until the
  // assemble/disassemble v2 work, which is when their propagation is designed.
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
    sql: `ALTER TABLE items ADD COLUMN current_value REAL CHECK (current_value IS NULL OR current_value >= 0);`,
  },
  {
    sql: `
        CREATE TABLE revaluations (
          id          TEXT    PRIMARY KEY NOT NULL,
          item_id     TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          value       REAL    NOT NULL,                    -- the recorded per-unit value at revalued_at
          revalued_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}), -- effective date of the valuation (UNIX-ms)
          note        TEXT,
          created_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (value >= 0)
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
  // logical relation converge by LWW; `kind` is app-enforced free TEXT (no DB CHECK).
  {
    sql: `
        CREATE TABLE item_relations (
          id           TEXT    PRIMARY KEY NOT NULL,   -- canonical "from|to|kind" (deterministic)
          from_item_id TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          to_item_id   TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          kind         TEXT    NOT NULL,               -- WORKS_WITH | ACCESSORY_FOR | SPARE_FOR (app-enforced)
          note         TEXT,                           -- optional free-text context for the link
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (from_item_id <> to_item_id)
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
  // things; `priority` is app-enforced free TEXT (HIGH | MEDIUM | LOW | NONE), default NONE.
  {
    sql: `
        CREATE TABLE wishlist (
          id           TEXT    PRIMARY KEY NOT NULL,
          name         TEXT    NOT NULL,
          note         TEXT,                           -- optional free-text context
          url          TEXT,                           -- optional http(s) link (app-sanitised)
          target_price REAL    CHECK (target_price IS NULL OR target_price >= 0),
          priority     TEXT    NOT NULL DEFAULT 'NONE', -- HIGH | MEDIUM | LOW | NONE (app-enforced)
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
  },
  {
    sql: updatedAtTrigger('wishlist'),
  },
  // --- Folded former v7: per-instance test / calibration / service records (G7) --
  // An append-only LWW child of items (structured pass/fail + reading log per serialised
  // unit). `kind` (TEST | CALIBRATION | SERVICE) and `result` (PASS | FAIL | LIMIT | NA)
  // are app-enforced free TEXT; `reading` is deliberately unconstrained (may be negative).
  {
    sql: `
        CREATE TABLE test_records (
          id           TEXT    PRIMARY KEY NOT NULL,
          item_id      TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          kind         TEXT    NOT NULL DEFAULT 'TEST',   -- TEST | CALIBRATION | SERVICE (app-enforced)
          name         TEXT    NOT NULL,                  -- the check / test name
          result       TEXT    NOT NULL DEFAULT 'PASS',   -- PASS | FAIL | LIMIT | NA (app-enforced)
          reading      REAL,                              -- optional measured value (may be negative)
          unit         TEXT,                              -- optional unit for the reading (e.g. "MΩ")
          note         TEXT,
          performed_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}), -- effective date of the record (UNIX-ms)
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
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
  {
    sql: `
        CREATE TABLE tare_presets (
          id         TEXT    PRIMARY KEY NOT NULL,
          name       TEXT    NOT NULL,                  -- what the user calls it ("Flour jar")
          brand      TEXT,                              -- optional maker, for spools bought by brand
          kind       TEXT    NOT NULL DEFAULT 'OTHER',  -- SPOOL | JAR | BIN | TRAY | OTHER (app-enforced)
          tare_grams REAL    NOT NULL CHECK (tare_grams >= 0),
          note       TEXT,
          created_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
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
          CHECK (secret IS NULL OR secret_ref IS NULL)
        ) STRICT;
      `,
  },
  {
    sql: updatedAtTrigger('webhooks'),
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
          updated_at             INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
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
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
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
