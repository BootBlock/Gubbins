/**
 * Central icon registry (spec §2.4.1).
 *
 * lucide-react is the only permitted icon library, and feature components must
 * import icons from here under semantic names — never reach into lucide-react
 * directly. This lets us rename, restyle or swap individual glyphs in one place.
 *
 * Note: lucide v1 renamed many glyphs (e.g. AlertTriangle → TriangleAlert,
 * CheckCircle2 → CircleCheck, Loader2 → LoaderCircle); the mappings below use the
 * current identifiers.
 */
export {
  // Brand
  Boxes as BrandIcon,
  Package as PackageIcon,

  // Status / feedback
  TriangleAlert as WarningIcon,
  ShieldAlert as CriticalIcon,
  ShieldCheck as SecureIcon,
  CircleAlert as AlertIcon,
  CircleCheck as SuccessIcon,
  CircleX as ErrorIcon,
  Info as InfoIcon,

  // Storage / database
  Database as DatabaseIcon,
  DatabaseZap as MigrationIcon,
  HardDrive as StorageIcon,
  HardDriveDownload as ArchiveIcon,

  // Actions
  Download as DownloadIcon,
  RefreshCw as RefreshIcon,
  RotateCcw as ResetIcon,
  Copy as DuplicateTabIcon,
  X as CloseIcon,
  Plus as AddIcon,
  Minus as SubtractIcon,
  Trash2 as DeleteIcon,
  Pencil as EditIcon,
  FolderTree as MoveIcon,
  Search as SearchIcon,
  ChevronRight as ChevronRightIcon,
  ChevronDown as ChevronDownIcon,
  Undo2 as RestoreIcon,

  // Inventory / domain
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  Gauge as GaugeIcon,
  Hash as DiscreteIcon,
  ScanBarcode as SerialisedIcon,
  History as HistoryIcon,
  Shapes as CategoryIcon,
  Tag as TagIcon,
  Tags as TagsIcon,
  Image as ImageIcon,
  Upload as UploadIcon,
  FileText as DatasheetIcon,
  Link as LinkIcon,
  HardDriveDownload as LocalFileIcon,
  SlidersHorizontal as SettingsIcon,
  Check as CheckIcon,

  // Projects, BOMs & procurement (Phase 4, §4)
  ClipboardList as ProjectIcon,
  ShoppingCart as ShoppingCartIcon,
  Truck as TruckIcon,
  Wrench as AssemblyIcon,
  PoundSterling as CostIcon,
  BookmarkCheck as ReserveIcon,
  FileUp as ImportIcon,

  // Layout density (Data-Heavy ↔ Visual-Heavy, §3)
  Rows3 as DataDensityIcon,
  LayoutGrid as VisualDensityIcon,
} from 'lucide-react';

export type { LucideIcon, LucideProps } from 'lucide-react';
