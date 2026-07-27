import { afterEach, describe, expect, it } from 'vitest';
import { DB_PRESENCE_KEY } from '@/lib/storage-keys';
import {
  acknowledgeDbLoss,
  clearDbPresence,
  evaluateDbPresence,
  parseMarker,
  readDbPresence,
  recordKnownItemCount,
  writeDbPresence,
  type DbPresenceMarker,
} from './db-presence';

/**
 * The one thing this marker exists to do is tell a *first run* from a *wipe* (issue #505): both
 * arrive at boot as "there was no database, so one was created", and everything the user is then
 * told — or not told — hangs on which of the two it was.
 */

const NOW = 1_760_000_000_000;

const marker = (over: Partial<DbPresenceMarker> = {}): DbPresenceMarker => ({
  version: 1,
  lastSeenAt: NOW - 86_400_000,
  lastKnownItems: 248,
  unacknowledgedLoss: null,
  ...over,
});

afterEach(() => {
  localStorage.clear();
});

describe('evaluateDbPresence', () => {
  it('calls a created database on an unmarked device a first run', () => {
    expect(evaluateDbPresence(null, true, NOW).verdict).toEqual({ kind: 'first-run' });
  });

  it('calls a created database on a marked device a loss, carrying what was here', () => {
    const { verdict } = evaluateDbPresence(marker(), true, NOW);

    expect(verdict).toEqual({
      kind: 'lost',
      loss: { detectedAt: NOW, lastSeenAt: NOW - 86_400_000, lastKnownItems: 248 },
    });
  });

  it('calls an existing database an ordinary return, marker or not', () => {
    expect(evaluateDbPresence(marker(), false, NOW).verdict).toEqual({ kind: 'returning' });
    // No marker but a database already on disk is the first boot of a build that has this
    // marker at all — an upgrade, not a loss.
    expect(evaluateDbPresence(null, false, NOW).verdict).toEqual({ kind: 'returning' });
  });

  it('re-raises a loss the user has not acknowledged, on every later boot', () => {
    const loss = { detectedAt: NOW - 1000, lastSeenAt: NOW - 86_400_000, lastKnownItems: 248 };

    // The boot *after* the loss opens the (empty) database it created, so `freshlyCreated` is
    // false — and without this the news would be buried by the very boot that recorded it.
    const { verdict } = evaluateDbPresence(marker({ unacknowledgedLoss: loss }), false, NOW);

    expect(verdict).toEqual({ kind: 'lost', loss });
  });

  it('keeps the older record when a second wipe lands before the first was acknowledged', () => {
    // The newer one would describe only the empty database the first loss left behind.
    const loss = { detectedAt: NOW - 5000, lastSeenAt: NOW - 86_400_000, lastKnownItems: 248 };
    const since = marker({ lastSeenAt: NOW - 100, lastKnownItems: 0, unacknowledgedLoss: loss });

    expect(evaluateDbPresence(since, true, NOW).verdict).toEqual({ kind: 'lost', loss });
  });
});

describe('evaluateDbPresence — the marker it writes back', () => {
  it('stamps this boot and carries the count forward on an ordinary return', () => {
    expect(evaluateDbPresence(marker(), false, NOW).marker).toEqual({
      version: 1,
      lastSeenAt: NOW,
      lastKnownItems: 248,
      unacknowledgedLoss: null,
    });
  });

  it('drops a count that described the database that is gone', () => {
    // Keeping 248 against a database that now holds nothing would misreport a *second* wipe.
    expect(evaluateDbPresence(marker(), true, NOW).marker.lastKnownItems).toBeNull();
  });

  it('holds the loss in the marker so it survives a tab closed on the notice', () => {
    const { marker: next } = evaluateDbPresence(marker(), true, NOW);
    expect(next.unacknowledgedLoss).toEqual({
      detectedAt: NOW,
      lastSeenAt: NOW - 86_400_000,
      lastKnownItems: 248,
    });
  });

  it('marks a first run too — the next disappearance must be detectable', () => {
    expect(evaluateDbPresence(null, true, NOW).marker).toEqual({
      version: 1,
      lastSeenAt: NOW,
      lastKnownItems: null,
      unacknowledgedLoss: null,
    });
  });
});

describe('readDbPresence', () => {
  it('round-trips a written marker', () => {
    const written = marker({ unacknowledgedLoss: { detectedAt: NOW, lastSeenAt: 1, lastKnownItems: 2 } });
    writeDbPresence(written);
    expect(readDbPresence()).toEqual(written);
  });

  it('reports no marker on a device that has never booted', () => {
    expect(readDbPresence()).toBeNull();
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['a value that is not an object', '"nope"'],
    ['a version this build does not know', '{"version":99,"lastSeenAt":1}'],
  ])('treats %s as "a database was here", not as no marker at all', (_label, raw) => {
    // The key existing at all is the proof. Discarding it would turn a detectable loss into a
    // silent one — the exact failure this marker exists to prevent.
    localStorage.setItem(DB_PRESENCE_KEY, raw);

    expect(readDbPresence()).toEqual({
      version: 1,
      lastSeenAt: null,
      lastKnownItems: null,
      unacknowledgedLoss: null,
    });
    expect(evaluateDbPresence(readDbPresence(), true, NOW).verdict).toMatchObject({ kind: 'lost' });
  });

  it('drops individual fields that are not finite numbers, keeping the marker', () => {
    localStorage.setItem(
      DB_PRESENCE_KEY,
      JSON.stringify({ version: 1, lastSeenAt: 'yesterday', lastKnownItems: null }),
    );

    expect(readDbPresence()).toEqual({
      version: 1,
      lastSeenAt: null,
      lastKnownItems: null,
      unacknowledgedLoss: null,
    });
  });

  it('discards a loss record with no detection time', () => {
    expect(parseMarker('{"version":1,"lastSeenAt":1,"unacknowledgedLoss":{"lastSeenAt":2}}')).toEqual({
      version: 1,
      lastSeenAt: 1,
      lastKnownItems: null,
      unacknowledgedLoss: null,
    });
  });
});

describe('acknowledgeDbLoss / recordKnownItemCount / clearDbPresence', () => {
  it('stops a loss being re-raised once the user has been told', () => {
    writeDbPresence(marker({ unacknowledgedLoss: { detectedAt: NOW, lastSeenAt: 1, lastKnownItems: 2 } }));

    acknowledgeDbLoss();

    expect(readDbPresence()?.unacknowledgedLoss).toBeNull();
    expect(evaluateDbPresence(readDbPresence(), false, NOW).verdict).toEqual({ kind: 'returning' });
  });

  it('records the count against the marker this boot already wrote', () => {
    writeDbPresence(evaluateDbPresence(null, true, NOW).marker);

    recordKnownItemCount(17);

    expect(readDbPresence()?.lastKnownItems).toBe(17);
  });

  it('does not create a marker out of a count alone', () => {
    // Nothing has recorded a successful boot, so nothing should claim one.
    recordKnownItemCount(17);
    expect(readDbPresence()).toBeNull();
  });

  it('forgets the device ever had a database, so a deliberate purge is not reported as a loss', () => {
    writeDbPresence(marker());

    clearDbPresence();

    expect(readDbPresence()).toBeNull();
    expect(evaluateDbPresence(readDbPresence(), true, NOW).verdict).toEqual({ kind: 'first-run' });
  });
});
