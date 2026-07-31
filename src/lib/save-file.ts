/**
 * Saving a file with an outcome the caller can actually act on (issue #502).
 *
 * {@link downloadBlob} is fire-and-forget by construction: it appends an `<a download>`, clicks
 * it and returns, so a browser that refused, cancelled or ignored the save is indistinguishable
 * from one that wrote the file. That is fine for a convenience export and wrong for the *safety*
 * half of a destructive operation, where the code went on to delete the original on the strength
 * of a side effect it never observed.
 *
 * This module gives those paths a real answer:
 *
 *  - Where the **File System Access API** is available the user chooses a destination and the
 *    bytes are written and closed, so `'saved'` genuinely means the file is on disk — and a write
 *    that fails throws rather than being reported as a success.
 *  - Everywhere else — Firefox, Safari, iOS standalone PWAs and in-app browsers, the platform gap
 *    #482 tracks — the anchor download is still the only route and still cannot report. It
 *    answers `'unverified'`, and the caller must ask the user before destroying anything.
 *
 * The destination is reserved **up front** by {@link prepareSave}, because the picker needs
 * transient user activation and every caller here does real work between the click and the bytes
 * existing: reading pages of history, zipping a backup, integrity-checking a database. Choosing
 * first and writing later is what keeps the verifiable route reachable at all.
 */
import { downloadBlob } from './download';
import { hasFileSystemAccess } from './env/feature-detection';
import { assertExhaustive } from './exhaustive';

/** What a {@link FileSaver} was able to establish about the bytes it was handed. */
export type SaveOutcome =
  /** Written and closed to a destination the user chose — the file exists. */
  | 'saved'
  /** Handed to the browser's download machinery, which never reports back either way. */
  | 'unverified';

/** The kind of file being saved, so the picker can label and filter it sensibly. */
export interface SaveFileKind {
  /** Human label for the file type, e.g. `Gubbins backup`. */
  readonly description: string;
  readonly mimeType: string;
  /** Accepted extensions, leading dot included, e.g. `['.zip']`. */
  readonly extensions: readonly string[];
}

/** A destination that has already been chosen, waiting for the bytes it will hold. */
export interface FileSaver {
  readonly filename: string;
  /**
   * Write `blob`, reporting what could be established. Throws if a chosen write failed.
   *
   * Whether this destination *can* report is deliberately not exposed separately: the outcome
   * says so after the fact, and a caller that branched on it beforehand would be guessing at
   * something it is about to be told.
   */
  save(blob: Blob): Promise<SaveOutcome>;
}

// Minimal typings — the File System Access API is not fully in lib.dom (mirrors the same
// local shapes in `features/sync/providers/file-system-provider.ts`).
interface FsWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
interface FsSaveHandle {
  createWritable(): Promise<FsWritable>;
}
type SaveFilePicker = (options: {
  suggestedName: string;
  types: readonly { description: string; accept: Record<string, readonly string[]> }[];
}) => Promise<FsSaveHandle>;

/**
 * Choose where a file will be saved, **before** the work that produces it.
 *
 * Must be called from a user gesture: the File System Access picker needs transient activation,
 * and it is the only route that can confirm a save. Returns `null` when the user closed the
 * picker — a decision, not a failure, so the caller must abandon the whole operation rather than
 * fall back to an unverifiable download the user did not ask for.
 */
export async function prepareSave(filename: string, kind: SaveFileKind): Promise<FileSaver | null> {
  const picker = saveFilePicker();
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: kind.description, accept: { [kind.mimeType]: kind.extensions } }],
      });
      return writableSaver(handle, filename);
    } catch (error) {
      if (isAbort(error)) return null;
      // Anything else is not the user's answer — no transient activation left, a permissions
      // policy block, a host that exposes the name but not the behaviour. Fall through to the
      // anchor rather than stranding them with no route at all; it reports `'unverified'`, so
      // nothing downstream mistakes it for a confirmed save.
    }
  }
  return anchorSaver(filename);
}

/**
 * The pairing a destructive caller needs: somewhere to put the copy, and — for the browsers that
 * cannot confirm one — a way to ask the user whether it actually arrived.
 */
export interface SafeSave {
  /** Reserved by {@link prepareSave} inside the user gesture that began the operation. */
  readonly saver: FileSaver;
  /**
   * Asked **only** when the save could not be verified: does the user have the file? Answering
   * no must leave the original untouched.
   */
  readonly confirmUnverified: (filename: string) => Promise<boolean>;
}

/**
 * Save `blob` and answer the only question a destructive caller should be asking: is this copy
 * safe enough to destroy the original?
 *
 * The single place that decision is made, so no call site can accidentally skip the confirmation
 * and go back to treating an unobserved side effect as a completed backup.
 */
export async function saveBeforeDestroying(blob: Blob, save: SafeSave): Promise<boolean> {
  const outcome = await save.saver.save(blob);
  switch (outcome) {
    case 'saved':
      return true;
    case 'unverified':
      return await save.confirmUnverified(save.saver.filename);
    default:
      assertExhaustive(outcome);
      // An outcome from a future build of this module is not a confirmed save.
      return false;
  }
}

/** The `showSaveFilePicker` implementation, or null where the API is not usable. */
function saveFilePicker(): SaveFilePicker | null {
  if (!hasFileSystemAccess() || typeof globalThis === 'undefined') return null;
  const picker = (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof picker === 'function' ? picker : null;
}

/**
 * True for the picker's "the user closed me" rejection. Matched on `name` rather than
 * `instanceof DOMException` because test doubles and non-DOM hosts throw the same shape.
 */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** A saver over a handle the user picked: the bytes commit on `close()`, or the write throws. */
function writableSaver(handle: FsSaveHandle, filename: string): FileSaver {
  return {
    filename,
    async save(blob: Blob): Promise<SaveOutcome> {
      const writable = await handle.createWritable();
      try {
        await writable.write(blob);
      } catch (error) {
        // Leave no half-written file standing in for the copy. `createWritable` stages into a
        // swap file, so aborting discards it and the destination keeps whatever it held before.
        try {
          await writable.abort?.();
        } catch {
          // Nothing useful to do about a failed cleanup; the write error below is the news.
        }
        throw error;
      }
      await writable.close();
      return 'saved';
    },
  };
}

/** The legacy route: hand the blob to the browser and hope. Reports exactly that. */
function anchorSaver(filename: string): FileSaver {
  return {
    filename,
    async save(blob: Blob): Promise<SaveOutcome> {
      downloadBlob(filename, blob);
      return 'unverified';
    },
  };
}
