import { describe, expect, it } from 'vitest';
import { nfcErrorMessage } from './nfc-errors';

/** Build a DOMException-like error with a given `name`, as the Web NFC API rejects with. */
function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe('nfcErrorMessage', () => {
  it('maps NotAllowedError to permission/off copy', () => {
    expect(nfcErrorMessage(named('NotAllowedError'))).toMatch(/permission|switched off/i);
  });

  it('maps NotSupportedError to an unsupported-device sentence', () => {
    expect(nfcErrorMessage(named('NotSupportedError'))).toMatch(/can’t use NFC/i);
  });

  it('maps NotReadableError to a hardware-access sentence', () => {
    expect(nfcErrorMessage(named('NotReadableError'))).toMatch(/hardware/i);
  });

  it('maps NetworkError to a "held too briefly" sentence', () => {
    expect(nfcErrorMessage(named('NetworkError'))).toMatch(/moved away|hold it/i);
  });

  it('falls back to a generic sentence for an unknown error', () => {
    expect(nfcErrorMessage(named('WeirdError'))).toMatch(/something went wrong/i);
    expect(nfcErrorMessage('not an error at all')).toMatch(/something went wrong/i);
  });
});
