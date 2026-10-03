import { snapshotSub, diffSnapshots } from '../reconcile';

const row = (o: Record<string, unknown> = {}) => ({
  status: 'active', seats: 5, interval: 'month', priceId: 'p1', unitAmount: 899, currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
  cancelAtPeriodEnd: false, pendingUpdate: null, graceUntil: null, ...o,
}) as any;

describe('reconciliation classification', () => {
  it('snapshots comparable fields with ISO dates', () => {
    expect(snapshotSub(row())).toMatchObject({ currentPeriodEnd: '2026-11-01T00:00:00.000Z', pendingUpdate: null });
  });

  it('reports exactly the drifted fields', () => {
    expect(diffSnapshots(snapshotSub(row()), snapshotSub(row({ seats: 7, cancelAtPeriodEnd: true })))).toEqual(['seats', 'cancelAtPeriodEnd']);
    expect(diffSnapshots(snapshotSub(row({ pendingUpdate: { a: 1 } })), snapshotSub(row({ pendingUpdate: { a: 1 } })))).toEqual([]);
  });
});
