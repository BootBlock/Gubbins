/**
 * The OPFS database file name — deliberately a **leaf module with no imports**.
 *
 * Main-thread code (Safe Mode's rescue actions, the restore paths) needs this name to
 * reach the database file through OPFS directly, but must never pull in SQLite itself:
 * the main thread only talks to the database worker over RPC. Declaring the constant
 * beside {@link ../db/worker/sqlite-bootstrap} would make importing the name enough to
 * drag the whole `@sqlite.org/sqlite-wasm` emscripten glue (~200 KB) into the importing
 * chunk, duplicating what already ships in the worker bundles (issue #165).
 *
 * Keep this module free of imports so that stays true.
 */

/** The single database file within the OPFS hierarchy. */
export const DB_FILENAME = '/gubbins.sqlite3';
