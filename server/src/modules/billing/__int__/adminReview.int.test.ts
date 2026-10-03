jest.mock('../alerts', () => ({ runReconciliationLocked: jest.fn(async (mode: string, kind: string) => ({ id: 'run-1', kind, livemode: mode === 'live', status: 'succeeded', counts: {} })) }));

import request from 'supertest';
import app from '../../../app';
import { setupAssociations, BillingReconciliationItem, BillingReconciliationRun, BillingEvent, AdminAuditLog } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';
import { runReconciliationLocked } from '../alerts';
import { __drainForTests } from '../worker';

const KEY = process.env.ADMIN_BILLING_API_KEY!;
const call = (method: 'get' | 'post', path: string, body?: unknown) => request(app)[method](`/api/v1/billing-admin${path}`).set('x-admin-billing-key', KEY).send(body as object);
beforeAll(() => setupAssociations());
beforeEach(async () => { await __drainForTests(); await resetDb(); installStripeMock('test', testBillingConfig({ adminKey: KEY })); });
afterAll(async () => { await __drainForTests(); await closeIntResources(); });

describe('review queue', () => {
  it('lists runs and items, and resolves an item with a note', async () => {
    await BillingReconciliationRun.create({ livemode: true, kind: 'daily', startedAt: new Date(), status: 'succeeded' });
    const item = await BillingReconciliationItem.create({ livemode: true, kind: 'unmatched_invoice', entityType: 'invoice', providerObjectId: 'in_1', resolution: 'needs_review' });
    expect((await call('get', '/reconciliation/runs?mode=live')).body.data).toHaveLength(1);
    expect((await call('get', '/reconciliation/runs?mode=test')).body.data).toHaveLength(0);
    expect((await call('get', '/reconciliation/items?mode=live&status=needs_review')).body.data).toHaveLength(1);
    expect((await call('get', '/reconciliation/items?mode=live&status=resolved')).body.data).toHaveLength(0);
    const res = await call('post', `/reconciliation/items/${item.id}/resolve`, { resolution: 'resolved', note: 'Matched by hand to household X' });
    expect(res.body.data).toMatchObject({ resolution: 'resolved', resolvedBy: 'billing-key', resolutionNote: 'Matched by hand to household X' });
    expect((await call('post', `/reconciliation/items/${item.id}/resolve`, { resolution: 'auto_fixed', note: 'x' })).status).toBe(400);
    expect((await call('post', `/reconciliation/items/${item.id}/resolve`, { resolution: 'ignored', note: '' })).status).toBe(400);
    expect((await call('post', '/reconciliation/items/00000000-0000-4000-8000-000000000000/resolve', { resolution: 'ignored', note: 'x' })).status).toBe(404);
  });

  it('paginates runs and items by cursor', async () => {
    for (let i = 0; i < 3; i++) {
      await BillingReconciliationRun.create({ livemode: true, kind: 'daily', startedAt: new Date(), status: 'succeeded' });
      await BillingReconciliationItem.create({ livemode: true, kind: 'k', entityType: 'invoice', providerObjectId: `in_${i}`, resolution: 'needs_review' });
    }
    const first = await call('get', '/reconciliation/runs?limit=2');
    expect(first.body.data).toHaveLength(2);
    const second = await call('get', `/reconciliation/runs?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const items = await call('get', '/reconciliation/items?limit=2');
    expect((await call('get', `/reconciliation/items?limit=2&cursor=${items.body.nextCursor}`)).body.data).toHaveLength(1);
  });

  it('runs a manual reconciliation for the requested mode and rejects a missing mode', async () => {
    const res = await call('post', '/reconciliation/run', { mode: 'test' });
    expect(res.status).toBe(200);
    expect(runReconciliationLocked).toHaveBeenCalledWith('test', 'manual');
    expect((await call('post', '/reconciliation/run', {})).status).toBe(400);
  });

  it('replays an event by id or provider id, and audits the note without the payload', async () => {
    const row = await BillingEvent.create({ provider: 'stripe', livemode: false, providerEventId: 'evt_r', type: 'payment_intent.created', payload: { id: 'evt_r', type: 'payment_intent.created', data: { object: {} } }, status: 'dead', attempts: 8, receivedAt: new Date() });
    const res = await call('post', '/events/evt_r/replay');
    expect(res.status).toBe(200);
    await __drainForTests();
    expect(await BillingEvent.findByPk(row.id)).toMatchObject({ status: 'ignored', attempts: 0 });
    expect((await call('post', `/events/${row.id}/replay`)).status).toBe(200);
    await __drainForTests();
    expect((await call('post', '/events/evt_missing/replay')).status).toBe(404);
    await new Promise((r) => setTimeout(r, 150));
    const audit = await AdminAuditLog.findOne({ where: { path: '/api/v1/billing-admin/events/evt_r/replay' } });
    expect(audit!.query).toMatchObject({ _note: { event: 'evt_r' } });
  });

  it('409 EVENT_PROCESSING while a worker holds the event', async () => {
    await BillingEvent.create({ provider: 'stripe', livemode: false, providerEventId: 'evt_busy', type: 'x', payload: {}, status: 'processing', lockedAt: new Date(), receivedAt: new Date() });
    const res = await call('post', '/events/evt_busy/replay');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EVENT_PROCESSING');
    expect((await BillingEvent.findOne({ where: { providerEventId: 'evt_busy' } }))!.status).toBe('processing');
  });
});
