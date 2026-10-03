/* eslint-disable no-console */
/**
 * Wave 10 scenarios that need the Stripe-hosted Checkout page (E1-E4).
 * Usage (from server/, env loaded):  npx tsx scripts/e2e/hosted.ts E1|E2|E3|E4
 *
 * The script creates a household through the real API, starts Checkout through POST /billing/checkout,
 * prints the Checkout URL on a line starting with `CHECKOUT_URL ` and then waits (default 20 minutes)
 * for someone to complete the page. E1/E2/E3 poll POST /billing/checkout/:id/sync until the household is entitled.
 * E4 waits until the file  server/scripts/e2e/.continue-E4  exists (create it after submitting the declined card).
 * Cards: E1/E2 4242 4242 4242 4242, E3 4000 0025 0000 3155 (complete the 3DS challenge), E4 4000 0000 0000 9995.
 * Any future expiry, any CVC, ZIP 10001. The URL is never written to evidence.
 */
import fs from 'fs';
import path from 'path';
import { BillingCheckoutSession, BillingSubscription, BillingTransaction } from '../../src/database/models';
import { Scenario, adminSend, checkout, closeAll, guardedStatus, dbSnapshot, seedHousehold, sleep, status, sync, waitFor, EVIDENCE_DIR } from './harness';

const WAIT_MS = Number(process.env.E2E_HOSTED_WAIT_MS || 20 * 60_000);

const CONFIG: Record<string, { title: string; interval: 'month' | 'year'; seats: number; card: string }> = {
  E1: { title: 'Checkout 5 members monthly, card 4242', interval: 'month', seats: 5, card: '4242 4242 4242 4242' },
  E2: { title: 'Checkout 7 members yearly', interval: 'year', seats: 7, card: '4242 4242 4242 4242' },
  E3: { title: '3DS card 4000 0025 0000 3155', interval: 'month', seats: 5, card: '4000 0025 0000 3155' },
  E4: { title: 'Declined card 4000 0000 0000 9995', interval: 'month', seats: 5, card: '4000 0000 0000 9995' },
};

async function run(id: string): Promise<void> {
  const cfg = CONFIG[id];
  const s = new Scenario(id, cfg.title);
  const h = await seedHousehold(id);
  s.check('household starts blocked (402)', (await guardedStatus(h)) === 402);
  const co = await checkout(h, cfg.interval, cfg.seats);
  s.check('POST /billing/checkout returns a hosted URL and session id', co.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(co.json?.data?.url) && /^cs_test_/.test(co.json?.data?.sessionId), { status: co.status });
  const sessionId: string = co.json.data.sessionId;
  console.log(`CHECKOUT_URL ${co.json.data.url}`);
  console.log(`CARD ${cfg.card}  (any future expiry, any CVC, ZIP 10001)  household=${h.householdId}`);

  if (id === 'E4') {
    const flag = path.resolve(__dirname, '.continue-E4');
    fs.rmSync(flag, { force: true });
    console.log(`Submit the declined card, then create ${flag}`);
    const end = Date.now() + WAIT_MS;
    while (!fs.existsSync(flag) && Date.now() < end) await sleep(2000);
    fs.rmSync(flag, { force: true });
    await sleep(3000);
    const st = await status(h);
    const syncRes = await sync(h, sessionId);
    s.check('no subscription row exists', (await BillingSubscription.count({ where: { householdId: h.householdId } })) === 0);
    s.check('entitlement still not allowed and guarded route still 402', st.json.data.entitlement.allowed === false && (await guardedStatus(h)) === 402, st.json.data.entitlement);
    s.check('sync reports the session as open (not complete)', syncRes.json?.data?.pendingCheckout?.state === 'open', syncRes.json?.data?.pendingCheckout);
    const again = await checkout(h, cfg.interval, cfg.seats);
    s.check('retrying checkout reuses the same open session', again.json?.data?.sessionId === sessionId);
    s.put('checkoutSessions', (await dbSnapshot(h.householdId)).checkoutSessions);
    s.finish();
    return;
  }

  console.log(`Waiting up to ${Math.round(WAIT_MS / 60000)} min for the Checkout page to be completed...`);
  const done = await waitFor(async () => {
    const r = await sync(h, sessionId);
    return r.json?.data?.entitlement?.allowed ? r.json.data : false;
  }, WAIT_MS, 4000, 'hosted checkout completion').catch(() => null);
  s.check('entitlement active after completing the hosted page (sync)', !!done, done?.pendingCheckout);
  if (!done) { s.put('snapshot', await dbSnapshot(h.householdId)); s.finish(); return; }

  const st = (await status(h)).json.data;
  const sub = await BillingSubscription.findOne({ where: { householdId: h.householdId } });
  s.check(`subscription ${cfg.interval}ly with ${cfg.seats} seats`, st.subscription?.interval === cfg.interval && st.subscription?.seats === cfg.seats && sub?.seats === cfg.seats && sub?.interval === cfg.interval, st.subscription);
  if (id === 'E2') s.check('price rootaroo_hh7_year = 12775', sub?.unitAmount === 12775, { unit: sub?.unitAmount });
  if (id === 'E1') s.check('monthly 5 seats = 899', sub?.unitAmount === 899, { unit: sub?.unitAmount });
  s.check('purchaser recorded on the subscription', sub?.purchasedByUserId === h.userId);
  s.check('guarded route no longer 402', (await guardedStatus(h)) !== 402);
  const pay = await waitFor(() => BillingTransaction.findOne({ where: { householdId: h.householdId, type: 'payment' } }), 90_000, 2000, 'ledger payment');
  s.check('ledger payment matched to household and purchaser', pay.matchStatus === 'matched' && pay.userId === h.userId && pay.amount === sub?.unitAmount, { amount: pay.amount, match: pay.matchStatus });
  let fresh = await BillingTransaction.findByPk(pay.id);
  if (fresh!.fee === null) { await adminSend('POST', '/reconciliation/run', { mode: 'test' }); fresh = await BillingTransaction.findByPk(pay.id); }
  s.check('fee and net filled (now or after reconcile)', fresh!.fee !== null && fresh!.net !== null && fresh!.fee + fresh!.net === fresh!.amount, { fee: fresh!.fee, net: fresh!.net });
  const row = await BillingCheckoutSession.findOne({ where: { providerSessionId: sessionId } });
  s.check('checkout session row marked complete', row?.status === 'complete', row?.status);
  s.put('snapshot', await dbSnapshot(h.householdId));
  s.finish();
}

(async () => {
  const id = process.argv[2];
  if (!CONFIG[id]) { console.error('usage: hosted.ts E1|E2|E3|E4'); process.exit(2); }
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  let code = 0;
  try { await run(id); } catch (err) { console.error(err); code = 1; }
  await closeAll();
  process.exit(code);
})();
