/**
 * The generic no-overwrite fill plan (issue #616, phase L0) — the CRITICAL integrity safeguard,
 * generalised.
 *
 * `scraping/merge.ts` already enforces the §4 rule that a fetch must **never** overwrite or
 * remove a user-created value unless the user explicitly opts into *that specific* overwrite.
 * It is fixed to four hard-coded item fields, so a lookup that fills an *arbitrary* set of a
 * category's custom fields needs a sibling working over a dynamic target set rather than a
 * widening of it. The classification is deliberately the same four dispositions, so the two
 * read alike and neither invents its own idea of safety:
 *
 *  - `FILL`      — the target is empty, so the value applies freely;
 *  - `CONFLICT`  — the target holds a differing value the user put there, so the change is
 *                  withheld unless they tick that specific target;
 *  - `UNCHANGED` — the values already agree (nothing to do);
 *  - `SKIP`      — the source offered nothing for this key.
 *
 * Two things this adds over `merge.ts`, both because the targets are dynamic:
 *
 * 1. **Values are validated against the field they will land in**, through the very seam the
 *    repository enforces on write (`validateFieldValue`). A value that would be rejected there
 *    is reported *here* instead, rather than being written and failing the whole save — and the
 *    canonical storage string it yields (`'1.50'` → `'1.5'`) is what the comparison uses, so a
 *    number the user already typed differently isn't mistaken for a conflict.
 * 2. **Unusable keys are reported, not dropped** (#350). A key bound to nothing, bound to a
 *    field of the wrong type, or carrying a value that field can't hold, appears in
 *    {@link LookupFillPlan.problems} for the review dialog to name back to the user.
 *
 * Pure and DB-free, like `merge.ts`: the caller supplies the current values, and turns
 * {@link applyLookupFillPlan}'s output into the write.
 */
import { validateFieldValue } from '@/features/inventory/custom-fields';
import type { LookupBinding, LookupBindingProblem, LookupTarget } from './binding';
import type { BuiltinLookupTarget, LookupValues } from './types';

/** Disposition of one target in a proposed fill — the same four `scraping/merge.ts` uses. */
export type LookupFillStatus = 'FILL' | 'CONFLICT' | 'UNCHANGED' | 'SKIP';

/**
 * Why one of a provider's values will not be applied.
 *
 * The binding problems (`NO_FIELD` / `TYPE_MISMATCH`) plus the one that can only be known once
 * a value is in hand: the field exists and is the right type, but this particular value is not
 * one it can hold.
 */
export type LookupFillProblem =
  | LookupBindingProblem
  | {
      readonly kind: 'UNUSABLE_VALUE';
      readonly outputKey: string;
      /** The field the value was destined for, named so the user can see which one to fix. */
      readonly wantedName: string;
      /** The validator's own explanation, in the app's voice. */
      readonly reason: string;
    };

/** One target's proposed change, surfaced to the user for review. */
export interface LookupFillProposal {
  readonly outputKey: string;
  readonly target: LookupTarget;
  /** The target's display name — the field's own name, or the built-in target id. */
  readonly targetName: string;
  /** What the target holds now; null when empty. */
  readonly current: string | null;
  /** The canonical storage string the source offers; null when it offered nothing. */
  readonly incoming: string | null;
  readonly status: LookupFillStatus;
}

/** The full, reviewable plan a lookup produces against an item. */
export interface LookupFillPlan {
  readonly proposals: readonly LookupFillProposal[];
  /** Everything the source offered that cannot be applied, and why. Never silently dropped. */
  readonly problems: readonly LookupFillProblem[];
}

/** The concrete writes a plan yields once the overwrite opt-ins are resolved. */
export interface LookupFillWrite {
  /** `category_fields.id` → the value to store. */
  readonly fieldValues: Readonly<Record<string, string>>;
  /** Built-in item attributes to set. */
  readonly builtins: Readonly<Partial<Record<BuiltinLookupTarget, string>>>;
}

/** What the item currently holds, so the plan can classify each target against it. */
export interface LookupCurrentValues {
  /** Effective value per `category_fields.id`; a missing key reads as empty. */
  readonly fieldValues: Readonly<Record<string, string | null>>;
  /** The item's current built-in attribute values; a missing key reads as empty. */
  readonly builtins: Readonly<Partial<Record<BuiltinLookupTarget, string | null>>>;
}

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}

/** The current value of a target, whichever kind it is. */
function currentOf(target: LookupTarget, current: LookupCurrentValues): string | null {
  return target.kind === 'field'
    ? (current.fieldValues[target.field.id] ?? null)
    : (current.builtins[target.target] ?? null);
}

/**
 * Classify an incoming value against what the target already holds.
 *
 * Compared case-insensitively on the trimmed text, exactly as `scraping/merge.ts` does: a
 * source that spells a director "RIDLEY SCOTT" where the user typed "Ridley Scott" is offering
 * the same answer, and prompting to overwrite one with the other would be noise rather than
 * safety.
 */
function classify(current: string | null, incoming: string | null): LookupFillStatus {
  if (incoming === null) return 'SKIP';
  if (isBlank(current)) return 'FILL';
  return current!.trim().toLowerCase() === incoming.trim().toLowerCase() ? 'UNCHANGED' : 'CONFLICT';
}

/**
 * Reduce a provider's raw value to the storage string a target can hold, or explain why it
 * cannot hold it.
 *
 * `undefined`/`null`/blank all mean *the source didn't know* — never "the source says it is
 * empty" — so they produce no proposal at all rather than a write that would clear a value the
 * user has. A custom field goes through `validateFieldValue` (the same seam the repository
 * enforces on write, so the plan can never propose a write that would be refused); a built-in
 * is plain trimmed text.
 */
function normalise(
  target: LookupTarget,
  raw: string | number | null | undefined,
): { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly reason: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const text = typeof raw === 'number' ? String(raw) : raw.trim();
  if (text.length === 0) return { ok: true, value: null };

  if (target.kind === 'builtin') return { ok: true, value: text };

  // `isRequired: false` deliberately: whether the field is mandatory is the category's policy
  // for the item's own editor, and has nothing to say about whether a fetched value is usable.
  const result = validateFieldValue({ ...target.field, isRequired: false }, text);
  return result.ok ? { ok: true, value: result.value } : { ok: false, reason: result.error };
}

/**
 * Build the reviewable plan for a set of fetched values against an item's current state.
 *
 * `bindings` and `bindingProblems` come from `bindLookupOutputs`; the binding problems are
 * carried through unchanged so the review dialog has one list to render — a key that never
 * bound and a key whose value doesn't fit are the same kind of thing to the user ("this
 * couldn't be applied, and here's why").
 *
 * Decides no overwrite: that is the user's explicit choice, resolved by
 * {@link applyLookupFillPlan}.
 */
export function buildLookupFillPlan(
  bindings: readonly LookupBinding[],
  bindingProblems: readonly LookupBindingProblem[],
  values: LookupValues,
  current: LookupCurrentValues,
): LookupFillPlan {
  const proposals: LookupFillProposal[] = [];
  const problems: LookupFillProblem[] = [...bindingProblems];

  for (const binding of bindings) {
    const normalised = normalise(binding.target, values[binding.outputKey]);
    if (!normalised.ok) {
      problems.push({
        kind: 'UNUSABLE_VALUE',
        outputKey: binding.outputKey,
        wantedName: binding.targetName,
        reason: normalised.reason,
      });
      continue;
    }
    const held = currentOf(binding.target, current);
    proposals.push({
      outputKey: binding.outputKey,
      target: binding.target,
      targetName: binding.targetName,
      current: held,
      incoming: normalised.value,
      status: classify(held, normalised.value),
    });
  }

  return { proposals, problems };
}

/**
 * Resolve a plan into the concrete writes, honouring the no-overwrite safeguard:
 *
 *  - `FILL` targets are always written (no user value is at risk);
 *  - `CONFLICT` targets are written **only** when that specific output key is in
 *    `overwriteKeys`;
 *  - `UNCHANGED` / `SKIP` targets are never written.
 *
 * A key in `overwriteKeys` that isn't actually a `CONFLICT` is ignored, so an opt-in can never
 * *introduce* a change the plan didn't propose.
 */
export function applyLookupFillPlan(
  plan: LookupFillPlan,
  overwriteKeys: ReadonlySet<string> = new Set(),
): LookupFillWrite {
  const fieldValues: Record<string, string> = {};
  const builtins: Partial<Record<BuiltinLookupTarget, string>> = {};

  for (const proposal of plan.proposals) {
    const include =
      proposal.status === 'FILL' || (proposal.status === 'CONFLICT' && overwriteKeys.has(proposal.outputKey));
    if (!include || proposal.incoming === null) continue;
    if (proposal.target.kind === 'field') fieldValues[proposal.target.field.id] = proposal.incoming;
    else builtins[proposal.target.target] = proposal.incoming;
  }

  return { fieldValues, builtins };
}

/** Whether a plan would change anything at all — the guard the review dialog's Apply obeys. */
export function planHasChanges(
  plan: LookupFillPlan,
  overwriteKeys: ReadonlySet<string> = new Set(),
): boolean {
  const write = applyLookupFillPlan(plan, overwriteKeys);
  return Object.keys(write.fieldValues).length > 0 || Object.keys(write.builtins).length > 0;
}
