jest.mock('../handlers', () => ({ dispatchEvent: jest.fn(), envOfEventObject: jest.requireActual('../handlers').envOfEventObject }));
jest.mock('../notify', () => ({ alertStaff: jest.fn() }));
jest.mock('../review', () => ({ raiseReviewItem: jest.fn() }));
jest.mock('../../../database/models', () => ({ BillingEvent: { update: jest.fn(), findByPk: jest.fn(), findAll: jest.fn() } }));

import * as models from '../../../database/models';
import { dispatchEvent } from '../handlers';
import { alertStaff } from '../notify';
import { raiseReviewItem } from '../review';
import { processEvent, sweepEvents, enqueueEvent, __drainForTests, backoffMs, registerProviderDispatcher, MAX_ATTEMPTS } from '../worker';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { stripeEvent } from '../../../test/billing/fixtures';

const BE = models.BillingEvent as unknown as Record<'update' | 'findByPk' | 'findAll', jest.Mock>;
const mkRow = (o: Record<string, unknown> = {}) => {
  const row: any = { id: 'r1', provider: 'stripe', livemode: false, providerEventId: 'evt_1', type: 'invoice.paid', attempts: 0, status: 'received', payload: stripeEvent('invoice.paid', {}), updatedAt: new Date(), ...o };
  row.update = jest.fn(async (v: object) => Object.assign(row, v));
  return row;
};

beforeEach(() => { jest.clearAllMocks(); installStripeMock('test'); });

describe('worker (unit)', () => {
  it('backoff is exponential and capped', () => {
    expect(backoffMs(1)).toBe(120_000);
    expect(backoffMs(20)).toBe(3_600_000);
  });

  it('skips when the claim loses the race', async () => {
    BE.update.mockResolvedValue([0]);
    expect(await processEvent('r1')).toBe('skipped');
  });

  it('dispatches a stripe event and stores the outcome', async () => {
    const row = mkRow();
    BE.update.mockResolvedValue([1]); BE.findByPk.mockResolvedValue(row);
    (dispatchEvent as jest.Mock).mockResolvedValue('processed');
    expect(await processEvent('r1')).toBe('processed');
    expect(row.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'processed', lockedAt: null }));
  });

  it('records a failure with the error message', async () => {
    const row = mkRow();
    BE.update.mockResolvedValue([1]); BE.findByPk.mockResolvedValue(row);
    (dispatchEvent as jest.Mock).mockRejectedValue(new Error('boom'));
    expect(await processEvent('r1')).toBe('failed');
    expect(row.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', attempts: 1, lastError: 'boom' }));
  });

  it('routes non-stripe providers to a registered dispatcher, otherwise ignores', async () => {
    const apple = mkRow({ provider: 'apple' });
    BE.update.mockResolvedValue([1]); BE.findByPk.mockResolvedValue(apple);
    expect(await processEvent('r1')).toBe('ignored');
    registerProviderDispatcher('apple', async () => 'processed');
    const apple2 = mkRow({ provider: 'apple' });
    BE.findByPk.mockResolvedValue(apple2);
    expect(await processEvent('r1')).toBe('processed');
  });

  it('enqueue drains in the background', async () => {
    const row = mkRow();
    BE.update.mockResolvedValue([1]); BE.findByPk.mockResolvedValue(row);
    (dispatchEvent as jest.Mock).mockResolvedValue('ignored');
    enqueueEvent('r1');
    await __drainForTests();
    expect(row.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'ignored' }));
  });

  it('sweep resets stale rows, kills exhausted rows and re-queues eligible ones', async () => {
    const stale = mkRow({ id: 's1', status: 'processing' });
    const exhausted = mkRow({ id: 'x1', status: 'failed', attempts: MAX_ATTEMPTS, lastError: 'e' });
    const waiting = mkRow({ id: 'w1', status: 'failed', attempts: 1 });
    BE.findAll.mockResolvedValueOnce([stale]).mockResolvedValueOnce([exhausted]).mockResolvedValueOnce([waiting]);
    BE.update.mockResolvedValue([1]);
    const res = await sweepEvents();
    await __drainForTests();
    expect(res).toEqual({ requeued: 0, dead: 1, reset: 1 });
    // finding 10: conditional update, never an unconditional row.update
    expect(BE.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', lastError: 'stale processing lock' }),
      { where: expect.objectContaining({ id: 's1', status: 'processing', lockedAt: expect.anything() }) },
    );
    expect(stale.update).not.toHaveBeenCalled();
    expect(exhausted.update).toHaveBeenCalledWith({ status: 'dead' });
    expect(raiseReviewItem).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dead_event' }));
    expect(alertStaff).toHaveBeenCalled();
  });
});
