jest.mock('../../../config/redis', () => ({ __esModule: true, default: { status: 'end', disconnect: jest.fn() } }));

import { withLock } from '../locks';
import { LockBusyError } from '../errors';
import { closeIntResources } from '../../../test/int/db';

afterAll(() => closeIntResources());

describe('withLock against MySQL (Review Focus 5)', () => {
  it('excludes a concurrent holder and frees on completion', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const first = withLock('billing:int:probe', 10_000, () => held);
    await new Promise((r) => setTimeout(r, 100));
    await expect(withLock('billing:int:probe', 10_000, async () => 'second')).rejects.toBeInstanceOf(LockBusyError);
    release();
    await first;
    await expect(withLock('billing:int:probe', 10_000, async () => 'third')).resolves.toBe('third');
  });
});
