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
  // Something external is stopping Gubbins working — a content blocker or filtering proxy
  // that stripped one of its own scripts (see the boot support diagnosis).
  ShieldOff as BlockedIcon,
  CircleAlert as AlertIcon,
  CircleCheck as SuccessIcon,
  CircleX as ErrorIcon,
  Info as InfoIcon,
  // Micro-calculator affordance on number fields that accept a typed sum (issue #93).
  Calculator as CalculatorIcon,
  // Wayfinding glyph for the "page not found" screen — a friendly "let's find your way".
  Compass as CompassIcon,

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
  // Favourite pin (issue #23): a filled star marks a favourited item and stars the toggle;
  // StarOff is the "remove from favourites" affordance. Shares the Star glyph with the
  // supplier "preferred" mark above — a distinct semantic role, same visual vocabulary.
  Star as FavouriteIcon,
  StarOff as UnfavouriteIcon,
  // Decorative rarity gem for the "Collector cards" gamification (Appearance flair).
  Gem as RarityIcon,
  FolderTree as MoveIcon,
  // The location hierarchy as a *place* rather than an action — the trigger that opens the
  // locations drawer on a compact viewport. Same glyph as MoveIcon ("move to a location"),
  // under the name that reads correctly at that call site.
  FolderTree as LocationTreeIcon,
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
  Scale as ScaleIcon,
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
  // Substitutions (issue #36) — the two-way "swap / interchangeable" glyph.
  ArrowLeftRight as SubstituteIcon,
  HardDriveDownload as LocalFileIcon,
  SlidersHorizontal as SettingsIcon,
  Check as CheckIcon,

  // Settings & preferences (Phase 12, §3)
  Palette as AppearanceIcon,
  // Branding (issue #110) — the "make it your own" swatch-book glyph, distinct from the Appearance palette.
  SwatchBook as BrandingIcon,
  Moon as DarkThemeIcon,
  Sun as LightThemeIcon,
  Monitor as SystemThemeIcon,
  Tablet as KioskIcon,
  // Keyboard shortcuts (issue #32) — the Hotkeys settings tab and its key-cap affordances.
  Keyboard as HotkeyIcon,
  Bell as NotificationIcon,
  // "Remind me later" — an alert put back to sleep for a while rather than dismissed for good
  // (issue #134). The alarm-clock glyph reads as deferral where a crossed-out bell would read
  // as "never tell me again", which is what the separate dismiss control already means.
  AlarmClock as SnoozeIcon,
  MonitorDown as InstallIcon,

  // Projects, BOMs & procurement (Phase 4, §4)
  ClipboardList as ProjectIcon,
  ShoppingCart as ShoppingCartIcon,
  Truck as TruckIcon,
  Wrench as AssemblyIcon,
  Wrench as ToolsIcon,
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

  // Layout density (Visual-Heavy ↔ Data-Heavy ↔ Table, §3)
  Rows3 as DataDensityIcon,
  LayoutGrid as VisualDensityIcon,
  Table as TableViewIcon,
  // Whole-collection visualisations (§3): a spatial location map + a value treemap.
  Map as MapViewIcon,
  Grid2x2 as TreemapViewIcon,
  // Grouping axis (how the list is arranged, §3)
  Layers as GroupByIcon,
  // Ordering axis (how the list is sorted, issue #128): the axis glyph, plus the two directions
  // used both by the "Sort by" menu and the sortable table-column headers.
  ArrowUpDown as SortIcon,
  ArrowUp as SortAscIcon,
  ArrowDown as SortDescIcon,

  // Fullscreen toggle (issue #118) — enter fills the display; exit returns to windowed.
  Maximize as FullscreenIcon,
  Minimize as ExitFullscreenIcon,

  // Multi-select & batch label printing (Phase 49, §6)
  ListChecks as SelectIcon,

  // Reports & valuation (inventory-depth Phase 61, §3)
  ChartColumn as ReportIcon,
  // Insurance / estate schedule (feature-gap G1) — the "institution / estate" glyph.
  Landmark as InsuranceScheduleIcon,
  // Parts catalogue (issue #22) — a printable, columnar list of items.
  ClipboardList as CatalogueIcon,

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
  // Saved searches (issue #136) — "keep this query for next time", offered on the quick-search
  // box as well as under the power-search field. Shares the Bookmark glyph with the untracked
  // tracking mode above: a distinct semantic role, the same visual vocabulary.
  Bookmark as SavedSearchIcon,

  // QR, scanner, contacts & checkout (Phase 6, §4 Borrowing, §5, §6)
  QrCode as QrCodeIcon,
  ScanLine as ScanIcon,
  // Tap-to-scan / write-to-tag over Web NFC (issue #71) — the contactless "wave" glyph.
  Nfc as NfcIcon,
  Camera as CameraIcon,
  CameraOff as CameraOffIcon,
  // Live-scanner camera controls (issue #135): the camera's own torch for the badly-lit places
  // inventory actually lives in, and the lens picker for a phone with several rear cameras.
  Flashlight as TorchIcon,
  FlashlightOff as TorchOffIcon,
  SwitchCamera as SwitchCameraIcon,
  Users as ContactsIcon,
  UserPlus as AddContactIcon,
  // Sign-in and accounts (issue #79). Distinct from ContactsIcon, which is the address book:
  // a *contact* is somebody you lend a tool to, a *user* is somebody who signs in.
  User as AccountIcon,
  Lock as PasswordIcon,
  LogOut as SignOutIcon,
  // Account administration (issue #79 phase 4): the Users screen and its nav entry, and the
  // roles that bundle permissions. `Shield` is the "what you're allowed to do" glyph; the
  // shield-*check* variant is already spoken for by warranty.
  UserCog as UsersIcon,
  Shield as RoleIcon,
  Phone as PhoneIcon,
  Mail as EmailIcon,
  MapPin as AddressIcon,
  HandCoins as CheckoutIcon,
  Undo2 as CheckInIcon,
  CalendarClock as DueDateIcon,
  // A custom DATE field the user has nominated as a deadline (W1a) — distinct from the
  // agenda's own CalendarClock so a lane's glyph never doubles as its page's.
  CalendarDays as FieldDueIcon,
  CalendarSync as RenewIcon,
  CalendarRange as BookingIcon,
  Printer as PrintIcon,
  FileJson as ExportIcon,
  FolderArchive as VaultIcon,

  // External data scraping via extension (Phase 8, §4, §9)
  DownloadCloud as ScrapeIcon,
  Puzzle as ExtensionIcon,
  // Outbound webhook subscriptions, delivered by the bridge (issue #87)
  Webhook as WebhookIcon,
  Globe as SupplierIcon,
  // Folding one dictionary entry into another (suppliers, issue #384).
  Merge as MergeIcon,

  // Procurement & lifecycle logistics (Phase 9, §4, §4.3, §4.4)
  ClipboardCheck as CycleCountIcon,
  Wrench as MaintenanceIcon,
  CalendarX as ExpiryIcon,
  GitBranch as VariantIcon,

  // Per-instance test / calibration / service records (feature-gap G7) — a lab flask glyph.
  FlaskConical as TestRecordIcon,

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

  // The hidden lab screen (`/lab`) — testing switches for behaviour that is normally automatic.
  FlaskConical as LabIcon,
} from 'lucide-react';

export type { LucideIcon, LucideProps } from 'lucide-react';
