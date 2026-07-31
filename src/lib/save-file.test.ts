/**
 * The save seam that gives a destructive caller a real answer (issue #502).
 *
 * The behaviour under test is entirely about *what is claimed*: an `<a download>` cannot report,
 * so anything built on it must say `'unverified'` and ask, while a File System Access write that
 * closed cleanly may say `'saved'` and must not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const downloadBlob = vi.hoisted(() => vi.fn());
vi.mock('./download', () => ({ downloadBlob, fileTimestamp: () => '20260731-090000' }));

import { prepareSave, saveBeforeDestroying, type SafeSave } from './save-file';

const KIND = { description: 'Gubbins backup', mimeType: 'application/zip', extensions: ['.zip'] };

/** A `showSaveFilePicker` double, recording every write the caller commits. */
function stubPicker(behaviour: {
  reject?: unknown;
  failWrite?: unknown;
  written?: Blob[];
  events?: string[];
}) {
  const picker = vi.fn(async () => {
    if (behaviour.reject) throw behaviour.reject;
    return {
      createWritable: async () => ({
        write: async (data: Blob) => {
          if (behaviour.failWrite) throw behaviour.failWrite;
          behaviour.written?.push(data);
          behaviour.events?.push('write');
        },
        close: async () => void behaviour.events?.push('close'),
        abort: async () => void behaviour.events?.push('abort'),
      }),
    };
  });
  vi.stubGlobal('showSaveFilePicker', picker);
  return picker;
}

/** The DOMException shape the picker throws when the user closes it. */
function abortError(): Error {
  const error = new Error('The user aborted a request.');
  error.name = 'AbortError';
  return error;
}

beforeEach(() => {
  downloadBlob.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prepareSave — where the platform can report', () => {
  it('writes through the chosen handle and calls it saved', async () => {
    const written: Blob[] = [];
    const events: string[] = [];
    stubPicker({ written, events });

    const saver = await prepareSave('gubbins-backup.zip', KIND);

    expect(saver?.verifiable).toBe(true);
    expect(await saver!.save(new Blob(['data']))).toBe('saved');
    expect(written).toHaveLength(1);
    // Closing is what commits the staged bytes, so "saved" must not be claimed before it.
    expect(events).toEqual(['write', 'close']);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('offers the filename and file kind to the picker', async () => {
    const picker = stubPicker({});

    await prepareSave('gubbins-backup.zip', KIND);

    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'gubbins-backup.zip',
      types: [{ description: 'Gubbins backup', accept: { 'application/zip': ['.zip'] } }],
    });
  });

  it('reports nothing chosen when the user closes the picker', async () => {
    // A closed picker is an answer, not a failure: falling back to a download the user did not
    // ask for would hand the destructive half an unverifiable copy by the back door.
    stubPicker({ reject: abortError() });

    expect(await prepareSave('gubbins-backup.zip', KIND)).toBeNull();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('raises a failed write rather than reporting a save, and discards the part-written file', async () => {
    const events: string[] = [];
    stubPicker({ failWrite: new Error('Disk full.'), events });

    const saver = await prepareSave('gubbins-backup.zip', KIND);

    await expect(saver!.save(new Blob(['data']))).rejects.toThrow(/disk full/i);
    // Aborted, not closed — a truncated file at the chosen path would pose as the copy.
    expect(events).toEqual(['abort']);
  });

  it('falls back to the download when the picker fails for any other reason', async () => {
    // e.g. the transient activation ran out, or a permissions policy blocks the API. Not the
    // user's answer, so they keep a route — it simply cannot claim to have verified anything.
    stubPicker({ reject: new Error('Must be handling a user gesture.') });

    const saver = await prepareSave('gubbins-backup.zip', KIND);

    expect(saver?.verifiable).toBe(false);
    expect(await saver!.save(new Blob(['data']))).toBe('unverified');
  });
});

describe('prepareSave — where it cannot', () => {
  it('falls back to the anchor download and admits it proved nothing', async () => {
    const saver = await prepareSave('gubbins-backup.zip', KIND);

    expect(saver?.verifiable).toBe(false);
    expect(await saver!.save(new Blob(['data']))).toBe('unverified');
    expect(downloadBlob).toHaveBeenCalledWith('gubbins-backup.zip', expect.any(Blob));
  });
});

describe('saveBeforeDestroying', () => {
  /** A saver reporting `outcome`, plus an acknowledgement that records whether it was reached. */
  function save(outcome: 'saved' | 'unverified', confirm: boolean): SafeSave & { asked: () => boolean } {
    let asked = false;
    return {
      saver: { filename: 'copy.zip', verifiable: outcome === 'saved', save: async () => outcome },
      confirmUnverified: async () => {
        asked = true;
        return confirm;
      },
      asked: () => asked,
    };
  }

  it('does not trouble the user when the save reported itself', async () => {
    const target = save('saved', false);
    expect(await saveBeforeDestroying(new Blob(['x']), target)).toBe(true);
    expect(target.asked()).toBe(false);
  });

  it('asks when it could not, and takes yes for an answer', async () => {
    const target = save('unverified', true);
    expect(await saveBeforeDestroying(new Blob(['x']), target)).toBe(true);
    expect(target.asked()).toBe(true);
  });

  it('refuses when the user says the file never arrived', async () => {
    expect(await saveBeforeDestroying(new Blob(['x']), save('unverified', false))).toBe(false);
  });

  it('passes the filename to the question, so it names the file to look for', async () => {
    const seen: string[] = [];
    await saveBeforeDestroying(new Blob(['x']), {
      saver: { filename: 'gubbins-restore-point.sqlite', verifiable: false, save: async () => 'unverified' },
      confirmUnverified: async (filename) => {
        seen.push(filename);
        return true;
      },
    });
    expect(seen).toEqual(['gubbins-restore-point.sqlite']);
  });
});
