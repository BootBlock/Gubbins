/**
 * The Foundry — Gubbins' internal UI primitive registry (spec §2.4.1).
 *
 * Feature components must import primitives from here, never from shadcn/ui or a
 * third-party library directly. This indirection lets us swap the underlying
 * implementation (hand-built ⇄ shadcn ⇄ bespoke-optimised) without refactoring
 * any call site.
 */
export { Button, buttonVariants, type ButtonProps } from './button';
export { Banner, bannerVariants, type BannerProps } from './banner';
export { Surface } from './surface';
export { Spinner, type SpinnerProps } from './spinner';
export { Input, Select, Textarea } from './input';
export { FormField, type FormFieldProps } from './field';
export { fieldAria, type FieldAria, type FieldControlAria } from './field-aria';
export { Modal, type ModalProps } from './modal';
export { Markdown } from './markdown';
export { InfoHint } from './info-hint';
export {
  Tooltip,
  DEFAULT_OPEN_DELAY_MS,
  INFO_OPEN_DELAY_MS,
  NAV_OPEN_DELAY_MS,
  type TooltipProps,
  type TooltipPlacement,
} from './tooltip';
export { SkipLink, MAIN_CONTENT_ID } from './skip-link';
export { PageHeader, type PageHeaderProps } from './page-header';
export {
  Menu,
  MenuLink,
  MenuAction,
  MenuSeparator,
  type MenuProps,
  type MenuLinkProps,
  type MenuActionProps,
} from './menu';
export { LiveRegion, type LiveRegionProps, type LiveUrgency } from './live-region';
export { liveRegionAttrs, type LiveRegionAttrs } from './aria-live';
export { ToastProvider, useToast, type ToastOptions, type ToastTone } from './toast';
export {
  useReducedMotion,
  defaultMediaQueryProvider,
  type MediaQueryLike,
  type MediaQueryProvider,
} from './useReducedMotion';
export {
  useInstallPrompt,
  browserInstallPromptApi,
  type InstallPromptApi,
  type InstallPromptState,
  type InstallPromptHandlers,
  type BeforeInstallPromptEventLike,
} from './useInstallPrompt';
