/**
 * Checks every `driver.query<TRow>(sql)` in the read layer against what SQLite will actually
 * return (issue #356).
 *
 * `IDatabaseDriver.query<TRow>` is an unverified assertion. The worker casts `selectObjects(...)`
 * to `SqlRow[]`, the value crosses structured clone untouched, and nothing anywhere compares the
 * declared `TRow` against the statement that produced it — so the ~280 call sites pairing a
 * hand-written SELECT with a hand-written row interface are related only by the author's care. Add
 * a column to the interface without adding it to the SQL and the compiler asserts a property that
 * is `undefined` at runtime. That is the one place in this repository where "the compiler cannot
 * catch the lie" is systemic rather than local, and until now the guarantee rested on review alone.
 *
 * This closes it mechanically, without touching a single call site. SQLite already knows the
 * answer: prepare a statement and `columns()` reports exactly the names its result rows will be
 * keyed by — wildcards expanded, aliases applied, compound SELECTs resolved to their leftmost arm.
 * So the test builds the real baseline schema in memory, walks the sources with the TypeScript
 * compiler API to pair each call's `TRow` with its SQL text, prepares the statement, and fails when
 * a declared property is not among the columns coming back.
 *
 * Preparing also checks the SQL against the schema for free: a table or column that does not exist
 * is a prepare error, so a statement left behind by a rename now fails the build rather than the
 * user's screen.
 *
 * ## What it can and cannot see
 *
 * A statement assembled at runtime has no single text to prepare, so each `${…}` in a template is
 * resolved as far as it can be, in three steps:
 *
 * 1. **Constant-folded** — the compiler knows the span's type is a string literal.
 * 2. **Evaluated** — the span names an exported module constant (the shared projection fragments in
 *    `repositories/item/sql.ts`, say), whose value the test reads by importing the module. That
 *    covers `ITEM_READ_COLUMNS`, the projection behind every item read and the largest hand-written
 *    row interface in the repository.
 * 3. **Substituted** — a placeholder expression stands in for what is genuinely decided at runtime.
 *    A placeholder is trusted only when the statement prepares *identically* under two different
 *    placeholders: if the substitution reached the projection, the two runs disagree about the
 *    column names, and the site is recorded as unverified rather than guessed at.
 *
 * Whatever is left — SQL held in a variable, or placeholders that will not prepare — stays
 * unverified, and the ratchet below keeps that population from quietly growing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '@/db/migrations';
import { runMigrations } from '@/db/migrations/engine';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { repoPath } from '@/test/repo-path';

/**
 * The checkout this test file lives in — never `process.cwd()`.
 *
 * Everything below is resolved from here: the tsconfig, the swept sources, and the module paths
 * `resolveConstants` imports. A cwd-relative root would let a run started from a sibling checkout
 * sweep *that* tree's queries while the schema and repository code come from this one — a green
 * run proving nothing about the change under review.
 */
const ROOT = repoPath(import.meta.dirname);

/** The app's own config — it already excludes test files, whose ad-hoc SQL is not the read layer. */
const TSCONFIG = 'tsconfig.app.json';

/**
 * The structural signature of a database driver.
 *
 * Matching on shape rather than on a named type covers the interface, the worker bridge class and
 * the in-worker shim alike, and needs no allow-list to keep up with a fourth implementation.
 */
const DRIVER_MEMBERS = ['query', 'queryOne', 'execute', 'transaction'] as const;

/**
 * Stand-ins for a `${…}` whose value is genuinely decided at runtime.
 *
 * Both are constant expressions valid wherever a bound parameter or a sub-expression goes. Neither
 * is an integer literal, which `ORDER BY` would read as an ordinal. They must differ from each
 * other: disagreement between the two is precisely how a substitution that reached the projection
 * gets caught.
 */
const PLACEHOLDERS = ['NULL', "''"] as const;

/**
 * Ratchet on the statements this cannot reach — pinned to the current population, with no slack.
 * Lower it when a site becomes verifiable; raising it means a new query has been written in a shape
 * no automated check can see, which should be a deliberate decision rather than a drive-by.
 */
const MAX_UNVERIFIED = 28;

/** Floor on the sweep, so a walk that finds nothing reports a failure rather than "all clear". */
const MIN_SITES = 250;

/**
 * Floor on coverage, so deleting queries can never be mistaken for improving it, and so widening a
 * row type to `SqlRow` cannot quietly opt a statement out of the check.
 *
 * Today's sweep: 283 sites — 249 verified, 28 unverified, 6 declaring no columns to check. The few
 * sites of slack are for a read that is legitimately removed, not for coverage to erode.
 */
const MIN_VERIFIED = 245;

/** A `${…}` span, resolved as far as the compiler alone can take it. */
type Span =
  /** The compiler knows the exact text. */
  | { readonly kind: 'literal'; readonly value: string }
  /** A reference to an exported module constant, to be read by importing the module. */
  | { readonly kind: 'constant'; readonly module: string; readonly name: string }
  /** Genuinely decided at runtime. */
  | { readonly kind: 'runtime' };

/** One `query<TRow>` / `queryOne<TRow>` call, before its `${…}` spans have been resolved. */
interface QuerySite {
  readonly where: string;
  /** Property names of the declared `TRow`. */
  readonly declared: readonly string[];
  /** The template's literal chunks; always one more than `spans`. Empty when the SQL is opaque. */
  readonly chunks: readonly string[];
  readonly spans: readonly Span[];
  /** Set when the argument is not a literal at all — a variable, a conditional, a property read. */
  readonly opaque: string | null;
}

/** Builds a `Program` over the application sources and pairs every driver read with its SQL. */
function collectQuerySites(): QuerySite[] {
  const config = ts.readConfigFile(path.join(ROOT, TSCONFIG), (file) => readFileSync(file, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();

  const sites: QuerySite[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const relative = path.relative(ROOT, source.fileName).replaceAll('\\', '/');
    // Type resolution pulls in `node_modules` declarations; only our own sources hold call sites.
    if (!relative.startsWith('src/')) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const rowTypeNode = driverReadRowType(node, checker);
        if (rowTypeNode !== null) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          sites.push({
            where: `${relative}:${line}`,
            // A row type with only an index signature (`SqlRow`) declares nothing to check.
            declared: checker
              .getPropertiesOfType(checker.getTypeFromTypeNode(rowTypeNode))
              .map((property) => property.getName()),
            ...readSql(node.arguments[0], checker),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

/**
 * The `TRow` type node of a `query` / `queryOne` call on something driver-shaped, else `null`.
 */
function driverReadRowType(call: ts.CallExpression, checker: ts.TypeChecker): ts.TypeNode | null {
  const rowType = call.typeArguments?.length === 1 ? call.typeArguments[0] : undefined;
  if (rowType === undefined) return null;
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const method = call.expression.name.text;
  if (method !== 'query' && method !== 'queryOne') return null;
  const receiver = checker.getTypeAtLocation(call.expression.expression);
  return DRIVER_MEMBERS.every((member) => receiver.getProperty(member) !== undefined) ? rowType : null;
}

/** Splits the SQL argument into its literal chunks and its unresolved spans. */
function readSql(
  argument: ts.Expression | undefined,
  checker: ts.TypeChecker,
): Pick<QuerySite, 'chunks' | 'spans' | 'opaque'> {
  if (argument === undefined) return { chunks: [], spans: [], opaque: 'no SQL argument' };

  if (ts.isStringLiteralLike(argument)) {
    return { chunks: [argument.text], spans: [], opaque: null };
  }

  if (ts.isTemplateExpression(argument)) {
    const chunks = [argument.head.text, ...argument.templateSpans.map((span) => span.literal.text)];
    const spans = argument.templateSpans.map((span) => readSpan(span.expression, checker));
    return { chunks, spans, opaque: null };
  }

  return { chunks: [], spans: [], opaque: ts.SyntaxKind[argument.kind] };
}

/** Resolves one `${…}` to a literal, a named module constant, or "decided at runtime". */
function readSpan(expression: ts.Expression, checker: ts.TypeChecker): Span {
  const type = checker.getTypeAtLocation(expression);
  if (type.isStringLiteral()) return { kind: 'literal', value: type.value };

  // A shared SQL fragment built from a helper call widens to `string`, so the compiler cannot fold
  // it — but the module can simply be imported and the value read. Only a plain identifier is
  // followed: anything computed at the call site is a runtime decision by definition.
  if (ts.isIdentifier(expression)) {
    const declaration = exportedConstantOf(expression, checker);
    // The *declared* name, not the one at the call site, is what the module exports — the two
    // differ under a renaming import.
    if (declaration !== null && ts.isIdentifier(declaration.name)) {
      return {
        kind: 'constant',
        module: declaration.getSourceFile().fileName,
        name: declaration.name.text,
      };
    }
  }
  return { kind: 'runtime' };
}

/**
 * The **exported, module-scope** `const` an identifier resolves to, following imports; `null` for
 * anything else.
 *
 * Both halves of that are load-bearing, because the value is looked up later by `(module, name)`
 * off the module's exports. A function-local `const` shares a file with the module's exports but
 * not their namespace, so accepting one would mean reading an unrelated export that happens to
 * share its name — splicing the wrong text into the statement and reporting the site verified
 * against SQL that never runs. Rejecting it here is what keeps `(module, name)` an honest key.
 */
function exportedConstantOf(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
): ts.VariableDeclaration | null {
  let symbol = checker.getSymbolAtLocation(identifier);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.declarations?.[0];
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return null;

  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null;

  const statement = list.parent;
  if (!ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) return null;
  const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  return exported === true ? declaration : null;
}

/** Reads the runtime value of every module constant the sweep needs, keyed by `module#name`. */
async function resolveConstants(sites: readonly QuerySite[]): Promise<Map<string, string>> {
  const wanted = new Map<string, Set<string>>();
  for (const site of sites) {
    for (const span of site.spans) {
      if (span.kind !== 'constant') continue;
      const names = wanted.get(span.module) ?? new Set<string>();
      names.add(span.name);
      wanted.set(span.module, names);
    }
  }

  const values = new Map<string, string>();
  for (const [module, names] of wanted) {
    let exports: Record<string, unknown>;
    try {
      exports = (await import(/* @vite-ignore */ pathToFileURL(module).href)) as Record<string, unknown>;
    } catch {
      // Not importable in isolation — the spans fall back to a placeholder.
      continue;
    }
    for (const name of names) {
      const value = exports[name];
      if (typeof value === 'string') values.set(constantKey(module, name), value);
    }
  }
  return values;
}

function constantKey(module: string, name: string): string {
  return `${module}#${name}`;
}

/** The statement text(s) to prepare for a site, once its spans are as resolved as they will get. */
type SqlSource =
  /** One exact statement: every span was a literal or a resolved constant. */
  | { readonly kind: 'exact'; readonly sql: string }
  /** One statement per placeholder; trusted only if they agree on the column names. */
  | { readonly kind: 'substituted'; readonly variants: readonly string[] }
  | { readonly kind: 'opaque'; readonly reason: string };

function buildSql(site: QuerySite, constants: ReadonlyMap<string, string>): SqlSource {
  if (site.opaque !== null) return { kind: 'opaque', reason: site.opaque };

  const resolved = site.spans.map((span) => {
    if (span.kind === 'literal') return span.value;
    if (span.kind === 'constant') return constants.get(constantKey(span.module, span.name)) ?? null;
    return null;
  });

  const assemble = (placeholder: string): string =>
    site.chunks.reduce(
      (text, chunk, index) => (index === 0 ? chunk : text + (resolved[index - 1] ?? placeholder) + chunk),
      '',
    );

  if (resolved.every((value) => value !== null)) return { kind: 'exact', sql: assemble('') };
  return { kind: 'substituted', variants: PLACEHOLDERS.map(assemble) };
}

/** The names SQLite will key this statement's rows by, or `null` if it will not prepare. */
function preparedColumns(driver: MemoryDriver, sql: string): readonly string[] | null {
  try {
    return driver.raw
      .prepare(sql)
      .columns()
      .map((column) => column.name);
  } catch {
    return null;
  }
}

/** What checking one site concluded. */
type SiteResult =
  | { readonly kind: 'verified'; readonly columns: readonly string[] }
  | { readonly kind: 'no-declared-columns' }
  | { readonly kind: 'unpreparable'; readonly sql: string }
  | { readonly kind: 'unverified'; readonly reason: string };

function checkSite(
  driver: MemoryDriver,
  site: QuerySite,
  constants: ReadonlyMap<string, string>,
): SiteResult {
  if (site.declared.length === 0) return { kind: 'no-declared-columns' };

  const sql = buildSql(site, constants);
  if (sql.kind === 'opaque') return { kind: 'unverified', reason: `SQL is a ${sql.reason}` };

  if (sql.kind === 'exact') {
    const columns = preparedColumns(driver, sql.sql);
    return columns === null ? { kind: 'unpreparable', sql: sql.sql } : { kind: 'verified', columns };
  }

  const prepared: (readonly string[])[] = [];
  for (const variant of sql.variants) {
    const columns = preparedColumns(driver, variant);
    if (columns === null) {
      return { kind: 'unverified', reason: 'interpolated SQL does not prepare with a placeholder' };
    }
    prepared.push(columns);
  }

  // Disagreeing column names mean a `${…}` landed in the projection: the placeholder, not the real
  // expression, is naming a result column, so neither run describes the statement that will run.
  const [first, ...rest] = prepared;
  if (first === undefined || !rest.every((columns) => sameColumns(columns, first))) {
    return { kind: 'unverified', reason: 'a runtime expression contributes to the projection' };
  }
  return { kind: 'verified', columns: first };
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

describe('query<TRow> row shapes match the statements that produce them', () => {
  let sites: QuerySite[];
  let results: { site: QuerySite; result: SiteResult }[];

  beforeAll(async () => {
    sites = collectQuerySites();
    const constants = await resolveConstants(sites);
    const driver = createMemoryDriver();
    try {
      await runMigrations(driver, migrations);
      results = sites.map((site) => ({ site, result: checkSite(driver, site, constants) }));
    } finally {
      await driver.close();
    }
  }, 120_000);

  it('finds the read layer at all (guards against a silently-empty sweep)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(MIN_SITES);
  });

  it('declares no row property the statement cannot return', () => {
    const drift = results.flatMap(({ site, result }) => {
      if (result.kind !== 'verified') return [];
      const returned = new Set(result.columns);
      const missing = site.declared.filter((name) => !returned.has(name));
      if (missing.length === 0) return [];
      return [
        `${site.where} declares [${missing.join(', ')}] — SQLite returns [${listColumns(result.columns)}]`,
      ];
    });

    expect(
      drift,
      'These row types promise properties their SQL never projects, so every read of one is ' +
        '`undefined` at runtime while the compiler insists otherwise. Either add the column to the ' +
        'SELECT or drop it from the type.',
    ).toEqual([]);
  });

  it('prepares every statically-known statement against the real schema', () => {
    const broken = results.flatMap(({ site, result }) =>
      result.kind === 'unpreparable' ? [`${site.where}: ${collapse(result.sql)}`] : [],
    );

    expect(
      broken,
      'SQLite refused to prepare these against the baseline schema — usually a table or column ' +
        'left behind by a rename.',
    ).toEqual([]);
  });

  it('keeps the population of unverifiable statements from growing', () => {
    const unverified = results.flatMap(({ site, result }) =>
      result.kind === 'unverified' ? [`${site.where} (${result.reason})`] : [],
    );

    expect(
      unverified.length,
      `No automated check can see the result shape of these statements:\n  ${unverified.join('\n  ')}\n` +
        'Prefer a statement this test can prepare — a literal, or a template whose spans are ' +
        'constants — over widening MAX_UNVERIFIED.',
    ).toBeLessThanOrEqual(MAX_UNVERIFIED);
  });

  it('verifies the large majority of the read layer', () => {
    const verified = results.filter(({ result }) => result.kind === 'verified').length;
    expect(verified).toBeGreaterThanOrEqual(MIN_VERIFIED);
  });
});

/**
 * The returned column names, capped — a `SELECT items.*` projects over forty, and the point of
 * printing them is to spot the near-miss the declaration meant.
 */
function listColumns(columns: readonly string[]): string {
  const shown = columns.slice(0, 24).join(', ');
  return columns.length > 24 ? `${shown}, …and ${columns.length - 24} more` : shown;
}

/** Squashes a statement's whitespace so a failure message stays readable. */
function collapse(sql: string): string {
  const single = sql.trim().replace(/\s+/g, ' ');
  return single.length > 120 ? `${single.slice(0, 117)}…` : single;
}
