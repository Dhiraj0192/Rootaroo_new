import { createEntrySchema, updateEntrySchema } from '../validation';

const base = { ciphertext: 'Y2lwaGVy', sealedKey: 'c2VhbGVk', format: 1 };
const v4 = '11111111-1111-4111-8111-111111111111';
const parse = (body: unknown) => createEntrySchema.body!.safeParse(body);

describe('journal validation: entry id chosen by the phone', () => {
  it('requires an id on create', () => {
    expect(parse(base).success).toBe(false);
  });

  it('accepts a v4 uuid', () => {
    expect(parse({ ...base, id: v4 }).success).toBe(true);
  });

  it('rejects ids that are not v4 uuids', () => {
    for (const id of [
      'not-a-uuid',
      '11111111-1111-1111-8111-111111111111', // v1
      '11111111-1111-4111-1111-111111111111', // bad variant
      '',
    ]) {
      expect(parse({ ...base, id }).success).toBe(false);
    }
  });

  it('does not accept an id on update (the entry id is fixed)', () => {
    expect(updateEntrySchema.body!.safeParse({ ...base, id: v4 }).success).toBe(false);
    expect(updateEntrySchema.body!.safeParse(base).success).toBe(true);
  });
});
