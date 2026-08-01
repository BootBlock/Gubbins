/**
 * Assembly-draw planning (issue #647) — the pure seam deciding what finalising a project
 * actually takes from each matched part.
 *
 * Finalising is terminal and not undoable, so *how much* it takes has to be a decision, not an
 * accident. This seam turns the project's matched parts (each with the quantity its BOM lines
 * add up to, and what is on hand) into one {@link AssemblyDraw} per part: the amount to draw,
 * whether that empties the part, and any shortfall. The repository executes exactly this plan and
 * the dialog previews exactly this plan, so what a user is shown before pressing the button and
 * what the ledger records afterwards are the same computation rather than two that agree by
 * coincidence.
 *
 * How much comes out depends on how the part's stock is *counted*, which is the {@link
 * AssemblyDrawMode}:
 *   - `COUNT` — a DISCRETE or SERIALISED part: draw the required units from the per-location /
 *     batch ledger, leaving the remainder on the shelf.
 *   - `GAUGE` — a CONSUMABLE_GAUGE part: the requirement is a net-value draw (50 ml of adhesive),
 *     not a count of vessels.
 *   - `WHOLE` — an UNTRACKED part: presence-only, with no quantity to take a slice of, so the
 *     build takes the thing itself.
 *   - `UNLIMITED` — an infinite source (Phase 82): the draw is recorded but never moves the
 *     ledger and can never run short (the no-op rule in `features/inventory/unlimited.ts`).
 *
 * Pure: no DB, no clock, no formatting — so every combination stays exhaustively unit-testable.
 */
import type { TrackingMode } from '@/db/repositories';

/** How a matched part's stock is counted, and so how a finalise draws it down. */
export type AssemblyDrawMode = 'COUNT' | 'GAUGE' | 'WHOLE' | 'UNLIMITED';

/** One matched part of a project: what the BOM asks of it, and what it has. */
export interface AssemblyPart {
  readonly itemId: string;
  /** The item's name, for the preview and the shortfall message. */
  readonly name: string;
  /** The total the project's BOM lines ask for — summed across every line matching this item. */
  readonly requiredQty: number;
  /** On-hand supply: the grand-total quantity, or a gauge's current net value. */
  readonly onHand: number;
  readonly trackingMode: TrackingMode;
  readonly isUnlimited: boolean;
}

/** What finalising takes from one matched part. */
export interface AssemblyDraw {
  readonly itemId: string;
  readonly name: string;
  readonly mode: AssemblyDrawMode;
  /** The BOM's total requirement for this part. */
  readonly requiredQty: number;
  /** On-hand supply at the time the plan was made. */
  readonly onHand: number;
  /** Units (or net value) the finalise actually draws — 0 for a part with nothing to count. */
  readonly takeQty: number;
  /** Units the requirement is short by; 0 when it can be met (always 0 for an infinite source). */
  readonly shortfallQty: number;
  /**
   * True when the draw leaves the part with nothing on hand — the one condition under which a
   * finalise retires the item (consumption) or repoints its primary location (a container).
   * Never true for an infinite source, which cannot be emptied.
   */
  readonly takesAll: boolean;
}

/** The whole project's draw, plus whether it can actually be met. */
export interface AssemblyDrawPlan {
  /** One entry per matched part, in the order the parts were supplied. */
  readonly draws: readonly AssemblyDraw[];
  /** Just the draws that cannot be met — the reason an infeasible plan is rejected. */
  readonly shortfalls: readonly AssemblyDraw[];
  /** True when every part can supply its requirement. */
  readonly feasible: boolean;
}

/**
 * How this part's stock is counted. An infinite source is decided first: `is_unlimited` is a
 * modifier on a DISCRETE item, and being infinite outranks being countable.
 */
function drawModeFor(part: AssemblyPart): AssemblyDrawMode {
  if (part.isUnlimited) return 'UNLIMITED';
  if (part.trackingMode === 'CONSUMABLE_GAUGE') return 'GAUGE';
  if (part.trackingMode === 'UNTRACKED') return 'WHOLE';
  return 'COUNT';
}

/** Plan one part's draw. */
function planPart(part: AssemblyPart): AssemblyDraw {
  const mode = drawModeFor(part);
  const requiredQty = Math.max(0, part.requiredQty);
  const onHand = Math.max(0, part.onHand);
  // A presence-only part has no quantity to slice, so the build takes the item itself; every
  // other mode takes exactly what the BOM asks for.
  const takeQty = mode === 'WHOLE' ? 0 : requiredQty;
  // Neither a presence-only part nor an infinite source can come up short: the first has nothing
  // to count, the second can never run out.
  const shortfallQty = mode === 'WHOLE' || mode === 'UNLIMITED' ? 0 : Math.max(0, requiredQty - onHand);
  const takesAll = mode === 'WHOLE' || (mode !== 'UNLIMITED' && takeQty > 0 && takeQty >= onHand);
  return { itemId: part.itemId, name: part.name, mode, requiredQty, onHand, takeQty, shortfallQty, takesAll };
}

/**
 * Plan what finalising takes from every matched part. Nothing is ordered or de-duplicated here —
 * the caller supplies one {@link AssemblyPart} per item with its lines already summed, so a part
 * appearing on three BOM lines is drawn once for the total rather than three times over.
 */
export function planAssemblyDraw(parts: readonly AssemblyPart[]): AssemblyDrawPlan {
  const draws = parts.map(planPart);
  const shortfalls = draws.filter((d) => d.shortfallQty > 0);
  return { draws, shortfalls, feasible: shortfalls.length === 0 };
}

/**
 * True when a draw moves nothing at all — a BOM line asking for zero. Such a part is not
 * consumed, not retired and not logged: a `CONSUMED` entry recording no movement would be a
 * ledger entry for something that never happened.
 */
export function isEmptyDraw(draw: AssemblyDraw): boolean {
  return draw.mode !== 'WHOLE' && draw.takeQty <= 0;
}

/**
 * The rejection sentence for a finalise that cannot be met — naming each short part with what it
 * needs and what it has, so the fix (add stock, or lower the quantity) is obvious from the
 * message alone rather than requiring a hunt through the BOM.
 */
export function assemblyShortfallMessage(projectName: string, shortfalls: readonly AssemblyDraw[]): string {
  const detail = shortfalls.map((s) => `${s.name} (needs ${s.requiredQty}, ${s.onHand} on hand)`).join(', ');
  return `Not enough stock to finalise "${projectName}": short on ${detail}.`;
}
