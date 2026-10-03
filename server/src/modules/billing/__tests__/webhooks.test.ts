jest.mock('../worker', () => ({ enqueueEvent: jest.fn() }));
jest.mock('../../../database/models', () => ({ BillingEvent: { create: jest.fn() } }));

import { UniqueConstraintError } from 'sequelize';
import * as models from '../../../database/models';
import { enqueueEvent } from '../worker';
import { verifyStripeEvent, stripeWebhookHandler, WebhookVerificationError } from '../webhooks';
import { installStripeMock } from '../../../test/billing/stripeMock';
import { testBillingConfig } from '../../../test/billing/config';
import { fakeKey, fakeWebhookSecret } from '../../../test/billing/secrets';
import { signedWebhook } from '../../../test/billing/webhookSign';
import { stripeEvent } from '../../../test/billing/fixtures';

const A = fakeWebhookSecret('ua');
const B = fakeWebhookSecret('ub');
const event = stripeEvent('customer.updated', { id: 'cus_1' }, { id: 'evt_u1' });

beforeEach(() => {
  jest.clearAllMocks();
  installStripeMock('test', testBillingConfig({ modes: { test: { secretKey: fakeKey('sk_test'), webhookSecrets: [A, B] }, live: null } }));
});

function run(body: unknown, headers: Record<string, string> = {}, mode: 'test' | 'live' = 'test') {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const req: any = { body, header: (n: string) => headers[n.toLowerCase()] };
  return Promise.resolve(stripeWebhookHandler(mode)(req, res, jest.fn())).then(() => res);
}

describe('verifyStripeEvent', () => {
  it('verifies against any configured secret', () => {
    const { body, signature } = signedWebhook(event, B);
    expect(verifyStripeEvent(Buffer.from(body), signature, 'test').id).toBe('evt_u1');
  });

  it('rejects missing signature, wrong secret and unconfigured mode', () => {
    const { body, signature } = signedWebhook(event, fakeWebhookSecret('other'));
    expect(() => verifyStripeEvent(Buffer.from(body), undefined, 'test')).toThrow(WebhookVerificationError);
    expect(() => verifyStripeEvent(Buffer.from(body), signature, 'test')).toThrow('signature verification failed');
    expect(() => verifyStripeEvent(Buffer.from(body), signature, 'live')).toThrow('not configured');
  });
});

describe('stripeWebhookHandler', () => {
  const good = () => { const s = signedWebhook(event, A); return { body: Buffer.from(s.body), headers: { 'stripe-signature': s.signature } }; };

  it('persists, answers 200 and enqueues', async () => {
    (models.BillingEvent.create as jest.Mock).mockResolvedValue({ id: 'row1' });
    const { body, headers } = good();
    const res = await run(body, headers);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(enqueueEvent).toHaveBeenCalledWith('row1');
  });

  it('answers 200 on a duplicate without enqueueing', async () => {
    (models.BillingEvent.create as jest.Mock).mockRejectedValue(new UniqueConstraintError({}));
    const { body, headers } = good();
    const res = await run(body, headers);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it('answers 500 when persisting fails so Stripe retries', async () => {
    (models.BillingEvent.create as jest.Mock).mockRejectedValue(new Error('db down'));
    const { body, headers } = good();
    expect((await run(body, headers)).status).toHaveBeenCalledWith(500);
  });

  it('answers 400 for a non-buffer body, bad signature and livemode mismatch', async () => {
    expect((await run({ a: 1 })).status).toHaveBeenCalledWith(400);
    expect((await run(Buffer.from('{}'), { 'stripe-signature': 't=1,v1=bad' })).status).toHaveBeenCalledWith(400);
    const live = signedWebhook(stripeEvent('customer.updated', {}, { livemode: true }), A);
    expect((await run(Buffer.from(live.body), { 'stripe-signature': live.signature })).status).toHaveBeenCalledWith(400);
    expect(models.BillingEvent.create).not.toHaveBeenCalled();
  });
});
