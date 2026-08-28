/**
 * Capture what the app asked the browser to print (issue #510).
 *
 * `lib/print-document.ts` prints into a hidden iframe rather than a popup window, so a test
 * cannot watch `window.open` any more. Its `contentWindow` getter is the one seam the frame is
 * driven through, which makes wrapping that getter the way to catch the frame between its
 * `srcdoc` and its `print()`.
 *
 * Shared by the helper's own tests and the three label dialogs' so there is one copy of what
 * "printed" means to keep in step with the helper.
 */
import { vi } from 'vitest';

/**
 * Both helpers install spies and neither undoes them: restore in an `afterEach` with
 * `vi.restoreAllMocks()`. A test that undid its own spy on the last line leaves the frame
 * stubbed for every later test in the file the moment an assertion fails before it.
 */

/** Stand in for the print dialog, recording the HTML of every document printed, in print order. */
export function capturePrintedHtml(): readonly string[] {
  const printed: string[] = [];
  const real = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')!.get!;
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(function (
    this: HTMLIFrameElement,
  ) {
    const win = real.call(this) as Window | null;
    if (win) win.print = () => void printed.push(this.srcdoc);
    return win;
  });
  return printed;
}

/**
 * Refuse every route to the printer, as a popup blocker in front of a frame that cannot be
 * driven would. What the user must then see is a message, not a button that does nothing.
 */
export function blockPrinting(): void {
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(null);
  vi.spyOn(window, 'open').mockReturnValue(null);
}
