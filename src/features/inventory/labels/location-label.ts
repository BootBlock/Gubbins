/**
 * Printable **location** labels (Phase 73 "Label customisation").
 *
 * A location label carries a QR/Code-128 of the location deep-link
 * (`…/#/inventory?location=<id>`, see {@link buildLocationQrUrl}) so a phone camera —
 * or the in-app scanner — jumps straight to that bin/shelf, plus the location name and
 * (optionally) its ancestor path. It reuses the shared {@link resolveCell} renderer and
 * print-document wrapper from `label-sheet.ts`, so item and location labels look
 * identical and the QR/barcode logic lives in exactly one place.
 *
 * All pure and unit-tested.
 */
import { buildLocationQrUrl } from '@/features/scanner/scan-payload';
import { labelCellHtml, resolveCell, sheetDocument, type LabelCell } from './label-sheet';
import { labelBarcodeValue, type LabelTemplate } from './label-template';

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

/** Hard cap on copies of a single location label printed at once. */
export const MAX_LOCATION_LABEL_COPIES = 24;

/** Clamp/round an arbitrary value to a valid copy count (1..{@link MAX_LOCATION_LABEL_COPIES}). */
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

/** The text lines a location label shows, in order, per the template's flags. */
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
      // The barcode encodes the location name (sanitised), falling back to a short id.
      barcodeValue: labelBarcodeValue({ id: loc.id, mpn: loc.name }),
      lines: locationLabelLines(loc, template),
    },
    template,
  );
}

/**
 * Build a complete, self-contained printable document of `copies` identical labels for
 * one location, laid out in the template's columns. Pure deterministic transform.
 */
export function buildLocationLabelHtml(
  loc: LocationLabelInput,
  baseUrl: string,
  template: LabelTemplate,
  copies = 1,
): string {
  const cell = labelCellHtml(toLocationLabelCell(loc, baseUrl, template));
  return sheetDocument(cell.repeat(clampCopies(copies)), template.columns);
}
