// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findSecrets, mask } = require('../../../../scripts/scan-secrets');

// Built at runtime so this file never contains a literal the scanner would flag.
const k = (...parts: string[]) => parts.join('_');

describe('scan-secrets', () => {
  it('flags secret, restricted and webhook keys with their line numbers', () => {
    const text = [
      'const a = 1;',
      `key = "${k('sk', 'live', 'A1b2C3d4E5f6G7')}"`,
      `rk = ${k('rk', 'test', 'Zz9Yy8Xx7Ww6')}`,
      `wh: ${k('whsec', 'Qq1Ww2Ee3Rr4Tt5')}`,
    ].join('\n');
    const found = findSecrets(text);
    expect(found.map((f: { line: number }) => f.line)).toEqual([2, 3, 4]);
  });

  it('ignores short or placeholder values', () => {
    expect(findSecrets(`${k('sk', 'test')}_… and ${k('whsec')}_… and ${k('sk', 'test', 'short')}`)).toEqual([]);
  });

  it('masks all but the prefix', () => {
    expect(mask(k('sk', 'test', 'ABCDEFGHIJKL'))).toBe('sk_test_AB…');
  });
});
