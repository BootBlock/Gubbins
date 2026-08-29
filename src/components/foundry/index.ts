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
export { Banner, bannerVariants, type BannerProps } from './banner';
export { Surface, type SurfaceProps } from './surface';
// The shared visual language for a selectable option-card tile — base chrome, focus ring and
// the selected/unselected token pair, at one of four densities. Call sites bring their own
// layout, interaction and ARIA.
export { optionCardClassName, type OptionCardSize } from './option-card';
export { ReorderList, type ReorderListProps, type ReorderListItem } from './reorder-list';
export { Spinner, type SpinnerProps } from './spinner';
export { Input, Checkbox, type InputProps } from './input';
// The COLOUR custom field's control (issue #452): a box that reads any colour notation, a
// native swatch, and a menu that re-renders the value in another notation. `ColourSwatch` is
// its read-only half, for cards, tables and detail panels.
export { ColourInput, ColourSwatch, type ColourInputProps } from './colour-input';
export { Textarea, DEFAULT_TEXTAREA_MAX_ROWS, type TextareaProps } from './textarea';
export { Radio } from './radio';
export { NumberInput, type NumberInputProps } from './number-input';
export {
  evaluateExpression,
  hasCalcExpression,
  formatCalcResult,
  type EvalResult,
} from './evaluate-expression';
// Only the parser is app-wide surface — a call site reading its own field's text needs the same
// rules the control applies. The bound arithmetic beside it belongs to `NumberInput` alone, which
// imports it directly, so exporting it here would make a private seam a public API with no caller.
export { parseNumericText } from './numeric-bounds';
export { Select, type SelectProps, type SelectOption } from './select';
export { SelectField, type SelectFieldProps } from './select-field';
export {
  CurrencySelect,
  CurrencyAutocompleteField,
  type CurrencySelectProps,
  type CurrencyAutocompleteFieldProps,
} from './currency-select';
export { DEFAULT_CURRENCY_HINT, currencyCodeFromInput } from './currency-options';
export {
  Autocomplete,
  AutocompleteField,
  type AutocompleteProps,
  type AutocompleteFieldProps,
} from './autocomplete';
export { filterSuggestions } from './autocomplete-filter';
export {
  PICKER_OPTION_LIMIT,
  buildPickerLabelMap,
  usePickerSelection,
  type PickerRowAccess,
  type PickerSelection,
  type PickerSelectionParams,
} from './entity-picker';
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
// The honest footer for a list that renders only the head of a set it holds in full, plus the
// counting hook it pairs with (issue #609).
export { ShowMore, type ShowMoreProps } from './show-more';
export {
  useProgressiveReveal,
  type ProgressiveReveal,
  type ProgressiveRevealOptions,
} from './use-progressive-reveal';
export { Money, type MoneyProps } from './money';
export { MoneyInput, type MoneyInputProps } from './money-input';
export { AnimatedNumber, type AnimatedNumberProps } from './animated-number';
export {
  useCountUp,
  COUNT_UP_DURATION_MS,
  COUNT_UP_HEADLINE_DURATION_MS,
  type CountUpOptions,
} from './useCountUp';
export { Bar, type BarProps } from './bar';
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
export {
  useInViewport,
  DEFAULT_VIEWPORT_MARGIN,
  type InViewportOptions,
  type InViewportState,
} from './useInViewport';
export { FormField, type FormFieldProps } from './field';
export { fieldAria, type FieldAria, type FieldControlAria } from './field-aria';
export { Modal, type ModalProps } from './modal';
// How an editor tells the dialog around it that it holds work nobody has written yet, so a
// dismissal asks before discarding it (issue #576). Only the editor-side hook is re-exported:
// the registry and its context are the frame's half of the contract, and a feature reaching for
// those is hand-rolling a dialog rather than composing `Modal`.
export { useReportUnsavedChanges } from './unsaved-changes';
// How a panel below a dialog tells the frame it has work in flight, so every route out — Escape,
// the backdrop and the ✕ — is refused until it finishes (issue #654). A dialog that renders its
// own `Modal` passes the `busy` prop instead; only the panel-side hook needs re-exporting, for
// the same reason as its unsaved-changes neighbour above.
// `useDialogIsBusy` is the read side of the same seam, for a control inside a dialog that would
// take a panel down as surely as closing the dialog would (a tab rail switching panels).
export { useReportDialogBusy, useDialogIsBusy } from './dialog-busy';
// Off-canvas panel for a master pane that can't sit beside its detail pane on a compact
// viewport. It shares Modal's `aria-modal` contract through `use-dialog-behaviour`, which is
// deliberately *not* re-exported: a feature needing a modal surface composes one of these two
// primitives rather than hand-rolling a third from the hook. The exception is a surface that
// genuinely cannot be either — the two full-screen camera takeovers, which must own the whole
// viewport and paint no panel — and those import the hook by path rather than restate it.
export { Drawer, type DrawerProps } from './drawer';
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
// Region canvas — a photo with a drawable shape overlay (location photos, issue #81). Read-only
// by default, so the item-side viewer and the region editor are the same component.
export { RegionCanvas, type RegionCanvasProps, type RegionCanvasRegion } from './region-canvas';
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
export { Interstitial, type InterstitialProps } from './interstitial';
export { PageHeader, type PageHeaderProps } from './page-header';
export { PageContainer, type PageContainerProps } from './page-container';
export { Menu, type MenuProps } from './menu';
export { MenuLink, type MenuLinkProps } from './menu-link';
export { MenuExternalLink, type MenuExternalLinkProps } from './menu-external-link';
export { MenuAction, type MenuActionProps } from './menu-action';
export { MenuSeparator } from './menu-separator';
export { MenuSub, type MenuSubProps } from './menu-sub';
export { LiveRegion, type LiveRegionProps, type LiveUrgency } from './live-region';
export { liveRegionAttrs, type LiveRegionAttrs } from './aria-live';
export { ToastProvider, useToast, useOptionalToast, type ToastOptions, type ToastTone } from './toast';
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
  BURST_HUE_SPREAD,
  type BurstParticle,
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
export { useMediaQuery, useLargeFormat, useCompactLayout } from './useMediaQuery';
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
export { useSlidingIndicator, type IndicatorGeometry } from './use-sliding-indicator';
export {
  useInstallPrompt,
  browserInstallPromptApi,
  type InstallPromptApi,
  type InstallPromptState,
  type InstallPromptHandlers,
  type BeforeInstallPromptEventLike,
} from './useInstallPrompt';
