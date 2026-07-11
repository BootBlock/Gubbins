import { APP_VERSION, APP_RELEASE_DATE } from '@/lib/app-version';

/**
 * Environment diagnostics for the About screen's collapsible Diagnostics card.
 *
 * Everything here is *environmental* — browser, viewport, appearance preferences, storage
 * headroom — never inventory data or anything the user has entered. It is gathered on the
 * device only when the user presses Refresh (never automatically) and is only sent anywhere
 * if the user chooses to copy it or open a pre-filled GitHub issue.
 *
 * Values are captured raw/typed here; presentation (translated labels, localized words) lives
 * with the consumer. The one English formatter, {@link formatDiagnosticsText}, produces the
 * copy/issue payload — deliberately English and stable so a bug report reads the same for the
 * maintainer regardless of the reporter's UI language.
 */
export interface Diagnostics {
  /** Application version (from package.json via the build). */
  readonly version: string;
  /** Release/build date, ISO `YYYY-MM-DD`. */
  readonly buildDate: string;
  /** Full `navigator.userAgent` — the browser/OS signature a bug report needs. */
  readonly userAgent: string;
  /** Platform hint (`navigator.platform`), best-effort. */
  readonly platform: string;
  /** UI/content language (`navigator.language`). */
  readonly language: string;
  /** Resolved IANA time zone (e.g. `Europe/London`); empty if unavailable. */
  readonly timeZone: string;
  /** UTC offset for the current instant, e.g. `UTC+01:00`. */
  readonly utcOffset: string;
  /** Inner viewport size in CSS pixels. */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** Physical screen size in CSS pixels. */
  readonly screenWidth: number;
  readonly screenHeight: number;
  /** Device pixel ratio. */
  readonly devicePixelRatio: number;
  /** Effective colour scheme from the OS/app preference. */
  readonly colorScheme: 'light' | 'dark';
  /** Whether reduced-motion is requested. */
  readonly reducedMotion: boolean;
  /** Online/offline at capture time. */
  readonly online: boolean;
  /** Whether the app is running as an installed PWA vs a browser tab. */
  readonly displayMode: 'standalone' | 'browser';
  /** Estimated persisted storage used / quota, in bytes; `undefined` when the API is unavailable. */
  readonly storageUsage?: number;
  readonly storageQuota?: number;
}

/** The ordered set of fields shown in the card and written to the copy/issue payload. */
export const DIAGNOSTIC_FIELD_ORDER = [
  'version',
  'buildDate',
  'browser',
  'platform',
  'language',
  'timezone',
  'viewport',
  'screen',
  'colorScheme',
  'reducedMotion',
  'online',
  'displayMode',
  'storage',
] as const;

export type DiagnosticFieldKey = (typeof DIAGNOSTIC_FIELD_ORDER)[number];

/**
 * The enumerated words a diagnostic value can take. English defaults live here so the payload
 * is stable; the on-screen renderer passes a translated vocabulary so the card honours the UI
 * language. Keeping the words out of {@link formatFieldValue} is what lets one formatter serve
 * both the (English) payload and the (localized) table.
 */
export interface DiagnosticVocab {
  readonly online: string;
  readonly offline: string;
  readonly on: string;
  readonly off: string;
  readonly light: string;
  readonly dark: string;
  readonly installed: string;
  readonly browserTab: string;
  readonly unavailable: string;
}

/** English source-of-truth vocabulary; also the payload's wording. */
export const ENGLISH_DIAGNOSTIC_VOCAB: DiagnosticVocab = {
  online: 'Online',
  offline: 'Offline',
  on: 'On',
  off: 'Off',
  light: 'Light',
  dark: 'Dark',
  installed: 'Installed (PWA)',
  browserTab: 'Browser tab',
  unavailable: 'Unavailable',
};

/** English source-of-truth field labels used in the copy/issue payload. */
export const ENGLISH_DIAGNOSTIC_LABELS: Record<DiagnosticFieldKey, string> = {
  version: 'App version',
  buildDate: 'Build date',
  browser: 'Browser',
  platform: 'Platform',
  language: 'Language',
  timezone: 'Time zone',
  viewport: 'Viewport',
  screen: 'Screen',
  colorScheme: 'Colour scheme',
  reducedMotion: 'Reduced motion',
  online: 'Network',
  displayMode: 'Display mode',
  storage: 'Storage used',
};

/** Human-readable byte size (e.g. `45.2 MB`), base-1000 to match browser storage reporting. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Format one field's value. `redact` coarsens the time zone to its UTC offset only (dropping the
 * region-identifying IANA name) for the public-issue payload; every other field is already
 * environment-only and safe to share. Returns an empty string for a field that carries no value.
 */
export function formatFieldValue(
  key: DiagnosticFieldKey,
  d: Diagnostics,
  vocab: DiagnosticVocab,
  redact: boolean,
): string {
  switch (key) {
    case 'version':
      return d.version;
    case 'buildDate':
      return d.buildDate;
    case 'browser':
      return d.userAgent;
    case 'platform':
      return d.platform || vocab.unavailable;
    case 'language':
      return d.language || vocab.unavailable;
    case 'timezone':
      // Coarsen to the UTC offset for a public issue — the IANA zone name narrows location.
      if (redact || !d.timeZone) return d.utcOffset;
      return `${d.timeZone} (${d.utcOffset})`;
    case 'viewport':
      return `${d.viewportWidth} × ${d.viewportHeight}`;
    case 'screen':
      return `${d.screenWidth} × ${d.screenHeight} @${d.devicePixelRatio}×`;
    case 'colorScheme':
      return d.colorScheme === 'dark' ? vocab.dark : vocab.light;
    case 'reducedMotion':
      return d.reducedMotion ? vocab.on : vocab.off;
    case 'online':
      return d.online ? vocab.online : vocab.offline;
    case 'displayMode':
      return d.displayMode === 'standalone' ? vocab.installed : vocab.browserTab;
    case 'storage':
      if (d.storageUsage === undefined) return vocab.unavailable;
      return d.storageQuota
        ? `${formatBytes(d.storageUsage)} / ${formatBytes(d.storageQuota)}`
        : formatBytes(d.storageUsage);
  }
}

/**
 * Render the diagnostics as a Markdown block for the clipboard or a GitHub issue body. English
 * and stable by design (see {@link Diagnostics}). Pass `redact` for anything that leaves the
 * device destined for a public place.
 */
export function formatDiagnosticsText(d: Diagnostics, { redact }: { redact: boolean }): string {
  const lines = DIAGNOSTIC_FIELD_ORDER.map(
    (key) =>
      `- **${ENGLISH_DIAGNOSTIC_LABELS[key]}:** ${formatFieldValue(key, d, ENGLISH_DIAGNOSTIC_VOCAB, redact)}`,
  );
  return lines.join('\n');
}

/** Repository whose bug-report issue form we pre-fill. */
const REPO_URL = 'https://github.com/BootBlock/Gubbins';

/**
 * Build a "new issue" URL that pre-fills the repository's bug-report form
 * ([.github/ISSUE_TEMPLATE/bug_report.yml]) — GitHub maps query params to form fields by their
 * `id`. We fill `environment` (the one-line browser/OS + version the form already asks for) and
 * drop the full redacted diagnostics into the free-form `extra` ("Anything else?") field, so the
 * report lands in the existing triage workflow rather than a blank issue. The user still writes
 * up what went wrong before submitting.
 */
export function buildIssueUrl(d: Diagnostics): string {
  const params = new URLSearchParams({
    template: 'bug_report.yml',
    environment: `${d.userAgent} · app ${d.version}`,
    extra: `Diagnostics (auto-generated on the About screen):\n\n${formatDiagnosticsText(d, { redact: true })}`,
  });
  return `${REPO_URL}/issues/new?${params.toString()}`;
}

/** Format a signed minutes-from-UTC offset as `UTC±HH:MM`. */
function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

/** Read a media-query match defensively (jsdom and older engines may lack `matchMedia`). */
function media(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/**
 * Capture the current environment diagnostics from the running browser. Called only in response
 * to the user pressing Refresh. Every read is best-effort and guarded so a missing API degrades
 * to a sensible default rather than throwing.
 */
export async function gatherDiagnostics(): Promise<Diagnostics> {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const win = typeof window !== 'undefined' ? window : undefined;

  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    timeZone = '';
  }

  // `getTimezoneOffset` is minutes *behind* UTC, so negate for a conventional `UTC+…` sign.
  const utcOffset = formatUtcOffset(-new Date().getTimezoneOffset());

  const displayMode: 'standalone' | 'browser' =
    media('(display-mode: standalone)') ||
    // iOS Safari exposes standalone via a non-standard navigator flag.
    (nav as { standalone?: boolean } | undefined)?.standalone === true
      ? 'standalone'
      : 'browser';

  let storageUsage: number | undefined;
  let storageQuota: number | undefined;
  try {
    if (nav?.storage?.estimate) {
      const estimate = await nav.storage.estimate();
      storageUsage = estimate.usage;
      storageQuota = estimate.quota;
    }
  } catch {
    storageUsage = undefined;
    storageQuota = undefined;
  }

  return {
    version: APP_VERSION,
    buildDate: APP_RELEASE_DATE,
    userAgent: nav?.userAgent ?? '',
    platform: nav?.platform ?? '',
    language: nav?.language ?? '',
    timeZone,
    utcOffset,
    viewportWidth: win?.innerWidth ?? 0,
    viewportHeight: win?.innerHeight ?? 0,
    screenWidth: win?.screen?.width ?? 0,
    screenHeight: win?.screen?.height ?? 0,
    devicePixelRatio: win?.devicePixelRatio ?? 1,
    colorScheme: media('(prefers-color-scheme: dark)') ? 'dark' : 'light',
    reducedMotion: media('(prefers-reduced-motion: reduce)'),
    online: nav?.onLine ?? true,
    displayMode,
    storageUsage,
    storageQuota,
  };
}
