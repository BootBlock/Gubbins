import {
  FolderIcon,
  FolderOpenIcon,
  LocationBagIcon,
  LocationBinIcon,
  LocationBoxIcon,
  LocationBuildingIcon,
  LocationCabinetIcon,
  LocationDrawerIcon,
  LocationOtherIcon,
  LocationRoomIcon,
  LocationShelfIcon,
  LocationVehicleIcon,
  type LucideIcon,
} from '@/components/icons';
import { isLocationKind, type LocationKind } from '../location-kind';

/** Semantic type key → its lucide glyph. */
const KIND_ICON: Record<LocationKind, LucideIcon> = {
  building: LocationBuildingIcon,
  room: LocationRoomIcon,
  cabinet: LocationCabinetIcon,
  shelf: LocationShelfIcon,
  drawer: LocationDrawerIcon,
  bin: LocationBinIcon,
  box: LocationBoxIcon,
  bag: LocationBagIcon,
  vehicle: LocationVehicleIcon,
  other: LocationOtherIcon,
};

/**
 * Renders the icon for a location's type `kind`. An untyped location (null/unknown key)
 * falls back to the generic folder glyph — open when it has expanded children, matching
 * the previous tree behaviour.
 */
export function LocationKindIcon({
  kind,
  expanded,
  className,
}: {
  readonly kind: string | null | undefined;
  /** For the folder fallback only: show the open folder when the node is expanded. */
  readonly expanded?: boolean;
  readonly className?: string;
}) {
  if (isLocationKind(kind)) {
    const Icon = KIND_ICON[kind];
    return <Icon className={className} aria-hidden />;
  }
  const Fallback = expanded ? FolderOpenIcon : FolderIcon;
  return <Fallback className={className} aria-hidden />;
}
