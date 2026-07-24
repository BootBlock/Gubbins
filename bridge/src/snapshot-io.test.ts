/**
 * Tests for the shared snapshot IO: the single-flight {@link createSnapshotMutex} that serialises
 * the bridge's two mutating surfaces (writes and push), the atomic {@link writeSnapshotAtomic}
 * publish, and {@link tempSiblingPath}'s same-millisecond uniqueness.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSnapshotMutex, tempSiblingPath, writeSnapshotAtomic } from './snapshot-io.ts';

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

describe('writeSnapshotAtomic + tempSiblingPath', () => {
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
    await writeSnapshotAtomic(target, 'hello');
    expect(await readFile(target, 'utf8')).toBe('hello');
    expect(await readdir(dir)).toEqual(['gubbins-sync.json']);
  });

  it('replaces an existing file atomically', async () => {
    await writeSnapshotAtomic(target, 'first');
    await writeSnapshotAtomic(target, 'second');
    expect(await readFile(target, 'utf8')).toBe('second');
    expect(await readdir(dir)).toEqual(['gubbins-sync.json']);
  });

  it('gives a distinct temp path on each call (same-millisecond safe)', () => {
    const a = tempSiblingPath(target, 'push');
    const b = tempSiblingPath(target, 'push');
    expect(a).not.toBe(b);
    // A leading dot + the target basename keep the watcher, which filters on the basename, clear.
    expect(path.basename(a).startsWith('.gubbins-sync.json.push-')).toBe(true);
  });
});
