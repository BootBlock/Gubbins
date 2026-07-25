/**
 * A small, transport-agnostic **field-selection engine** — the mechanics behind the
 * `fields` (sparse fieldset / projection) and `include` (field expansion) parameters the
 * item query API exposes. It is deliberately generic (a registry of named resolvers over an
 * arbitrary context) so the same code powers the HTTP API and the MCP tools, and could serve
 * a second resource later without a fork.
 *
 * The two axes, mirroring the well-trodden REST conventions (JSON:API sparse fieldsets,
 * Google's `fields` mask, Stripe's `expand`):
 *
 *   - **`fields`** restricts the response to exactly the named fields (a projection). Naming a
 *     non-default ("extended") field here implicitly opts it in, so `fields=name,unitCost`
 *     just works. One level of nesting is supported via dotted paths (`placements.quantity`)
 *     for the compound array fields.
 *   - **`include`** *adds* extended fields (or whole named groups) on top of the endpoint's
 *     default payload — "give me the defaults plus this extra information".
 *
 * Resolution is **lazy**: only the fields actually selected have their resolver run, so an
 * expensive relational read never fires for a field the caller didn't ask for. Unknown names
 * are rejected loudly ({@link FieldSelectionError}) with the valid vocabulary, rather than
 * silently dropped.
 */
import { MAX_SELECTED_FIELDS } from './limits.ts';

/**
 * Raised when a selection is malformed — an unknown field, an empty `fields`, an invalid
 * nested path, or too many fields. The message is caller-facing and PII-free (it only ever
 * names the static field vocabulary), so it is safe to surface verbatim as a `400` /
 * tool-input error.
 */
export class FieldSelectionError extends Error {}

/**
 * One exposable field: how to resolve its value from the context, and — for a field whose
 * value is an array of plain objects — the sub-keys a caller may pick with a dotted path.
 */
export interface FieldNode<TCtx> {
  /** Resolve this field's value (may be a scalar or an array of objects; may read the DB). */
  readonly resolve: (ctx: TCtx) => unknown | Promise<unknown>;
  /**
   * When present, this field resolves to an **array of objects** and these are the sub-keys a
   * caller may select with `field.subKey`. Absent for scalar fields (which aren't nestable).
   */
  readonly elementKeys?: readonly string[];
}

/** A named vocabulary of {@link FieldNode}s. Iteration order defines the output key order. */
export type FieldRegistry<TCtx> = ReadonlyMap<string, FieldNode<TCtx>>;

/** One resolved selection entry: a top-level field plus (for a nested field) its chosen sub-keys. */
export interface SelectedField {
  readonly name: string;
  /** The chosen element sub-keys for a nested field, or `null` to emit the whole element. */
  readonly subKeys: ReadonlySet<string> | null;
}

/** The raw, untrusted `fields` / `include` inputs (a comma-separated string, or a string array). */
export interface RawSelection {
  readonly fields?: unknown;
  readonly include?: unknown;
}

/** Everything {@link parseSelection} needs to validate and order a selection for a resource. */
export interface SelectionConfig<TCtx> {
  readonly registry: FieldRegistry<TCtx>;
  /** The endpoint's default field set, used when `fields` is omitted (each name must be in the registry). */
  readonly defaults: readonly string[];
  /** Named groups a caller may use in `include` (e.g. `relations` → several fields). */
  readonly aliases?: Readonly<Record<string, readonly string[]>>;
}

/** True when either selection parameter is present (so the endpoint should project rather than default). */
export function hasSelection(raw: RawSelection): boolean {
  return raw.fields !== undefined || raw.include !== undefined;
}

/**
 * Parse and validate a raw `fields`/`include` selection into an ordered list of
 * {@link SelectedField}s (in registry order, for a deterministic response shape).
 *
 * Semantics:
 *   - `include` expands aliases, then adds each named (extended) field on top of the base set.
 *   - `fields`, when present, *replaces* the base set with exactly the named fields; when absent
 *     the base set is the endpoint `defaults`. `include` is always unioned on top of whichever.
 *   - A dotted `field.subKey` selects `field` and restricts its elements to the named sub-keys.
 *
 * Throws {@link FieldSelectionError} on any unknown name, an empty `fields`, an invalid nested
 * path, or more than {@link MAX_SELECTED_FIELDS} fields.
 */
export function parseSelection<TCtx>(
  cfg: SelectionConfig<TCtx>,
  raw: RawSelection,
): readonly SelectedField[] {
  const unknown = new Set<string>();
  // head → chosen sub-keys (null = whole field / all sub-keys).
  const selected = new Map<string, Set<string> | null>();

  const note = (name: string): boolean => {
    if (!cfg.registry.has(name)) {
      unknown.add(name);
      return false;
    }
    return true;
  };

  // 1. include: expand aliases → validate → union onto the selection as whole fields.
  //
  // Looked up with `Object.hasOwn`, never a bare index: an alias table is a plain object, so it
  // also answers to its prototype's keys — `aliases['toString']` yields a *function*, which is
  // neither `undefined` nor iterable, so `include=toString` would die spreading it (a 500) instead
  // of being reported as the unknown field it is.
  const includeNames: string[] = [];
  for (const token of splitList(raw.include)) {
    const expanded =
      cfg.aliases !== undefined && Object.hasOwn(cfg.aliases, token) ? cfg.aliases[token] : undefined;
    if (expanded !== undefined) includeNames.push(...expanded);
    else includeNames.push(token);
  }

  // 2. Base set: the explicit `fields` (if given) else the endpoint defaults.
  const fieldsGiven = raw.fields !== undefined;
  const fieldTokens = splitList(raw.fields);
  if (fieldsGiven && fieldTokens.length === 0) {
    throw new FieldSelectionError('The "fields" parameter must name at least one field.');
  }

  const total = fieldTokens.length + includeNames.length;
  if (total > MAX_SELECTED_FIELDS) {
    throw new FieldSelectionError(`Too many fields requested (max ${MAX_SELECTED_FIELDS}).`);
  }

  if (fieldsGiven) {
    for (const token of fieldTokens) addFieldToken(token, cfg.registry, selected, note);
  } else {
    for (const name of cfg.defaults) if (note(name)) mergeWhole(selected, name);
  }
  for (const name of includeNames) if (note(name)) mergeWhole(selected, name);

  if (unknown.size > 0) {
    const valid = [...cfg.registry.keys()].join(', ');
    throw new FieldSelectionError(
      `Unknown field(s): ${[...unknown].sort().join(', ')}. Valid fields: ${valid}.`,
    );
  }
  if (selected.size === 0) {
    throw new FieldSelectionError('The selection resolved to no fields.');
  }

  // 3. Emit in registry order for a stable, deterministic response shape.
  const out: SelectedField[] = [];
  for (const name of cfg.registry.keys()) {
    if (selected.has(name)) out.push({ name, subKeys: selected.get(name) ?? null });
  }
  return out;
}

/**
 * Project a context through a resolved selection, awaiting only the selected fields' resolvers
 * (so an unselected relational read never runs). A nested selection restricts each element of
 * an array field to its chosen sub-keys.
 */
export async function projectThrough<TCtx>(
  registry: FieldRegistry<TCtx>,
  selection: readonly SelectedField[],
  ctx: TCtx,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const { name, subKeys } of selection) {
    const node = registry.get(name);
    if (node === undefined) continue; // unreachable: selection is validated against the registry
    const value = await node.resolve(ctx);
    if (subKeys !== null && node.elementKeys !== undefined && Array.isArray(value)) {
      out[name] = value.map((el) => pick(el as Record<string, unknown>, subKeys));
    } else {
      out[name] = value;
    }
  }
  return out;
}

// --- internals --------------------------------------------------------------------

/** Add one (possibly dotted) `fields` token to the selection, validating head + sub-key. */
function addFieldToken<TCtx>(
  token: string,
  registry: FieldRegistry<TCtx>,
  selected: Map<string, Set<string> | null>,
  note: (name: string) => boolean,
): void {
  const parts = token.split('.');
  if (parts.length > 2) {
    throw new FieldSelectionError(`Nested field "${token}" is too deep (one level of nesting is supported).`);
  }
  const [head, sub] = parts as [string, string | undefined];
  if (!note(head)) return; // unknown head — recorded, reported together at the end

  if (sub === undefined) {
    mergeWhole(selected, head);
    return;
  }
  const node = registry.get(head);
  if (node?.elementKeys === undefined) {
    throw new FieldSelectionError(`Field "${head}" is not a nested field, so "${token}" is invalid.`);
  }
  if (!node.elementKeys.includes(sub)) {
    throw new FieldSelectionError(
      `Unknown sub-field "${sub}" of "${head}". Valid: ${node.elementKeys.join(', ')}.`,
    );
  }
  const existing = selected.get(head);
  if (existing === null) return; // a bare selection of the whole field already won
  const set = existing ?? new Set<string>();
  set.add(sub);
  selected.set(head, set);
}

/** Select the whole field (all sub-keys). A whole selection supersedes any partial one. */
function mergeWhole(selected: Map<string, Set<string> | null>, name: string): void {
  selected.set(name, null);
}

/** Copy just the chosen keys out of an element object. */
function pick(el: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in el) out[key] = el[key];
  return out;
}

/**
 * Normalise a raw comma-separated string (or a string array) into trimmed, non-empty tokens.
 * Array elements may themselves contain commas. Anything non-string is ignored.
 */
export function splitList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    for (const token of part.split(',')) {
      const trimmed = token.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}
