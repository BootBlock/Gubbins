/**
 * The shared browser-download side-effect (`download`).
 *
 * These guard the two cross-browser hazards fixed in issue #257: the anchor must be attached
 * to the document when it is clicked (a detached click is ignored outside Chromium), and the
 * object URL must not be revoked synchronously after `click()` (Firefox is still resolving the
 * blob, so an immediate revoke drops the download — Bugzilla 1282407).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { download } from './download';

describe('download', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // The first test never runs its deferred cleanup, so drop any anchor it left attached.
    document.body.innerHTML = '';
  });

  it('appends the anchor to the document, and it is present at click time', () => {
    let attachedAtClick = false;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      attachedAtClick = this.isConnected;
    });

    download(new Blob(['x'], { type: 'text/plain' }), 'file.txt');

    expect(clickSpy).toHaveBeenCalledOnce();
    expect(attachedAtClick).toBe(true);
  });

  it('defers the revoke until after the click task, then removes the anchor', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    download(new Blob(['x'], { type: 'text/plain' }), 'file.txt');

    // Synchronously after click(), the URL is still live and the anchor still attached.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(document.querySelector('a[download="file.txt"]')).not.toBeNull();

    vi.runAllTimers();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(document.querySelector('a[download="file.txt"]')).toBeNull();
  });
});
