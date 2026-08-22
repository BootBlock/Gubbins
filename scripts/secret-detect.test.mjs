import { describe, it, expect } from 'vitest';
import { findSuspectValues, isSuspect, scanAddedLines } from './secret-detect.mjs';

// Every credential-shaped fixture below is ASSEMBLED at runtime rather than written out as a
// literal. The scanner reads the added lines of this very file when it is committed, and a
// literal `sk-…` here would (correctly) fail the commit that adds the test proving it fails.
const SK_KEY = `sk-${'a1b2c3d4'.repeat(3)}`;
const GH_TOKEN = `gh${'p'}_${'A1b2C3d4'.repeat(5)}`;
const AWS_KEY = `AK${'IA'}${'0123456789ABCDEF'}`;
const GOOGLE_KEY = `AI${'za'}${'0123456789abcdefghijklmnopqrstuvwxy'}`;
const SLACK_TOKEN = `xo${'xb'}-${'0123456789'}-${'abcdefghij'}`;
const PRIVATE_KEY_HEADER = `${'-----'}BEGIN RSA PRIVATE KEY${'-----'}`;
const REAL_VALUE = 'hunter2secret';

/**
 * Lines the scanner MUST flag. The JSX and HTML cases are the regression this suite exists for:
 * the exclusion used to be applied to the whole line, and `<…>` was one of its alternatives, so
 * any element on the line exempted the credential beside it.
 */
const MUST_FLAG = [
  ['a JSX element carrying a real key', `const el = <ApiClient apiKey="${SK_KEY}" />;`],
  ['a hidden HTML input holding a token', `<input type="hidden" name="token" value="${GH_TOKEN}" />`],
  ['a real password beside an angle-bracketed comment', `{ password: "${REAL_VALUE}" } // <see docs>`],
  ['a bare credential assignment', `password: "${REAL_VALUE}"`],
  ['a real key beside an example.com URL', `fetch("https://example.com", { token: "${REAL_VALUE}" });`],
  [
    'a real key beside a noreply address',
    `// author: nobody@users.noreply.github.com\tapi_key: "${REAL_VALUE}"`,
  ],
  ['an AWS access key id', `const id = "${AWS_KEY}";`],
  ['a Google API key', `<meta name="k" content="${GOOGLE_KEY}" />`],
  ['a Slack token', `slack: ${SLACK_TOKEN}`],
  ['a private-key block header', PRIVATE_KEY_HEADER],
  [
    'a real credential after a placeholder one on the same line',
    `apiKey: "<YOUR_API_KEY>", secret: "${REAL_VALUE}"`,
  ],
];

/** Lines the scanner MUST NOT flag — the example snippets the placeholder rules exist to allow. */
const MUST_NOT_FLAG = [
  ['an angle-bracket placeholder value', 'const key = "<YOUR_API_KEY>";'],
  ['the documented xxxx placeholder', `const key = "sk-${'x'.repeat(24)}";`],
  ['an environment reference', 'api_key: "$GUBBINS_API_KEY"'],
  ['a braced environment reference', 'api_key: "${GUBBINS_API_KEY}"'],
  ['a template substitution', 'token: "{{secrets.TOKEN}}"'],
  ['a Windows-style variable', 'password: "%GUBBINS_PASSWORD%"'],
  ['an obvious example value', 'password: "example-password"'],
  ['plain JSX with no credential', '<Button variant="primary" onClick={handleSave}>Save</Button>'],
  ['an XML feed line', '<link>https://example.test/items/42</link>'],
  ['a short quoted value', 'password: "short"'],
];

describe('findSuspectValues', () => {
  it.each(MUST_FLAG)('flags %s', (_name, line) => {
    expect(isSuspect(line)).toBe(true);
  });

  it.each(MUST_NOT_FLAG)('allows %s', (_name, line) => {
    expect(isSuspect(line)).toBe(false);
  });

  it('reports the matched value, not the whole line', () => {
    const found = findSuspectValues(`const el = <ApiClient apiKey="${SK_KEY}" />;`);
    expect(found.map((f) => f.value)).toContain(SK_KEY);
  });

  it('still flags the real credential when a placeholder precedes it', () => {
    const found = findSuspectValues(`apiKey: "<YOUR_API_KEY>", secret: "${REAL_VALUE}"`);
    expect(found).toHaveLength(1);
    expect(found[0].value).toBe(REAL_VALUE);
  });
});

describe('scanAddedLines', () => {
  const diff = [
    '--- a/src/Thing.tsx',
    '+++ b/src/Thing.tsx',
    '@@ -1,0 +1,3 @@',
    `+const el = <ApiClient apiKey="${SK_KEY}" />;`,
    '+const ok = <ApiClient apiKey="<YOUR_API_KEY>" />;',
    `-const gone = "${REAL_VALUE}";`,
    '',
  ].join('\n');

  it('reports only the suspect added line', () => {
    expect(scanAddedLines(diff)).toEqual([`const el = <ApiClient apiKey="${SK_KEY}" />;`]);
  });

  it('never judges a removed line', () => {
    expect(scanAddedLines(`-password: "${REAL_VALUE}"`)).toEqual([]);
  });

  it('never judges the +++ file header', () => {
    expect(scanAddedLines(`+++ b/${REAL_VALUE}-token.ts`)).toEqual([]);
  });
});
