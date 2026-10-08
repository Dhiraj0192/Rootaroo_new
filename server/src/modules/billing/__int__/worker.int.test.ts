jest.mock('../notify', () => ({ notifyHouseholdAdmins: jest.fn(), alertStaff: jest.fn() }));
jest.mock('../handlers', () => {
  const actual = jest.requireActual('../handlers');
  return { ...actual, dispatchEvent: jest.fn() };
});

import { setupAssociations, BillingEvent, BillingReconciliationItem } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { stripeEvent, stripeSubscription } from '../../../test/billing/fixtures';
import { processEvent, sweepEvents, enqueueEvent, __drainForTests, backoffMs } from '../worker';
import { dispatchEvent } from '../handlers';
import { alertStaff } from '../notify';

beforeAll(() => setupAssociations());
beforeEach(async () => { await resetDb(); installStripeMock('test'); (dispatchEvent as jest.Mock).mockReset(); });
afterAll(async () => { await __drainForTests(); await closeIntResources(); });

const store = (event: unknown, extra: Record<string, unknown> = {}) => BillingEvent.create({
  provider: 'stripe', livemode: false, providerEventId: (event as any).id, type: (event as any).type, payload: event, receivedAt: new Date(), ...extra,
});

describe('worker', () => {
  it('claims, dispatches and marks processed; a second claim is skipped', async () => {
    (dispatchEvent as jest.Mock).mockResolvedValue('processed');
    const row = await store(stripeEvent('customer.subscription.updated', stripeSubscription()));
    expect(await processEvent(row.id)).toBe('processed');
    expect(await processEvent(row.id)).toBe('skipped');
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((await BillingEvent.findByPk(row.id))!.processedAt).not.toBeNull();
  });

  it('marks ignored when the env tag differs (§4.1)', async () => {
    const row = await store(stripeEvent('customer.subscription.updated', stripeSubscription({ env: 'prod' })));
    expect(await processEvent(row.id)).toBe('ignored');
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('records failures with attempts and last_error', async () => {
    (dispatchEvent as jest.Mock).mockRejectedValue(new Error('stripe timeout'));
    const row = await store(stripeEvent('invoice.paid', {}));
    expect(await processEvent(row.id)).toBe('failed');
    expect(await BillingEvent.findByPk(row.id)).toMatchObject({ status: 'failed', attempts: 1, lastError: 'stripe timeout' });
  });

  it('the sweep recovers a crash in processing (T2)', async () => {
    (dispatchEvent as jest.Mock).mockResolvedValue('processed');
    const row = await store(stripeEvent('invoice.paid', {}), { status: 'processing', lockedAt: new Date(Date.now() - 11 * 60_000) });
    const res = await sweepEvents();
    await __drainForTests();
    expect(res.reset).toBe(1);
    expect((await BillingEvent.findByPk(row.id))!.status).toBe('processed');
  });

  it('the sweep does not clobber a row that finished after it was read (finding 10)', async () => {
    const row = await store(stripeEvent('invoice.paid', {}), { status: 'processing', lockedAt: new Date(Date.now() - 11 * 60_000) });
    const snapshot = (await BillingEvent.findByPk(row.id))!; // what sweep's findAll saw
    await BillingEvent.update({ status: 'processed', processedAt: new Date(), lockedAt: null }, { where: { id: row.id } }); // worker finished meanwhile
    const spy = jest.spyOn(BillingEvent, 'findAll').mockImplementationOnce(async () => [snapshot]);
    const res = await sweepEvents();
    spy.mockRestore();
    await __drainForTests();
    expect(res.reset).toBe(0);
    expect(await BillingEvent.findByPk(row.id)).toMatchObject({ status: 'processed', attempts: 0 });
  });

  it('respects exponential backoff and moves attempts >= 8 to dead with review + alert', async () => {
    (dispatchEvent as jest.Mock).mockResolvedValue('processed');
    expect(backoffMs(1)).toBe(2 * 60_000);
    expect(backoffMs(10)).toBe(60 * 60_000);
    const waiting = await store(stripeEvent('invoice.paid', {}), { status: 'failed', attempts: 3 });
    await sweepEvents();
    await __drainForTests();
    expect((await BillingEvent.findByPk(waiting.id))!.status).toBe('failed');
    await sweepEvents(new Date(Date.now() + 9 * 60_000));
    await __drainForTests();
    expect((await BillingEvent.findByPk(waiting.id))!.status).toBe('processed');

    const dead = await store(stripeEvent('invoice.paid', {}), { status: 'failed', attempts: 8 });
    expect((await sweepEvents()).dead).toBe(1);
    expect((await BillingEvent.findByPk(dead.id))!.status).toBe('dead');
    expect(await BillingReconciliationItem.count({ where: { kind: 'dead_event' } })).toBe(1);
    expect(alertStaff).toHaveBeenCalled();
  });

  it('enqueue processes in the background', async () => {
    (dispatchEvent as jest.Mock).mockResolvedValue('ignored');
    const row = await store(stripeEvent('payment_intent.created', {}));
    enqueueEvent(row.id);
    await __drainForTests();
    expect((await BillingEvent.findByPk(row.id))!.status).toBe('ignored');
  });
});
