/**
 * The Foundry — Gubbins' internal UI primitive registry (spec §2.4.1).
 *
 * Feature components must import primitives from here, never from shadcn/ui or a
 * third-party library directly. This indirection lets us swap the underlying
 * implementation (hand-built ⇄ shadcn ⇄ bespoke-optimised) without refactoring
 * any call site.
 */
export { Button, buttonVariants, type ButtonProps } from './button';
export { CloseButton, type CloseButtonProps } from './close-button';
export { SplitButton, type SplitButtonProps } from './split-button';
export { Banner, bannerVariants, type BannerProps } from './banner';
export { Surface, type SurfaceProps } from './surface';
export { ReorderList, type ReorderListProps, type ReorderListItem } from './reorder-list';
export { Spinner, type SpinnerProps } from './spinner';
export { Input, Textarea, Checkbox, type InputProps } from './input';
export { NumberInput, type NumberInputProps } from './number-input';
export {
  evaluateExpression,
  hasCalcExpression,
  formatCalcResult,
  type EvalResult,
} from './evaluate-expression';
export { Select, SelectField, type SelectProps, type SelectFieldProps, type SelectOption } from './select';
export {
  Autocomplete,
  AutocompleteField,
  type AutocompleteProps,
  type AutocompleteFieldProps,
} from './autocomplete';
export { filterSuggestions } from './autocomplete-filter';
export { Pagination, type PaginationProps } from './pagination';
export {
  pageCount,
  clampPage,
  pageSliceBounds,
  pageOffset,
  pageWindow,
  type PageWindowItem,
  type PageWindowOptions,
} from './pagination-window';
export { Money, type MoneyProps } from './money';
export { MoneyInput, type MoneyInputProps } from './money-input';
export { AnimatedNumber, type AnimatedNumberProps } from './animated-number';
export { useCountUp, type CountUpOptions } from './useCountUp';
export { Reveal, type RevealProps } from './reveal';
export {
  useRevealOnScroll,
  revealStaggerMs,
  defaultObserverFactory,
  DEFAULT_REVEAL_ROOT_MARGIN,
  REVEAL_STAGGER_STEP_MS,
  REVEAL_STAGGER_CAP,
  type RevealOnScrollOptions,
  type RevealState,
  type ObserverLike,
  type IntersectionObserverFactory,
} from './useRevealOnScroll';
export { FormField, type FormFieldProps } from './field';
export { fieldAria, type FieldAria, type FieldControlAria } from './field-aria';
export { Modal, type ModalProps } from './modal';
// The open-dialog count, so app-global keyboard handling can stand aside while a modal owns
// the keyboard (issue #32) — the same LIFO registry Modal itself uses to arbitrate Escape.
export { openModalCount } from './modal-stack';
// Glyph picker — the app-wide icon chooser. The full catalogue-bearing `GlyphPicker`
// dialog is intentionally *not* re-exported here: it is reached only through the lazy
// `GlyphPickerButton` (or a direct subpath import) so its icon set never lands in the
// main bundle. `Glyph` displays a single chosen glyph; the name helpers are pure.
export { Glyph, type GlyphProps } from './glyph-picker/Glyph';
export { GlyphPickerButton, type GlyphPickerButtonProps } from './glyph-picker/GlyphPickerButton';
export { type GlyphPickerProps } from './glyph-picker/GlyphPicker';
export { humanizeGlyphName, glyphSearchText, filterGlyphNames } from './glyph-picker/glyph-name';
// Emoji picker — the app-wide Unicode-glyph chooser (issue #83), distinct from the Lucide
// glyph picker above. Only the lazy `EmojiPickerButton` is re-exported: the `EmojiPicker`
// dialog and its emoji catalogue/search helpers are reached solely through that button's
// dynamic import (or a direct subpath import), so the catalogue never lands in the eager
// bundle — the same discipline the Lucide picker uses for its registry.
export { EmojiPickerButton, type EmojiPickerButtonProps } from './emoji-picker/EmojiPickerButton';
export { type EmojiPickerProps } from './emoji-picker/EmojiPicker';
export { RailModal, type RailModalProps, type RailTab } from './rail-modal';
export { resolveTabKey } from './tab-keyboard';
export { useSearchEscapeToClear } from './use-search-escape';
export { InputClearButton, type InputClearButtonProps } from './input-clear-button';
export { Kbd, type KbdProps } from './kbd';
export { Markdown } from './markdown';
export { InfoHint } from './info-hint';
export {
  Tooltip,
  DEFAULT_OPEN_DELAY_MS,
  INFO_OPEN_DELAY_MS,
  NAV_OPEN_DELAY_MS,
  type TooltipProps,
  type TooltipPlacement,
  type TooltipSize,
} from './tooltip';
export { SkipLink, MAIN_CONTENT_ID } from './skip-link';
export { PageHeader, type PageHeaderProps } from './page-header';
export { PageContainer, type PageContainerProps } from './page-container';
export {
  Menu,
  MenuLink,
  MenuExternalLink,
  MenuAction,
  MenuSeparator,
  MenuSub,
  type MenuProps,
  type MenuLinkProps,
  type MenuExternalLinkProps,
  type MenuActionProps,
  type MenuSubProps,
} from './menu';
export { LiveRegion, type LiveRegionProps, type LiveUrgency } from './live-region';
export { liveRegionAttrs, type LiveRegionAttrs } from './aria-live';
export { ToastProvider, useToast, type ToastOptions, type ToastTone } from './toast';
export {
  BurstProvider,
  useBurst,
  type BurstProviderProps,
  type BurstOptions,
  type BurstOrigin,
} from './success-burst';
export {
  buildBurstParticles,
  BURST_PARTICLE_COUNT,
  BURST_DURATION_MS,
  type BurstParticle,
  type BurstHue,
  type Rng,
} from './success-burst-geometry';
export {
  useReducedMotion,
  defaultMediaQueryProvider,
  type MediaQueryLike,
  type MediaQueryProvider,
} from './useReducedMotion';
export {
  withViewTransition,
  shouldViewTransition,
  useViewTransitionsEnabled,
  viewTransitionsSupported,
  resolveRouteViewTransitionTypes,
  ROUTE_VIEW_TRANSITION_TYPE,
} from './view-transition';
export { useMediaQuery, useLargeFormat } from './useMediaQuery';
export { usePointerTilt, type PointerTiltOptions, type PointerTiltHandlers } from './usePointerTilt';
export {
  computeTilt,
  computeShouldTilt,
  DEFAULT_TILT_CONFIG,
  REST_TILT_VARS,
  FINE_POINTER_QUERY,
  type TiltConfig,
  type TiltVars,
} from './pointer-tilt';
export { useRovingRadioGroup } from './useRovingRadioGroup';
export { SegmentedRadioGroup, type SegmentedOption } from './segmented-radio-group';
export {
  useInstallPrompt,
  browserInstallPromptApi,
  type InstallPromptApi,
  type InstallPromptState,
  type InstallPromptHandlers,
  type BeforeInstallPromptEventLike,
} from './useInstallPrompt';
