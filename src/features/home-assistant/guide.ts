import type { LucideIcon } from '@/components/icons';
import {
  CelebrateIcon,
  CloudUploadIcon,
  ExtensionIcon,
  InfoIcon,
  KeyIcon,
  ServerIcon,
  SettingsIcon,
  VoiceIcon,
} from '@/components/icons';

/**
 * The Home Assistant setup guide — step model (single source of truth).
 *
 * The guide walks a user through linking a local Gubbins bridge to Home Assistant's voice
 * assistant. It is deliberately a **linear backbone of steps**, where each step then
 * *branches* internally on the choices the user makes (where the bridge runs, HACS vs
 * manual, discovery vs manual config, …) and on the outcome they got. Keeping the backbone
 * linear — and the branching local to each step — makes the flow predictable, keeps every
 * step reachable, and keeps this metadata tiny.
 *
 * This module is pure: the step list plus a handful of navigation helpers, all unit-tested.
 * The screen renders the current step's component and uses these helpers to move between
 * steps and draw the progress rail.
 */

/** Stable step identifiers — used as keys, in tests, and for the `?step=` deep link. */
export type GuideStepId =
  'overview' | 'token' | 'bridge' | 'data' | 'integration' | 'configure' | 'sentences' | 'finish';

export interface GuideStep {
  readonly id: GuideStepId;
  /** Short label shown in the progress rail. */
  readonly label: string;
  /** One-line description shown under the step heading. */
  readonly summary: string;
  readonly Icon: LucideIcon;
}

/** Every step, in order. Adding a step means adding one entry here and one component. */
export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    id: 'overview',
    label: 'Overview',
    summary: 'What you are about to build, and what you need before you start.',
    Icon: InfoIcon,
  },
  {
    id: 'token',
    label: 'Access token',
    summary: 'Create the secret bearer token the bridge and Home Assistant will share.',
    Icon: KeyIcon,
  },
  {
    id: 'bridge',
    label: 'Run the bridge',
    summary: 'Start the local companion service that answers questions about your inventory.',
    Icon: ServerIcon,
  },
  {
    id: 'data',
    label: 'Feed it data',
    summary: 'Get your inventory to the bridge — via a synced folder or a direct push.',
    Icon: CloudUploadIcon,
  },
  {
    id: 'integration',
    label: 'Install in HA',
    summary: 'Add the Gubbins integration to Home Assistant (HACS, manual, or no-code).',
    Icon: ExtensionIcon,
  },
  {
    id: 'configure',
    label: 'Connect',
    summary: 'Point Home Assistant at the bridge and verify the connection.',
    Icon: SettingsIcon,
  },
  {
    id: 'sentences',
    label: 'Voice sentences',
    summary: 'Teach Assist the phrases — and bridge a Google Home / Nest speaker if you use one.',
    Icon: VoiceIcon,
  },
  {
    id: 'finish',
    label: 'Try it',
    summary: 'Ask your first question — and where to turn if something is off.',
    Icon: CelebrateIcon,
  },
];

/** The id of the first step — the guide's entry point. */
export const FIRST_STEP_ID: GuideStepId = GUIDE_STEPS[0]!.id;

/** Zero-based index of a step id, or `-1` if unknown. */
export function indexOfStep(id: GuideStepId): number {
  return GUIDE_STEPS.findIndex((step) => step.id === id);
}

/** True when `id` names a real step (used to validate a `?step=` deep link). */
export function isGuideStepId(id: string): id is GuideStepId {
  return GUIDE_STEPS.some((step) => step.id === id);
}

/** The step after `id`, or `null` at the end. */
export function nextStepId(id: GuideStepId): GuideStepId | null {
  const i = indexOfStep(id);
  return i >= 0 && i < GUIDE_STEPS.length - 1 ? GUIDE_STEPS[i + 1]!.id : null;
}

/** The step before `id`, or `null` at the start. */
export function prevStepId(id: GuideStepId): GuideStepId | null {
  const i = indexOfStep(id);
  return i > 0 ? GUIDE_STEPS[i - 1]!.id : null;
}

/** Human progress, e.g. `{ current: 3, total: 8, percent: 38 }` (1-based `current`). */
export function progressFor(id: GuideStepId): { current: number; total: number; percent: number } {
  const total = GUIDE_STEPS.length;
  const i = indexOfStep(id);
  const current = i < 0 ? 1 : i + 1;
  return { current, total, percent: Math.round((current / total) * 100) };
}
