import { describe, it, expect, afterEach, vi } from 'vitest';
import { capturePrintedHtml } from '@/test/print-capture';
import { printHtmlDocument } from './print-document';

const HTML = '<!doctype html><title>Label</title><h1>Resistor 10k</h1>';

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('iframe').forEach((frame) => frame.remove());
});

describe('printHtmlDocument — printing without a popup (issue #510)', () => {
  it('prints the document from a hidden frame, never opening a window', async () => {
    const openSpy = vi.spyOn(window, 'open');
    const printed = capturePrintedHtml();

    await expect(printHtmlDocument(HTML)).resolves.toBe('printed');

    expect(openSpy).not.toHaveBeenCalled();
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('Resistor 10k');
  });

  it('falls back to a popup when the frame cannot be printed, and reports a blocked one', async () => {
    // A frame with no usable window is the only case the popup still covers.
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(null);

    const write = vi.fn();
    const popup = { document: { write, close: vi.fn() }, focus: vi.fn(), print: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

    await expect(printHtmlDocument(HTML)).resolves.toBe('printed');
    expect(write).toHaveBeenCalledWith(HTML);
    expect(popup.print).toHaveBeenCalledOnce();

    // …and a blocker refusing that popup is the one outcome the caller must be told about.
    openSpy.mockReturnValue(null);
    await expect(printHtmlDocument(HTML)).resolves.toBe('blocked');
  });

  it('takes the frame back out of the document once the print dialog closes', async () => {
    capturePrintedHtml();
    await printHtmlDocument(HTML);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);

    document
      .querySelectorAll('iframe')
      .forEach((frame) => frame.contentWindow?.dispatchEvent(new Event('afterprint')));
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
  });
});
