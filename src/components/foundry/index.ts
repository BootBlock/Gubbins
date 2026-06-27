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
export { Input, Select } from './input';
export { Modal, type ModalProps } from './modal';
export { Markdown } from './markdown';
export { Tooltip, type TooltipProps, type TooltipPlacement } from './tooltip';
