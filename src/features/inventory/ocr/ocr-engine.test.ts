import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_OCR_MODEL,
  describeOcrError,
  describeOcrStatus,
  normaliseOcrModel,
  ocrAssetPaths,
  runReceiptOcr,
  type OcrRecognizer,
  type OcrRecognizerFactory,
} from './ocr-engine';

describe('describeOcrStatus', () => {
  it('maps engine phase strings to friendly copy', () => {
    expect(describeOcrStatus('recognizing text')).toBe('Reading the image…');
    expect(describeOcrStatus('loading language traits')).toBe('Loading the recognition engine…');
    expect(describeOcrStatus('initializing api')).toBe('Loading the recognition engine…');
    expect(describeOcrStatus('something else')).toBe('Working…');
  });
});

describe('describeOcrError', () => {
  it('distinguishes an asset/network load failure from an unreadable image', () => {
    expect(describeOcrError(new Error('Failed to fetch worker.min.js'))).toMatch(/recognition engine/i);
    expect(describeOcrError(new Error('boom'))).toMatch(/clearer.*photo/i);
    expect(describeOcrError('weird')).toMatch(/clearer.*photo/i);
  });
});

describe('normaliseOcrModel', () => {
  it('accepts the two known tiers and defaults everything else to fast', () => {
    expect(normaliseOcrModel('fast')).toBe('fast');
    expect(normaliseOcrModel('best')).toBe('best');
    expect(DEFAULT_OCR_MODEL).toBe('fast');
    expect(normaliseOcrModel('nonsense')).toBe('fast');
    expect(normaliseOcrModel(undefined)).toBe('fast');
    expect(normaliseOcrModel(42)).toBe('fast');
  });
});

describe('ocrAssetPaths', () => {
  it('builds origin-relative asset URLs under the app base path', () => {
    expect(ocrAssetPaths('/Gubbins/', 'fast')).toEqual({
      workerPath: '/Gubbins/ocr/worker.min.js',
      corePath: '/Gubbins/ocr/',
      langPath: '/Gubbins/ocr/tessdata-fast',
    });
  });

  it('tolerates a base path without a trailing slash and threads the model tier', () => {
    expect(ocrAssetPaths('/Gubbins', 'best').langPath).toBe('/Gubbins/ocr/tessdata-best');
    expect(ocrAssetPaths('/', 'fast').workerPath).toBe('/ocr/worker.min.js');
  });
});

describe('runReceiptOcr', () => {
  it('recognises through the injected factory and always terminates the worker', async () => {
    const terminate = vi.fn(async () => {});
    const recognizer: OcrRecognizer = {
      recognize: vi.fn(async () => 'Total £3.00'),
      terminate,
    };
    const factory: OcrRecognizerFactory = vi.fn(async () => recognizer);

    const text = await runReceiptOcr(new Blob(['x']), { model: 'fast', createRecognizer: factory });

    expect(text).toBe('Total £3.00');
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ model: 'fast' }));
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('still terminates the worker when recognition throws', async () => {
    const terminate = vi.fn(async () => {});
    const factory: OcrRecognizerFactory = async () => ({
      recognize: async () => {
        throw new Error('decode failed');
      },
      terminate,
    });

    await expect(
      runReceiptOcr(new Blob(['x']), { model: 'best', createRecognizer: factory }),
    ).rejects.toThrow('decode failed');
    expect(terminate).toHaveBeenCalledOnce();
  });
});
