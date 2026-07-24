/**
 * Printable **location** labels (Phase 73 "Label customisation").
 *
 * A location label carries a QR of the location deep-link
 * (`…/#/inventory?location=<id>`, see {@link buildLocationQrUrl}) so a phone camera —
 * or the in-app scanner — jumps straight to that bin/shelf, plus the location name and
 * (optionally) its ancestor path. A Code 128, where the template asks for one, carries
 * the location's name (or a short id when the name is too long to print readably) for a
 * handheld linear scanner, exactly as an item label carries its MPN. It reuses the
 * shared {@link resolveCell} renderer and
 * print-document wrapper from `label-sheet.ts`, so item and location labels look
 * identical and the QR/barcode logic lives in exactly one place.
 *
 * All pure and unit-tested.
 */
import { buildLocationQrUrl } from '@/features/scanner/scan-payload';
import { labelCellHtml, resolveCell, sheetDocument, type LabelCell } from './label-sheet';
import { type LabelTemplate } from './label-template';

/** The fields a location label can surface. */
export interface LocationLabelInput {
  readonly id: string;
  readonly name: string;
  /** Ancestor path shown as a second line when the template enables "location". */
  readonly path?: string | null;
}

/** A minimal `{id, parentId, name}` shape for {@link locationPath} ancestor walking. */
export interface LocationPathNode {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

/**
 * Hard cap on copies of a single location label printed at once.
 *
 * @internal Exported for unit tests only.
 */
export const MAX_LOCATION_LABEL_COPIES = 24;

/**
 * Clamp/round an arbitrary value to a valid copy count (1..{@link MAX_LOCATION_LABEL_COPIES}).
 *
 * @internal Exported for unit tests only.
 */
export function clampCopies(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_LOCATION_LABEL_COPIES, Math.max(1, n));
}

/**
 * The ancestor path of a location as a separator-joined string (root first, excluding
 * the location itself), e.g. `Workshop / Shelf B`. Returns `''` for a top-level
 * location. Cycle-safe: a malformed parent chain stops at the first repeat.
 */
export function locationPath(id: string, nodes: readonly LocationPathNode[], separator = ' / '): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ancestors: string[] = [];
  const seen = new Set<string>([id]);
  let parentId = byId.get(id)?.parentId ?? null;
  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestors.push(parent.name);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return ancestors.reverse().join(separator);
}

/**
 * The text lines a location label shows, in order, per the template's flags.
 *
 * @internal Exported for unit tests only.
 */
export function locationLabelLines(loc: LocationLabelInput, template: LabelTemplate): string[] {
  const lines: string[] = [];
  if (template.showName) lines.push(loc.name);
  if (template.showLocation && loc.path && loc.path.trim().length > 0) lines.push(loc.path);
  return lines;
}

/** Resolve a location to a rendered {@link LabelCell} under a template. */
export function toLocationLabelCell(
  loc: LocationLabelInput,
  baseUrl: string,
  template: LabelTemplate,
): LabelCell {
  return resolveCell(
    {
      id: loc.id,
      name: loc.name,
      url: buildLocationQrUrl(loc.id, baseUrl),
      // The barcode prefers the location's own name — a bin called "A-12" is far more
      // use on a shelf than an opaque id — but a name is free text of any length, so
      // `resolveCell` swaps in a short id whenever the name would print too small to
      // scan, and drops the barcode entirely on a label too narrow for either (#331).
      barcodePreferred: loc.name,
      lines: locationLabelLines(loc, template),
    },
    template,
  );
}

/**
 * Build a complete, self-contained printable document of `copies` identical labels for
 * one location, laid out per the template's size mode (A4 grid or die-cut per page).
 * Pure deterministic transform.
 */
export function buildLocationLabelHtml(
  loc: LocationLabelInput,
  baseUrl: string,
  template: LabelTemplate,
  copies = 1,
): string {
  const cell = labelCellHtml(toLocationLabelCell(loc, baseUrl, template));
  return sheetDocument(cell.repeat(clampCopies(copies)), template);
}
