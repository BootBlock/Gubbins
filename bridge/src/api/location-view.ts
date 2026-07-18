/**
 * The **location field vocabulary** — the counterpart to `item-view.ts` for the location read
 * endpoints, built on the same generic {@link parseSelection}/{@link projectThrough} engine
 * (`field-select.ts`) rather than a second, parallel mechanism.
 *
 * Locations have a much smaller vocabulary than items: everything already in {@link LocationDto}
 * is a **default** field, and the one **extended** field is `fieldValues` — the custom-field
 * values the location holds (the app's field dictionary). Those are the metadata an integration
 * wants to read off a location: the entity id of the lamp above a shelf, a QR label, a supplier
 * reference. They are opt-in (`include=fields`) so the default location payload is unchanged
 * byte-for-byte and stays cheap for the list endpoint.
 */
import { CategoryRepository } from '@/db/repositories/CategoryRepository.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { LocationWithCount } from '@/db/repositories/types';
import { toLocationFieldValues, type LocationFieldValueDto } from './dto.ts';
import {
  parseSelection,
  projectThrough,
  type FieldNode,
  type FieldRegistry,
  type RawSelection,
  type SelectedField,
} from './field-select.ts';

/**
 * The lazily-resolved view of one location: the row (always present, already carrying its item
 * count) plus a memoised accessor for its custom-field values, so a projection that doesn't ask
 * for them never pays for the read.
 */
export interface LocationViewContext {
  readonly location: LocationWithCount;
  fieldValues(): Promise<readonly LocationFieldValueDto[]>;
}

/** Build a {@link LocationViewContext} over a driver + an already-loaded location row. */
export function createLocationViewContext(
  driver: IDatabaseDriver,
  location: LocationWithCount,
): LocationViewContext {
  let fieldValuesP: Promise<readonly LocationFieldValueDto[]> | undefined;
  return {
    location,
    fieldValues() {
      // Read through the app's own repository seam — the same rows, ordering and
      // inheritability flag the app's location editor shows.
      return (fieldValuesP ??= (async () =>
        toLocationFieldValues(await new CategoryRepository(driver).listLocationFieldValues(location.id)))());
    },
  };
}

/** Element sub-keys for the one nested (array-of-object) field — kept in sync with the DTO. */
const LOCATION_FIELD_VALUE_KEYS = ['name', 'fieldType', 'value', 'isInheritable'] as const;

/** The complete location field registry, in the order fields appear in a projected response. */
const LOCATION_FIELDS: readonly (readonly [string, FieldNode<LocationViewContext>])[] = [
  ['id', { resolve: (c) => c.location.id }],
  ['name', { resolve: (c) => c.location.name }],
  ['parentId', { resolve: (c) => c.location.parentId }],
  ['isSystem', { resolve: (c) => c.location.isSystem }],
  ['description', { resolve: (c) => c.location.description }],
  ['color', { resolve: (c) => c.location.color }],
  ['itemCount', { resolve: (c) => c.location.itemCount }],
  ['fieldValues', { resolve: (c) => c.fieldValues(), elementKeys: LOCATION_FIELD_VALUE_KEYS }],
];

/** The location field registry as a lookup map (iteration order preserved). */
export const LOCATION_FIELD_REGISTRY: FieldRegistry<LocationViewContext> = new Map(LOCATION_FIELDS);

/** The default field set of both location endpoints — exactly today's `LocationDto` shape. */
export const LOCATION_DEFAULT_FIELDS: readonly string[] = [
  'id',
  'name',
  'parentId',
  'isSystem',
  'description',
  'color',
  'itemCount',
];

/** Named field groups a caller may use in `include`. `fields` mirrors the item vocabulary. */
export const LOCATION_INCLUDE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  fields: ['fieldValues'],
  all: [...LOCATION_FIELD_REGISTRY.keys()],
};

/** Parse a raw location selection against the location registry. */
export function parseLocationSelection(raw: RawSelection): readonly SelectedField[] {
  return parseSelection(
    {
      registry: LOCATION_FIELD_REGISTRY,
      defaults: LOCATION_DEFAULT_FIELDS,
      aliases: LOCATION_INCLUDE_ALIASES,
    },
    raw,
  );
}

/** Project one location view through a resolved selection. */
export function projectLocation(
  ctx: LocationViewContext,
  selection: readonly SelectedField[],
): Promise<Record<string, unknown>> {
  return projectThrough(LOCATION_FIELD_REGISTRY, selection, ctx);
}
