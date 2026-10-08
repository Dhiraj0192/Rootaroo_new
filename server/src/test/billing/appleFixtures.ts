import crypto from 'crypto';
import { KEYUTIL, KJUR } from 'jsrsasign';

/**
 * A self-signed three-certificate chain shaped like Apple's (root, intermediate carrying OID 1.2.840.113635.100.6.2.1,
 * leaf carrying OID 1.2.840.113635.100.6.11.1), plus a JWS signer. Test material only: nothing here is trusted by production code
 * unless a test explicitly installs the root with __setAppleRootsForTests.
 */
export const LEAF_OID = '1.2.840.113635.100.6.11.1';
export const INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';

export interface TestChain {
  rootDer: Buffer;
  /** base64 DER, leaf first, as in the JWS x5c header */
  x5c: string[];
  leafKey: crypto.KeyObject;
}

function cert(opts: { subject: string; issuer: string; serial: number; pub: unknown; signerKey: unknown; ca: boolean; oid?: string }): string {
  const ext: Array<Record<string, unknown>> = [{ extname: 'basicConstraints', cA: opts.ca }];
  if (opts.oid) ext.push({ extname: opts.oid, extn: '0500' });
  return new KJUR.asn1.x509.Certificate({
    version: 3, serial: { int: opts.serial }, issuer: { str: opts.issuer }, subject: { str: opts.subject },
    notbefore: '200101000000Z', notafter: '21200101000000Z', sbjpubkey: opts.pub as never, ext: ext as never,
    sigalg: 'SHA256withECDSA', cakey: opts.signerKey as never,
  }).getPEM();
}

const b64 = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

export function buildTestChain(label = 'Test'): TestChain {
  const root = KEYUTIL.generateKeypair('EC', 'secp256r1');
  const inter = KEYUTIL.generateKeypair('EC', 'secp256r1');
  const leaf = KEYUTIL.generateKeypair('EC', 'secp256r1');
  const rootPem = cert({ subject: `/CN=${label} Root CA`, issuer: `/CN=${label} Root CA`, serial: 1, pub: root.pubKeyObj, signerKey: root.prvKeyObj, ca: true });
  const interPem = cert({ subject: `/CN=${label} Intermediate`, issuer: `/CN=${label} Root CA`, serial: 2, pub: inter.pubKeyObj, signerKey: root.prvKeyObj, ca: true, oid: INTERMEDIATE_OID });
  const leafPem = cert({ subject: `/CN=${label} Leaf`, issuer: `/CN=${label} Intermediate`, serial: 3, pub: leaf.pubKeyObj, signerKey: inter.prvKeyObj, ca: false, oid: LEAF_OID });
  return {
    rootDer: Buffer.from(b64(rootPem), 'base64'),
    x5c: [b64(leafPem), b64(interPem), b64(rootPem)],
    leafKey: crypto.createPrivateKey(KEYUTIL.getPEM(leaf.prvKeyObj, 'PKCS8PRV')),
  };
}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function signJws(payload: Record<string, unknown>, chain: TestChain, header: Record<string, unknown> = {}): string {
  const head = enc({ alg: 'ES256', x5c: chain.x5c, ...header });
  const body = enc(payload);
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: chain.leafKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

export const TEST_BUNDLE = 'com.rootaroo.app';
export const TEST_APP_APPLE_ID = 1234567890;

let n = 0;

export interface TxOverrides extends Record<string, unknown> {
  environment?: 'Sandbox' | 'Production';
}

export function appleTransaction(overrides: TxOverrides = {}): Record<string, unknown> {
  n += 1;
  const now = Date.now();
  return {
    originalTransactionId: '2000000111111', transactionId: `2000000${String(n).padStart(6, '0')}`,
    bundleId: TEST_BUNDLE, productId: 'rootaroo.hh5.month', subscriptionGroupIdentifier: '21000000',
    purchaseDate: now - 86400_000, originalPurchaseDate: now - 86400_000, expiresDate: now + 29 * 86400_000,
    quantity: 1, type: 'Auto-Renewable Subscription', inAppOwnershipType: 'PURCHASED', signedDate: now,
    environment: 'Sandbox', storefront: 'USA', currency: 'USD', price: 8990,
    ...overrides,
  };
}

export function appleRenewal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    originalTransactionId: '2000000111111', autoRenewProductId: 'rootaroo.hh5.month', productId: 'rootaroo.hh5.month',
    autoRenewStatus: 1, environment: 'Sandbox', signedDate: Date.now(), ...overrides,
  };
}

export interface NotificationSpec {
  type: string;
  subtype?: string;
  uuid?: string;
  tx?: Record<string, unknown> | null;
  renewal?: Record<string, unknown> | null;
  status?: number;
  environment?: 'Sandbox' | 'Production';
  bundleId?: string;
  appAppleId?: number;
  signedDate?: number;
}

/** A complete, validly signed ASSN V2 `signedPayload`. */
export function appleNotification(chain: TestChain, spec: NotificationSpec): string {
  const environment = spec.environment ?? 'Sandbox';
  const tx = spec.tx === null ? undefined : spec.tx ?? appleTransaction({ environment });
  const renewal = spec.renewal === null ? undefined : spec.renewal ?? appleRenewal({ environment });
  return signJws({
    notificationType: spec.type,
    ...(spec.subtype ? { subtype: spec.subtype } : {}),
    notificationUUID: spec.uuid ?? crypto.randomUUID(),
    version: '2.0',
    signedDate: spec.signedDate ?? Date.now(),
    data: {
      environment, appAppleId: spec.appAppleId ?? TEST_APP_APPLE_ID, bundleId: spec.bundleId ?? TEST_BUNDLE, bundleVersion: '1',
      ...(spec.status !== undefined ? { status: spec.status } : {}),
      ...(tx ? { signedTransactionInfo: signJws(tx, chain) } : {}),
      ...(renewal ? { signedRenewalInfo: signJws(renewal, chain) } : {}),
    },
  }, chain);
}
