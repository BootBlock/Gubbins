/**
 * Data-hygiene / quality report pure seam (Phase 77, third feature-gap audit candidate #4).
 *
 * A "tidy up" report that surfaces records needing attention — items missing a category, a real
 * location, a price, or a photo; stock never verified by a cycle count; stale (long-untouched)
 * records; and possible duplicates (the same MPN entered twice). The logic lives here, out of the
 * glue (house pattern): `ReportRepository.dataHygiene` pulls the raw per-item flags and
 * {@link buildHygieneReport} shapes them into sections, each with a count and a sample list the
 * Reports screen renders with jump-to-fix links. Pure, `now` injected, exhaustively unit-tested —
 * read-only over data already stored, **no schema change**.
 */

import { addCalendarDays } from '@/lib/calendar-days';
import { plural } from '@/lib/plural';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The hygiene checks, in display order. */
export type HygieneIssueKind =
  | 'missing-category'
  | 'missing-location'
  | 'missing-price'
  | 'missing-photo'
  | 'never-counted'
  | 'stale'
  | 'duplicate-mpn';

/** Per-item flags fed in by the repository (one row per active, non-parent item). */
export interface HygieneItemFlags {
  readonly id: string;
  readonly name: string;
  /** Manufacturer Part Number, or null/empty when none is set. */
  readonly mpn: string | null;
  readonly hasCategory: boolean;
  /** False when the item still sits in the Unassigned holding pen. */
  readonly hasLocation: boolean;
  /**
   * False when nothing prices the item: no unit cost, no preferred supplier cost and no purchase
   * price for a counted item (issue #688), or no cost per unit of measure for a gauge (#683).
   *
   * Each source added here has to be one valuation prices from, or the screen sends the user to
   * fix something that is not broken — which is why the purchase price joined the list when
   * valuation began falling back to it. The converse does not hold yet: a manual `current_value`
   * also values an item and is **not** read here, so an item carrying only one is still flagged.
   * That gap predates issue #688 and is left as found rather than widened into it.
   */
  readonly hasPrice: boolean;
  readonly hasPhoto: boolean;
  /** True once the item has at least one cycle-count reconciliation in its ledger. */
  readonly everCounted: boolean;
  /** Newest activity instant (UNIX-ms): the latest ledger entry, else the item's creation. */
  readonly lastActivityAt: number;
}

/** One flagged item in a section's sample list. */
export interface HygieneSample {
  readonly id: string;
  readonly name: string;
  /** Optional supplementary copy (e.g. the shared MPN, the idle age). */
  readonly detail?: string;
}

/** One hygiene check's outcome: its total count and a (capped) sample of offenders. */
export interface HygieneSection {
  readonly kind: HygieneIssueKind;
  readonly label: string;
  /** What a *flagged* item's problem is — shown when the check finds offenders. */
  readonly description: string;
  /**
   * What a *clean* result means — shown beside the green tick when the check passes. Kept
   * separate from {@link description} because the failing phrasing ("Share an MPN with another
   * item.") reads as a contradiction next to an "All good" tick; the passing phrasing states the
   * healthy state directly ("No two items share an MPN.").
   */
  readonly passDescription: string;
  /** Total items failing this check (may exceed `samples.length`). */
  readonly count: number;
  readonly samples: readonly HygieneSample[];
}

/** The report: every check that ran (0-count included) + headline totals. */
export interface HygieneReport {
  readonly sections: readonly HygieneSection[];
  /** Total active, non-parent items considered. */
  readonly totalItems: number;
  /** Distinct items failing at least one check. */
  readonly flaggedItems: number;
}

/** Options for {@link buildHygieneReport}. */
export interface HygieneOptions {
  readonly now: number;
  /** Records with no activity for at least this many days are "stale". */
  readonly staleDays: number;
  /** Cap on how many sample items each section carries (the count is always exact). */
  readonly sampleLimit?: number;
  /**
   * Checks to leave out entirely — no section, and no contribution to `flaggedItems`.
   *
   * A check whose subject the user has switched off in the Modules screen (Modular UI) would
   * otherwise flag every item for a problem they have no way to fix: with the `cycle-counts`
   * module off there is no stock-take to run, so "Never counted" is noise, not a to-do. Omitting
   * it here rather than filtering the built report keeps the "N of M items need attention"
   * headline agreeing with the rows beneath it.
   */
  readonly omitKinds?: readonly HygieneIssueKind[];
}

const DEFAULT_SAMPLE_LIMIT = 100;
const MS_PER_DAY = 86_400_000;

const SECTION_META: Record<
  HygieneIssueKind,
  { label: string; description: string; passDescription: string }
> = {
  'missing-category': {
    label: 'Missing category',
    description: 'No category assigned.',
    passDescription: 'Every item has a category.',
  },
  'missing-location': {
    label: 'Missing location',
    description: 'Still in the Unassigned holding pen.',
    passDescription: 'Every item has a real location.',
  },
  'missing-price': {
    label: 'Missing price',
    description: 'No unit cost, supplier price or purchase price.',
    passDescription: 'Every item has a price.',
  },
  'missing-photo': {
    label: 'Missing photo',
    description: 'No image attached.',
    passDescription: 'Every item has a photo.',
  },
  'never-counted': {
    label: 'Never counted',
    description: 'Stock never verified by a cycle count.',
    passDescription: "Every item's stock has been counted.",
  },
  stale: {
    label: 'Stale records',
    description: 'No activity for a long time.',
    passDescription: 'Every item has recent activity.',
  },
  'duplicate-mpn': {
    label: 'Possible duplicates',
    description: 'Shares an MPN with another item.',
    passDescription: 'No two items share an MPN.',
  },
};

/**
 * The order sections are emitted in.
 *
 * @internal Exported for unit tests only.
 */
export const HYGIENE_KIND_ORDER: readonly HygieneIssueKind[] = [
  'missing-category',
  'missing-location',
  'missing-price',
  'missing-photo',
  'never-counted',
  'stale',
  'duplicate-mpn',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A trimmed, lower-cased MPN key, or null when the MPN is absent/blank. */
function mpnKey(mpn: string | null): string | null {
  if (mpn == null) return null;
  const trimmed = mpn.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

function toSample(item: HygieneItemFlags, detail?: string): HygieneSample {
  return detail !== undefined ? { id: item.id, name: item.name, detail } : { id: item.id, name: item.name };
}

/** Build a section from a pre-filtered, name-sorted offender list. */
function section(
  kind: HygieneIssueKind,
  offenders: readonly HygieneSample[],
  sampleLimit: number,
): HygieneSection {
  return {
    kind,
    label: SECTION_META[kind].label,
    description: SECTION_META[kind].description,
    passDescription: SECTION_META[kind].passDescription,
    count: offenders.length,
    samples: offenders.slice(0, sampleLimit),
  };
}

// ---------------------------------------------------------------------------
// buildHygieneReport
// ---------------------------------------------------------------------------

/**
 * Shape raw per-item flags into the data-hygiene report. Every check runs unless `omitKinds`
 * leaves it out, and a check that runs is always present (a 0-count section reads as a green tick
 * in the UI). Offenders are name-sorted and the sample list is capped at `sampleLimit` (default
 * {@link DEFAULT_SAMPLE_LIMIT}); the `count` stays exact.
 *
 * `duplicate-mpn` groups items by their normalised MPN and flags every member of any group of two
 * or more — the most likely "same part entered twice" signal.
 */
export function buildHygieneReport(
  items: readonly HygieneItemFlags[],
  options: HygieneOptions,
): HygieneReport {
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const omitted: ReadonlySet<HygieneIssueKind> = new Set(options.omitKinds ?? []);
  // Calendar-day staleness cutoff (issue #325): N calendar days back from now, not a fixed span,
  // so it holds steady across a DST change.
  const staleBefore = addCalendarDays(options.now, -Math.max(0, options.staleDays));

  const byName = (a: HygieneItemFlags, b: HygieneItemFlags) =>
    a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sorted = [...items].sort(byName);

  const flagged = new Set<string>();
  const flag = (item: HygieneItemFlags) => flagged.add(item.id);

  // --- Single-predicate checks --------------------------------------------
  const simple: { kind: HygieneIssueKind; fails: (i: HygieneItemFlags) => boolean }[] = [
    { kind: 'missing-category', fails: (i) => !i.hasCategory },
    { kind: 'missing-location', fails: (i) => !i.hasLocation },
    { kind: 'missing-price', fails: (i) => !i.hasPrice },
    { kind: 'missing-photo', fails: (i) => !i.hasPhoto },
    { kind: 'never-counted', fails: (i) => !i.everCounted },
    // Inclusive: idle for *at least* `staleDays` (lastActivity at or before the cutoff) is stale.
    { kind: 'stale', fails: (i) => i.lastActivityAt <= staleBefore },
  ];

  const sections: HygieneSection[] = [];
  for (const { kind, fails } of simple) {
    if (omitted.has(kind)) continue;
    const offenders: HygieneSample[] = [];
    for (const item of sorted) {
      if (!fails(item)) continue;
      flag(item);
      offenders.push(
        kind === 'stale'
          ? toSample(item, `idle ${Math.floor((options.now - item.lastActivityAt) / MS_PER_DAY)}d`)
          : toSample(item),
      );
    }
    sections.push(section(kind, offenders, sampleLimit));
  }

  // --- Duplicate MPN -------------------------------------------------------
  if (!omitted.has('duplicate-mpn')) {
    const groups = new Map<string, HygieneItemFlags[]>();
    for (const item of sorted) {
      const key = mpnKey(item.mpn);
      if (key === null) continue;
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }
    const dupOffenders: HygieneSample[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const item of group) {
        flag(item);
        dupOffenders.push(
          toSample(
            item,
            `MPN ${item.mpn!.trim()} · shared with ${group.length - 1} ${plural(group.length - 1, 'other')}`,
          ),
        );
      }
    }
    // dupOffenders is grouped (each group's members adjacent); keep that grouping rather than
    // re-sorting by name, so duplicates of the same part read together.
    sections.push(section('duplicate-mpn', dupOffenders, sampleLimit));
  }

  // Emit in the canonical order, skipping any check `omitKinds` left out.
  const byKind = new Map(sections.map((s) => [s.kind, s]));
  const ordered = HYGIENE_KIND_ORDER.map((kind) => byKind.get(kind)).filter(
    (s): s is HygieneSection => s !== undefined,
  );

  return {
    sections: ordered,
    totalItems: items.length,
    flaggedItems: flagged.size,
  };
}
