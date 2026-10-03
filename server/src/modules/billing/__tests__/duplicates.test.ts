import { chooseKeeper } from '../duplicates';

describe('chooseKeeper (§8.6)', () => {
  it('prefers active/trialing over past_due', () => {
    const r = chooseKeeper([{ id: 'pd', status: 'past_due', created: 1 }, { id: 'act', status: 'active', created: 5 }]);
    expect(r.keep.id).toBe('act');
    expect(r.cancel.map((c) => c.id)).toEqual(['pd']);
  });

  it('then keeps the oldest', () => {
    const r = chooseKeeper([{ id: 'new', status: 'active', created: 9 }, { id: 'old', status: 'trialing', created: 2 }, { id: 'mid', status: 'active', created: 5 }]);
    expect(r.keep.id).toBe('old');
    expect(r.cancel.map((c) => c.id)).toEqual(['mid', 'new']);
  });
});
