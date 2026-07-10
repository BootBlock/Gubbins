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
  // Brand — the app wordmark/logo lives in <BrandMark> (renders the real app icon);
  // PackageIcon is the generic inventory glyph used throughout the UI.
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

  // Database maintenance (compact/optimise, health check, orphan sweep)
  Sparkles as OptimiseIcon,
  Stethoscope as HealthCheckIcon,
  Brush as SweepIcon,

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
  Star as PreferredIcon,
  StarOff as NotPreferredIcon,
  FolderTree as MoveIcon,
  Search as SearchIcon,
  ChevronRight as ChevronRightIcon,
  ChevronDown as ChevronDownIcon,
  ChevronUp as ChevronUpIcon,
  Menu as MenuIcon,
  MoreHorizontal as MoreIcon,
  House as HomeIcon,
  Undo2 as RestoreIcon,
  ArchiveRestore as ArchiveRestoreIcon,

  // Inventory / domain
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,

  // Location types (semantic 'kind' — drives per-location iconography in the tree/pickers)
  Building2 as LocationBuildingIcon,
  DoorOpen as LocationRoomIcon,
  Archive as LocationCabinetIcon,
  Layers as LocationShelfIcon,
  Inbox as LocationDrawerIcon,
  Container as LocationBinIcon,
  Box as LocationBoxIcon,
  ShoppingBag as LocationBagIcon,
  Car as LocationVehicleIcon,
  MapPin as LocationOtherIcon,
  Gauge as GaugeIcon,
  Hash as DiscreteIcon,
  ScanBarcode as SerialisedIcon,
  Bookmark as UntrackedIcon,
  Infinity as InfinityIcon,
  History as HistoryIcon,
  Shapes as CategoryIcon,
  Tag as TagIcon,
  Tags as TagsIcon,
  Image as ImageIcon,
  Upload as UploadIcon,
  FileText as DatasheetIcon,
  Link as LinkIcon,
  ExternalLink as ExternalLinkIcon,
  Unlink as UnlinkIcon,
  HardDriveDownload as LocalFileIcon,
  SlidersHorizontal as SettingsIcon,
  Check as CheckIcon,

  // Settings & preferences (Phase 12, §3)
  Palette as AppearanceIcon,
  Moon as DarkThemeIcon,
  Sun as LightThemeIcon,
  Monitor as SystemThemeIcon,
  Tablet as KioskIcon,
  Bell as NotificationIcon,
  MonitorDown as InstallIcon,

  // Projects, BOMs & procurement (Phase 4, §4)
  ClipboardList as ProjectIcon,
  ShoppingCart as ShoppingCartIcon,
  Truck as TruckIcon,
  Wrench as AssemblyIcon,
  PoundSterling as CostIcon,
  Coins as ValueIcon,
  Receipt as SaleIcon,
  PackageX as WriteOffIcon,
  BookmarkCheck as ReserveIcon,
  Heart as WishlistIcon,
  FileUp as ImportIcon,
  // Project budgeting (Phase 58, §4)
  Wallet as BudgetIcon,
  ReceiptText as ExpenseIcon,
  FolderTree as BudgetCategoryIcon,

  // Layout density (Data-Heavy ↔ Visual-Heavy, §3)
  Rows3 as DataDensityIcon,
  LayoutGrid as VisualDensityIcon,

  // Multi-select & batch label printing (Phase 49, §6)
  ListChecks as SelectIcon,

  // Reports & valuation (inventory-depth Phase 61, §3)
  ChartColumn as ReportIcon,
  // Insurance / estate schedule (feature-gap G1) — the "institution / estate" glyph.
  Landmark as InsuranceScheduleIcon,

  // Customisable dashboard widget board (Phase 45, §3)
  LayoutDashboard as CustomiseIcon,
  GripVertical as DragHandleIcon,
  Eye as ShowIcon,
  EyeOff as HideIcon,
  Pin as PinIcon,
  TrendingDown as LowStockIcon,
  PackageX as OutOfStockIcon,

  // Capabilities & Visual Search (Phase 5, §4 Weighted Capabilities, §5.1)
  Zap as CapabilityIcon,
  Filter as FilterIcon,
  SlidersHorizontal as BuilderIcon,
  FolderPlus as AddGroupIcon,

  // QR, scanner, contacts & checkout (Phase 6, §4 Borrowing, §5, §6)
  QrCode as QrCodeIcon,
  ScanLine as ScanIcon,
  Camera as CameraIcon,
  CameraOff as CameraOffIcon,
  Users as ContactsIcon,
  UserPlus as AddContactIcon,
  Phone as PhoneIcon,
  Mail as EmailIcon,
  MapPin as AddressIcon,
  HandCoins as CheckoutIcon,
  Undo2 as CheckInIcon,
  CalendarClock as DueDateIcon,
  CalendarRange as BookingIcon,
  Printer as PrintIcon,
  FileJson as ExportIcon,
  FolderArchive as VaultIcon,

  // External data scraping via extension (Phase 8, §4, §9)
  DownloadCloud as ScrapeIcon,
  Puzzle as ExtensionIcon,
  Globe as SupplierIcon,

  // Procurement & lifecycle logistics (Phase 9, §4, §4.3, §4.4)
  ClipboardCheck as CycleCountIcon,
  Wrench as MaintenanceIcon,
  CalendarX as ExpiryIcon,
  GitBranch as VariantIcon,

  // Modular UI feature registry (feat/modular-ui) — semantic glyphs for the
  // capability sub-features toggled from the Modules manager. Warranty/asset
  // lifecycle reuses the shield-check "protection" glyph; batches/lots reuse the
  // stacked-layers glyph. `Blocks` is the "building blocks" glyph for the Modules
  // manager screen itself.
  ShieldCheck as WarrantyIcon,
  Layers as BatchIcon,
  Blocks as ModulesIcon,

  // Cloud Sync & File System Access (Phase 7, §7, §2)
  Cloud as CloudIcon,
  CloudOff as OfflineIcon,
  CloudUpload as CloudUploadIcon,
  RefreshCcwDot as SyncIcon,
  FolderSync as FolderSyncIcon,
  PlugZap as ConnectIcon,
  Unplug as DisconnectIcon,

  // Home Assistant setup guide (interactive integration walkthrough)
  KeyRound as KeyIcon,
  Server as ServerIcon,
  Mic as VoiceIcon,
  PartyPopper as CelebrateIcon,
  ClipboardCopy as CopyIcon,
  SquareTerminal as TerminalIcon,
  ChevronLeft as ChevronLeftIcon,
  CircleHelp as HelpIcon,
  BookOpen as WikiIcon,
} from 'lucide-react';

export type { LucideIcon, LucideProps } from 'lucide-react';
