/**
 * Tests for the shared snapshot IO: the single-flight {@link createSnapshotMutex} that serialises
 * the bridge's two mutating surfaces (writes and push), the atomic-and-conditional
 * {@link writeSnapshotAtomicIf} / {@link renameSnapshotIf} publish, and {@link tempSiblingPath}'s
 * same-millisecond uniqueness.
 *
 * The precondition tests run against a REAL temp directory rather than a fake, because what they
 * assert is a property of the filesystem — that a `stat` taken at read time still describes the
 * file at publish time — and a fake would only restate its own bookkeeping (issue #549).
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSnapshotMutex,
  readSnapshotWithStamp,
  renameSnapshotIf,
  SnapshotConflictError,
  stampsMatch,
  statSnapshot,
  tempSiblingPath,
  writeSnapshotAtomicIf,
} from './snapshot-io.ts';

describe('createSnapshotMutex', () => {
  it('runs tasks strictly one-at-a-time, in submission order', async () => {
    const mutex = createSnapshotMutex();
    const events: string[] = [];
    // Each task records enter/exit around a microtask yield; with a mutex no two overlap.
    const task = (id: string) =>
      mutex.runExclusive(async () => {
        events.push(`enter-${id}`);
        await Promise.resolve();
        await Promise.resolve();
        events.push(`exit-${id}`);
      });

    await Promise.all([task('a'), task('b'), task('c')]);

    expect(events).toEqual(['enter-a', 'exit-a', 'enter-b', 'exit-b', 'enter-c', 'exit-c']);
  });

  it('keeps serialising after a task rejects (the chain is not broken)', async () => {
    const mutex = createSnapshotMutex();
    const order: string[] = [];

    const failing = mutex.runExclusive(async () => {
      order.push('failing');
      throw new Error('boom');
    });
    const following = mutex.runExclusive(async () => {
      order.push('following');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
    expect(order).toEqual(['failing', 'following']);
  });
});

describe('writeSnapshotAtomicIf + tempSiblingPath', () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gubbins-snapshot-io-'));
    target = path.join(dir, 'gubbins-sync.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the content and leaves no temp file behind', async () => {
    await writeSnapshotAtomicIf(target, 'hello', null);
    expect(await readFile(target, 'utf8')).toBe('hello');
    expect(await readdir(dir)).toEqual(['gubbins-sync.json']);
  });

  it('replaces an existing file atomically', async () => {
    await writeSnapshotAtomicIf(target, 'first', null);
    await writeSnapshotAtomicIf(target, 'second', await statSnapshot(target));
    expect(await readFile(target, 'utf8')).toBe('second');
    expect(await readdir(dir)).toEqual(['gubbins-sync.json']);
  });

  it('refuses to publish when the file changed since it was read, and cleans up its temp', async () => {
    await writeFile(target, 'original', 'utf8');
    const { stamp } = await readSnapshotWithStamp(target);

    // Another process publishes in the gap between our read and our write.
    await writeSnapshotAtomicIf(target, 'theirs', await statSnapshot(target));

    await expect(writeSnapshotAtomicIf(target, 'ours', stamp)).rejects.toBeInstanceOf(SnapshotConflictError);
    expect(await readFile(target, 'utf8')).toBe('theirs'); // not overwritten
    expect(await readdir(dir)).toEqual(['gubbins-sync.json']); // no stray temp
  });

  it('refuses to place a file verbatim when one appeared, and keeps the temp for the retry', async () => {
    const tmp = tempSiblingPath(target, 'push');
    await writeFile(tmp, 'ours', 'utf8');
    // We saw an empty folder (`null`), but a snapshot landed before we could rename.
    await writeFile(target, 'theirs', 'utf8');

    await expect(renameSnapshotIf(tmp, target, null)).rejects.toBeInstanceOf(SnapshotConflictError);
    expect(await readFile(target, 'utf8')).toBe('theirs');
    expect(await readFile(tmp, 'utf8')).toBe('ours'); // survives, so a retry needs no re-upload
    await rm(tmp, { force: true });
  });

  it('gives a distinct temp path on each call (same-millisecond safe)', () => {
    const a = tempSiblingPath(target, 'push');
    const b = tempSiblingPath(target, 'push');
    expect(a).not.toBe(b);
    // A leading dot + the target basename keep the watcher, which filters on the basename, clear.
    expect(path.basename(a).startsWith('.gubbins-sync.json.push-')).toBe(true);
  });
});

describe('snapshot stamps', () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gubbins-snapshot-stamp-'));
    target = path.join(dir, 'gubbins-sync.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads text and a matching stamp in one shot', async () => {
    await writeFile(target, 'hello', 'utf8');
    const { text, stamp } = await readSnapshotWithStamp(target);
    expect(text).toBe('hello');
    expect(stampsMatch(stamp, await statSnapshot(target))).toBe(true);
  });

  it('reports an absent snapshot as null, and treats two absences as unchanged', async () => {
    expect(await statSnapshot(target)).toBeNull();
    expect(stampsMatch(null, null)).toBe(true);
    expect(stampsMatch(null, { mtimeMs: 1, size: 1, ino: 1 })).toBe(false);
  });

  it('sees a size change even when the timestamp does not move', () => {
    const base = { mtimeMs: 1_000, size: 10, ino: 7 };
    expect(stampsMatch(base, { ...base, size: 11 })).toBe(false);
    // ...and an inode change, which every publish causes (a rename of a fresh temp file).
    expect(stampsMatch(base, { ...base, ino: 8 })).toBe(false);
  });
});
