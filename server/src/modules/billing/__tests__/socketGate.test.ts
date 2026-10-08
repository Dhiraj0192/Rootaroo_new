jest.mock('../entitlement', () => ({ getEntitlement: jest.fn() }));
const emit = jest.fn();
jest.mock('../../../shared/utils/socket', () => ({ getIO: () => ({ to: jest.fn(() => ({ emit })) }) }));

import { getEntitlement } from '../entitlement';
import { isSocketEntitled, emitToHousehold } from '../socketGate';

const sock = (data: any = {}) => ({ data: { userId: 'u', householdId: 'h1', ...data } }) as any;

beforeEach(() => jest.clearAllMocks());

describe('isSocketEntitled', () => {
  it('caches the answer for 60 seconds per household', async () => {
    (getEntitlement as jest.Mock).mockResolvedValue({ allowed: true });
    const s = sock();
    expect(await isSocketEntitled(s, 1_000)).toBe(true);
    (getEntitlement as jest.Mock).mockResolvedValue({ allowed: false });
    expect(await isSocketEntitled(s, 50_000)).toBe(true);
    expect(await isSocketEntitled(s, 62_000)).toBe(false);
    expect(getEntitlement).toHaveBeenCalledTimes(2);
  });

  it('re-checks when the socket switches household', async () => {
    (getEntitlement as jest.Mock).mockResolvedValue({ allowed: true });
    const s = sock();
    await isSocketEntitled(s, 1_000);
    s.data.householdId = 'h2';
    await isSocketEntitled(s, 2_000);
    expect(getEntitlement).toHaveBeenLastCalledWith('h2');
  });

  it('is false without a household and keeps the last answer on lookup errors', async () => {
    expect(await isSocketEntitled(sock({ householdId: null }))).toBe(false);
    const s = sock({ billingAllowed: true, billingCheckedAt: 0, billingHouseholdId: 'h1' });
    (getEntitlement as jest.Mock).mockRejectedValue(new Error('db down'));
    expect(await isSocketEntitled(s, 120_000)).toBe(true);
  });
});

describe('emitToHousehold', () => {
  it('skips blocked households and emits for allowed ones', async () => {
    (getEntitlement as jest.Mock).mockResolvedValueOnce({ allowed: false });
    await emitToHousehold('h1', 'task:completed', { id: 1 });
    expect(emit).not.toHaveBeenCalled();
    (getEntitlement as jest.Mock).mockResolvedValueOnce({ allowed: true });
    await emitToHousehold('h1', 'task:completed', { id: 1 });
    expect(emit).toHaveBeenCalledWith('task:completed', { id: 1 });
  });

  it('never throws', async () => {
    (getEntitlement as jest.Mock).mockRejectedValue(new Error('x'));
    await expect(emitToHousehold('h1', 'e', {})).resolves.toBeUndefined();
  });
});
