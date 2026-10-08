import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';
import {
  KMSClient, GenerateMacCommand, VerifyMacCommand, EncryptCommand, DecryptCommand,
} from '@aws-sdk/client-kms';
import type { KeyVaultProvider, KeyVaultContext } from '../types';

/** Only ever used when KEY_VAULT_LOCAL_SECRET is unset outside production. */
export const DEV_KEY_VAULT_SECRET = 'rootaroo-development-only-key-vault-secret';

// The user id is part of every MAC input and every ciphertext, so one user's
// verifier or backup can never be replayed against another user.
const macMessage = (data: string, ctx: KeyVaultContext): string => `${ctx.userId}:${data}`;

export function createLocalKeyVault(secret: string): KeyVaultProvider {
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync('sha256', secret, 'rootaroo-key-vault-local', info, 32));
  const macKey = derive('mac');
  const encKey = derive('enc');
  const mac = (data: string, ctx: KeyVaultContext): Buffer =>
    createHmac('sha256', macKey).update(macMessage(data, ctx)).digest();

  return {
    name: 'local',
    async mac(data, ctx) {
      return mac(data, ctx).toString('base64');
    },
    async verifyMac(data, given, ctx) {
      const expected = mac(data, ctx);
      const actual = Buffer.from(given, 'base64');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
    async encrypt(plaintext, ctx) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encKey, iv);
      cipher.setAAD(Buffer.from(ctx.userId));
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
    },
    async decrypt(b64, ctx) {
      const raw = Buffer.from(b64, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', encKey, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(ctx.userId));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

type KmsSender = Pick<KMSClient, 'send'>;

export function createAwsKmsKeyVault(
  keys: { macKeyId: string; encKeyId: string },
  client: KmsSender,
): KeyVaultProvider {
  const send = (cmd: unknown): Promise<Record<string, unknown>> =>
    (client.send as unknown as (c: unknown) => Promise<Record<string, unknown>>)(cmd);
  return {
    name: 'aws-kms',
    async mac(data, ctx) {
      const out = await send(new GenerateMacCommand({
        KeyId: keys.macKeyId,
        MacAlgorithm: 'HMAC_SHA_256',
        Message: Buffer.from(macMessage(data, ctx)),
      }));
      return Buffer.from(out.Mac as Uint8Array).toString('base64');
    },
    async verifyMac(data, given, ctx) {
      try {
        const out = await send(new VerifyMacCommand({
          KeyId: keys.macKeyId,
          MacAlgorithm: 'HMAC_SHA_256',
          Message: Buffer.from(macMessage(data, ctx)),
          Mac: Buffer.from(given, 'base64'),
        }));
        return out.MacValid === true;
      } catch (err) {
        // Only a plain mismatch is "wrong password"; throttling or an outage must fail closed, not count as a guess.
        if ((err as Error).name === 'KMSInvalidMacException') return false;
        throw err;
      }
    },
    async encrypt(plaintext, ctx) {
      const out = await send(new EncryptCommand({
        KeyId: keys.encKeyId,
        Plaintext: Buffer.from(plaintext, 'utf8'),
        EncryptionContext: { userId: ctx.userId },
      }));
      return Buffer.from(out.CiphertextBlob as Uint8Array).toString('base64');
    },
    async decrypt(b64, ctx) {
      const out = await send(new DecryptCommand({
        KeyId: keys.encKeyId,
        CiphertextBlob: Buffer.from(b64, 'base64'),
        EncryptionContext: { userId: ctx.userId },
      }));
      return Buffer.from(out.Plaintext as Uint8Array).toString('utf8');
    },
  };
}

export function awsKmsKeyVaultFromEnv(src: NodeJS.ProcessEnv): KeyVaultProvider {
  return createAwsKmsKeyVault(
    { macKeyId: src.KEY_VAULT_MAC_KEY_ID as string, encKeyId: src.KEY_VAULT_ENC_KEY_ID as string },
    new KMSClient({ region: src.KEY_VAULT_REGION }),
  );
}
