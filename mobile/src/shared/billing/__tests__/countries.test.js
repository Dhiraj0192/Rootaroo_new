import { toAlpha2 } from '../countries';

describe('toAlpha2', () => {
  it('maps StoreKit alpha-3 storefronts to the alpha-2 the server routes on', () => {
    expect(toAlpha2('USA')).toBe('US');
    expect(toAlpha2('gbr')).toBe('GB');
    expect(toAlpha2('NPL')).toBe('NP');
    expect(toAlpha2('IND')).toBe('IN');
    expect(toAlpha2('DEU')).toBe('DE');
  });

  it('keeps alpha-2 (Google Play) and upper-cases it', () => {
    expect(toAlpha2('us')).toBe('US');
    expect(toAlpha2(' CA ')).toBe('CA');
  });

  it('falls back to ZZ for anything unknown', () => {
    for (const bad of [undefined, null, '', 'XYZ', '123', 42, 'U']) expect(toAlpha2(bad)).toBe('ZZ');
  });
});
