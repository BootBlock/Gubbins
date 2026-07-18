/**
 * seasonal — which (if any) seasonal garnish the background weather layer should mix into its
 * falling field today.
 *
 * The app-wide rain/snow layer ({@link import('./precip-engine').startPrecip}) is a plain
 * particle field all year round. On a handful of days it also carries a *sparse* drift of
 * themed emoji — a few presents through December's snow, a pumpkin or two around Halloween.
 * It is deliberately a garnish, not an effect of its own: it only appears when a background
 * effect is already running, and at a fraction of the field's density, so it reads as a small
 * surprise rather than a takeover.
 *
 * This module is **pure** — a date (and the lab overrides) in, an occasion out — so every
 * window, including the moving Easter date, is unit-testable without waiting a year. The engine
 * consumes only {@link SeasonalOccasion.emoji}; everything else here is for the picker UI.
 */

import type { MessageKey } from '@/features/i18n/messages';

/** Stable id for one seasonal occasion. Persisted in the lab-flag overrides — do not rename. */
export type OccasionId =
  'cats' | 'celebration' | 'valentines' | 'bonfire' | 'new-year' | 'easter' | 'halloween' | 'christmas';

/** How a single occasion is gated. `auto` = its calendar window decides (the shipped default). */
export type OccasionMode = 'auto' | 'on' | 'off';

/** Per-occasion overrides, keyed by {@link OccasionId}; a missing key means `auto`. */
export type OccasionOverrides = Readonly<Partial<Record<OccasionId, OccasionMode>>>;

export interface SeasonalOccasion {
  readonly id: OccasionId;
  /**
   * Short human label, and one line describing when the occasion runs — both shown by the lab
   * picker. The displayed text comes from the catalog via {@link labelKey} / {@link windowKey};
   * these English fields are the base reference and a drift test holds them byte-identical.
   */
  readonly label: string;
  readonly window: string;
  readonly labelKey: MessageKey;
  readonly windowKey: MessageKey;
  /** The garnish sprite set — one is picked per particle at spawn. */
  readonly emoji: readonly string[];
  /** Does `date` (read in local time) fall inside this occasion's window? */
  readonly inWindow: (date: Date) => boolean;
}

/** Month/day pair test against a local date (`month` is 1-based, unlike `Date.getMonth`). */
function isDay(date: Date, month: number, day: number): boolean {
  return date.getMonth() === month - 1 && date.getDate() === day;
}

/** Is `date` one of the given `[month, day]` pairs? */
function isAnyDay(date: Date, days: readonly (readonly [number, number])[]): boolean {
  return days.some(([m, d]) => isDay(date, m, d));
}

/** Local midnight of `date`, so window maths compares whole days rather than instants. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole days between two local dates (positive when `date` is after `from`). */
function daysBetween(date: Date, from: Date): number {
  return Math.round((startOfDay(date) - startOfDay(from)) / 86_400_000);
}

/**
 * Easter Sunday for a Gregorian year, by the anonymous (Meeus/Jones/Butcher) algorithm. Returns a
 * local-time `Date` at midnight. Easter moves — it is the only window here that can't be a fixed
 * month/day pair — so it gets the real computation rather than a hard-coded table that would
 * quietly expire.
 */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/** How many days either side of Easter Sunday the garnish runs. */
const EASTER_SPREAD = 7;

/**
 * Every occasion, in **priority order** — the first whose window contains today wins. Ordered
 * most-specific-first so a single day beats a season it sits inside: New Year's Eve shows
 * fireworks rather than the December presents it overlaps.
 */
export const OCCASIONS: readonly SeasonalOccasion[] = [
  {
    id: 'cats',
    labelKey: 'lab.occasion.cats.label',
    windowKey: 'lab.occasion.cats.window',
    label: 'Cats',
    window: '20 May',
    emoji: ['🐱', '🐈', '😻', '🐾', '🐈‍⬛'],
    inWindow: (date) => isDay(date, 5, 20),
  },
  {
    id: 'celebration',
    labelKey: 'lab.occasion.celebration.label',
    windowKey: 'lab.occasion.celebration.window',
    label: 'Celebration',
    window: '25 February, 3 March, 1 July',
    emoji: ['🎂', '🎈', '🎉', '🎁'],
    inWindow: (date) =>
      isAnyDay(date, [
        [2, 25],
        [3, 3],
        [7, 1],
      ]),
  },
  {
    id: 'valentines',
    labelKey: 'lab.occasion.valentines.label',
    windowKey: 'lab.occasion.valentines.window',
    label: 'Valentine’s',
    window: '14 February',
    emoji: ['💝', '🌹', '💕', '❤️'],
    inWindow: (date) => isDay(date, 2, 14),
  },
  {
    id: 'bonfire',
    labelKey: 'lab.occasion.bonfire.label',
    windowKey: 'lab.occasion.bonfire.window',
    label: 'Fireworks',
    window: '5 November',
    emoji: ['🎆', '🎇', '✨', '🔥'],
    inWindow: (date) => isDay(date, 11, 5),
  },
  {
    id: 'new-year',
    labelKey: 'lab.occasion.new-year.label',
    windowKey: 'lab.occasion.new-year.window',
    label: 'New Year',
    window: '31 December – 2 January',
    emoji: ['🎉', '🥂', '✨', '🎊'],
    inWindow: (date) =>
      isDay(date, 12, 31) || (date.getMonth() === 0 && date.getDate() >= 1 && date.getDate() <= 2),
  },
  {
    id: 'easter',
    labelKey: 'lab.occasion.easter.label',
    windowKey: 'lab.occasion.easter.window',
    label: 'Easter',
    window: 'the week either side of Easter Sunday',
    emoji: ['🥚', '🐰', '🌷', '🐣'],
    inWindow: (date) => Math.abs(daysBetween(date, easterSunday(date.getFullYear()))) <= EASTER_SPREAD,
  },
  {
    id: 'halloween',
    labelKey: 'lab.occasion.halloween.label',
    windowKey: 'lab.occasion.halloween.window',
    label: 'Halloween',
    window: '24 – 31 October',
    emoji: ['🎃', '👻', '🦇', '🕷️'],
    inWindow: (date) => date.getMonth() === 9 && date.getDate() >= 24,
  },
  {
    id: 'christmas',
    labelKey: 'lab.occasion.christmas.label',
    windowKey: 'lab.occasion.christmas.window',
    label: 'Christmas',
    window: '1 – 31 December',
    emoji: ['🎁', '🎄', '⭐', '🔔'],
    inWindow: (date) => date.getMonth() === 11,
  },
] as const;

/** Look one up by id (unknown ids — e.g. a stale stored override — read as absent). */
export function getOccasion(id: string): SeasonalOccasion | undefined {
  return OCCASIONS.find((occasion) => occasion.id === id);
}

/**
 * The occasion whose garnish should be falling right now, or `null` for the usual plain field.
 *
 * Each occasion is gated by its own mode: `auto` (the default) defers to the calendar window,
 * `on` forces it regardless of the date, and `off` suppresses it even in season. Registry order
 * is the tiebreak, so a forced occasion still loses to a more specific one that is also active —
 * which keeps "force everything on" showing the same single field the calendar would.
 */
export function resolveOccasion(date: Date, overrides: OccasionOverrides = {}): SeasonalOccasion | null {
  for (const occasion of OCCASIONS) {
    const mode = overrides[occasion.id] ?? 'auto';
    if (mode === 'off') continue;
    if (mode === 'on' || occasion.inWindow(date)) return occasion;
  }
  return null;
}
