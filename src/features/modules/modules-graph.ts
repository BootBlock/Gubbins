/**
 * Pure dependency-graph maths for the Modular UI (modular-ui-plan §2.3).
 *
 * Every function here is deterministic and side-effect-free: it takes the user's stored
 * *intent* plus the feature registry and computes an answer, touching no store, no DOM
 * and no storage. This is the "extract the logic out of the glue" seam the store and
 * React hooks are thin shells over (mirroring `dashboard-layout.ts` / `alerts.ts`), and
 * it is the layer the unit tests exercise directly.
 *
 * The core idea: the store persists *intent* (an explicit per-feature choice), never the
 * effective state. Whether a feature is actually enabled is *resolved* on read as a
 * fixpoint over the acyclic dependency graph — so a child whose parent is off reads as
 * off without ever mutating storage, and re-enabling the parent restores the child to its
 * own stored intent.
 */
import type { FeatureDef, FeatureId } from './feature-registry';

/**
 * The user's explicit per-feature choice. A missing key means "on" (default everything-on),
 * except for a feature declared {@link FeatureDef.defaultOff}, where it means "off".
 */
export type FeatureIntent = Readonly<Record<string, boolean>>;

/**
 * Whether the user's stored intent wants this feature on.
 *
 * Absence is read against the feature's own default: everything-on for an ordinary module (so a
 * newly-added feature appears rather than hiding silently), but **off** for one declared
 * `defaultOff`, which must be chosen rather than inherited.
 */
function isIntended(intent: FeatureIntent, feature: FeatureDef): boolean {
  const stored = intent[feature.id];
  if (stored !== undefined) return stored;
  return !feature.defaultOff;
}

/**
 * Resolve the effective enabled set from stored intent.
 *
 * A feature is effective iff it is `alwaysOn` (core), **or** the user has not turned it
 * off (`intent !== false`) **and** every one of its `dependsOn` features is itself
 * effective. Computed as a memoised fixpoint over the acyclic graph; a back-edge (only
 * possible if the registry were mis-specified with a cycle) is treated defensively as
 * "not effective" so this can never recurse forever.
 */
export function resolveEnabled(
  intent: FeatureIntent,
  registry: readonly FeatureDef[],
): ReadonlySet<FeatureId> {
  const byId = new Map(registry.map((f) => [f.id, f]));
  const effective = new Map<FeatureId, boolean>();
  const visiting = new Set<FeatureId>();

  function resolve(id: FeatureId): boolean {
    const cached = effective.get(id);
    if (cached !== undefined) return cached;

    const feature = byId.get(id);
    // Unknown id, or a dependency cycle we are already resolving: fail safe as off.
    if (!feature || visiting.has(id)) return false;

    if (feature.alwaysOn) {
      effective.set(id, true);
      return true;
    }

    visiting.add(id);
    const on = isIntended(intent, feature) && (feature.dependsOn ?? []).every((dep) => resolve(dep));
    visiting.delete(id);

    effective.set(id, on);
    return on;
  }

  const result = new Set<FeatureId>();
  for (const feature of registry) {
    if (resolve(feature.id)) result.add(feature.id);
  }
  return result;
}

/** Whether a single feature is effectively enabled under the given intent. */
export function isFeatureEnabled(
  id: FeatureId,
  intent: FeatureIntent,
  registry: readonly FeatureDef[],
): boolean {
  return resolveEnabled(intent, registry).has(id);
}

/**
 * The transitive set of features that (directly or indirectly) depend on `id` — i.e.
 * everything that would have to go off if `id` went off. Excludes `id` itself.
 */
export function dependentsOf(id: FeatureId, registry: readonly FeatureDef[]): ReadonlySet<FeatureId> {
  // Build the reverse adjacency (dependency → its direct dependents) once.
  const directDependents = new Map<FeatureId, FeatureId[]>();
  for (const feature of registry) {
    for (const dep of feature.dependsOn ?? []) {
      const list = directDependents.get(dep) ?? [];
      list.push(feature.id);
      directDependents.set(dep, list);
    }
  }

  const result = new Set<FeatureId>();
  const stack = [...(directDependents.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (result.has(next)) continue;
    result.add(next);
    stack.push(...(directDependents.get(next) ?? []));
  }
  return result;
}

/**
 * The transitive set of features `id` depends on (directly or indirectly) — i.e.
 * everything that would have to be on for `id` to be usable. Excludes `id` itself.
 */
export function dependenciesOf(id: FeatureId, registry: readonly FeatureDef[]): ReadonlySet<FeatureId> {
  const byId = new Map(registry.map((f) => [f.id, f]));
  const result = new Set<FeatureId>();
  const start = byId.get(id);
  const stack = [...(start?.dependsOn ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (result.has(next)) continue;
    result.add(next);
    stack.push(...(byId.get(next)?.dependsOn ?? []));
  }
  return result;
}

/**
 * The features that would disappear if the user turned `id` off: `id` itself plus every
 * transitive dependent that is *currently effective*. Dependents already off aren't
 * listed — they wouldn't change — so this drives honest "this will also hide X, Y" copy.
 */
export function closureToDisable(
  id: FeatureId,
  intent: FeatureIntent,
  registry: readonly FeatureDef[],
): ReadonlySet<FeatureId> {
  const effective = resolveEnabled(intent, registry);
  const result = new Set<FeatureId>([id]);
  for (const dependent of dependentsOf(id, registry)) {
    if (effective.has(dependent)) result.add(dependent);
  }
  return result;
}

/**
 * The features that would need to be switched on for `id` to become usable: `id` itself
 * plus every transitive dependency that is *currently off*. Dependencies already on
 * aren't listed — driving honest "this will also show A, B" copy.
 */
export function closureToEnable(
  id: FeatureId,
  intent: FeatureIntent,
  registry: readonly FeatureDef[],
): ReadonlySet<FeatureId> {
  const effective = resolveEnabled(intent, registry);
  const result = new Set<FeatureId>([id]);
  for (const dependency of dependenciesOf(id, registry)) {
    if (!effective.has(dependency)) result.add(dependency);
  }
  return result;
}

/**
 * Detect a dependency cycle in the registry, returning the ids on the first cycle found
 * (in visit order) or `null` if the graph is acyclic. Used by the registry-integrity
 * unit test; a cycle would break {@link resolveEnabled}'s fixpoint assumption.
 *
 * @internal Exported for unit tests only.
 */
export function findDependencyCycle(registry: readonly FeatureDef[]): FeatureId[] | null {
  const byId = new Map(registry.map((f) => [f.id, f]));
  const visited = new Set<FeatureId>();
  const stack: FeatureId[] = [];
  const onStack = new Set<FeatureId>();

  function walk(id: FeatureId): FeatureId[] | null {
    if (onStack.has(id)) {
      // Return the slice of the current path from the first occurrence of `id`.
      return [...stack.slice(stack.indexOf(id)), id];
    }
    if (visited.has(id)) return null;

    visited.add(id);
    onStack.add(id);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const cycle = walk(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    onStack.delete(id);
    return null;
  }

  for (const feature of registry) {
    const cycle = walk(feature.id);
    if (cycle) return cycle;
  }
  return null;
}
