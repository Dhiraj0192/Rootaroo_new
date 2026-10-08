import { loadServicesConfig } from '../config';
import { createLocalKeyVault, createAwsKmsKeyVault } from '../providers/keyVault';

const prodBase = {
  NODE_ENV: 'production',
  RESEND_API_KEY: 'k', TWILIO_ACCOUNT_SID: 's', TWILIO_AUTH_TOKEN: 't', TWILIO_PHONE_NUMBER: '+1',
};

describe('key vault config', () => {
  it('development defaults to the local vault with a warning', () => {
    const { config, errors, warnings } = loadServicesConfig({ NODE_ENV: 'development' });
    expect(errors).toEqual([]);
    expect(config.keyVault).toBe('local');
    expect(warnings).toContain('KEY_VAULT_PROVIDER=local: backups are protected by a development key only');
  });

  it('production refuses the local vault and requires KMS settings', () => {
    expect(loadServicesConfig({ ...prodBase }).errors).toContain('KEY_VAULT_PROVIDER must be aws-kms in production');
    expect(loadServicesConfig({ ...prodBase, KEY_VAULT_PROVIDER: 'local', KEY_VAULT_LOCAL_SECRET: 'x'.repeat(64) }).errors)
      .toContain('KEY_VAULT_PROVIDER must be aws-kms in production');
    expect(loadServicesConfig({ ...prodBase, KEY_VAULT_PROVIDER: 'aws-kms' }).errors)
      .toContain('KEY_VAULT_PROVIDER=aws-kms needs KEY_VAULT_REGION, KEY_VAULT_MAC_KEY_ID, KEY_VAULT_ENC_KEY_ID');
    const ok = loadServicesConfig({
      ...prodBase, KEY_VAULT_PROVIDER: 'aws-kms', KEY_VAULT_REGION: 'ap-south-1',
      KEY_VAULT_MAC_KEY_ID: 'arn:mac', KEY_VAULT_ENC_KEY_ID: 'arn:enc',
    });
    expect(ok.errors).toEqual([]);
    expect(ok.config.keyVault).toBe('aws-kms');
  });

  it('a local secret must be long enough', () => {
    expect(loadServicesConfig({ NODE_ENV: 'development', KEY_VAULT_PROVIDER: 'local', KEY_VAULT_LOCAL_SECRET: 'short' }).errors)
      .toContain('KEY_VAULT_LOCAL_SECRET must be at least 32 characters');
  });
});

describe('local key vault', () => {
  const vault = createLocalKeyVault('a'.repeat(64));
  const ctx = { userId: 'u1' };

  it('mac is deterministic and verifies; a different input does not', async () => {
    const mac = await vault.mac('proof', ctx);
    expect(await vault.mac('proof', ctx)).toBe(mac);
    expect(await vault.verifyMac('proof', mac, ctx)).toBe(true);
    expect(await vault.verifyMac('wrong', mac, ctx)).toBe(false);
    expect(await vault.verifyMac('proof', mac, { userId: 'u2' })).toBe(false);
  });

  it('encrypt/decrypt round trip, bound to the user', async () => {
    const sealed = await vault.encrypt('blob-bytes', ctx);
    expect(sealed).not.toContain('blob-bytes');
    expect(await vault.decrypt(sealed, ctx)).toBe('blob-bytes');
    await expect(vault.decrypt(sealed, { userId: 'u2' })).rejects.toThrow();
  });
});

describe('AWS KMS key vault', () => {
  const send = jest.fn();
  const vault = createAwsKmsKeyVault({ macKeyId: 'arn:mac', encKeyId: 'arn:enc' }, { send } as never);
  beforeEach(() => send.mockReset());

  it('mac uses GenerateMac with HMAC-SHA-256 on the MAC key, with the user bound in', async () => {
    send.mockResolvedValue({ Mac: Buffer.from('m') });
    const mac = await vault.mac('proof', { userId: 'u1' });
    const cmd = send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('GenerateMacCommand');
    expect(cmd.input).toEqual(expect.objectContaining({ KeyId: 'arn:mac', MacAlgorithm: 'HMAC_SHA_256' }));
    expect(Buffer.from(cmd.input.Message).toString()).toContain('u1');
    expect(mac).toBe(Buffer.from('m').toString('base64'));
  });

  it('verifyMac uses VerifyMac and treats an invalid MAC as false, not an error', async () => {
    send.mockResolvedValueOnce({ MacValid: true });
    expect(await vault.verifyMac('proof', 'bQ==', { userId: 'u1' })).toBe(true);
    send.mockRejectedValueOnce(Object.assign(new Error('bad'), { name: 'KMSInvalidMacException' }));
    expect(await vault.verifyMac('proof', 'bQ==', { userId: 'u1' })).toBe(false);
    expect(send.mock.calls[0][0].constructor.name).toBe('VerifyMacCommand');
  });

  it('other KMS failures are errors (fail closed), not "wrong password"', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    await expect(vault.verifyMac('proof', 'bQ==', { userId: 'u1' })).rejects.toThrow();
  });

  it('encrypt uses the encryption key with the user as encryption context', async () => {
    send.mockResolvedValue({ CiphertextBlob: Buffer.from('c') });
    await vault.encrypt('blob', { userId: 'u1' });
    const cmd = send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('EncryptCommand');
    expect(cmd.input).toEqual(expect.objectContaining({ KeyId: 'arn:enc', EncryptionContext: { userId: 'u1' } }));
  });

  it('decrypt passes the same encryption context', async () => {
    send.mockResolvedValue({ Plaintext: Buffer.from('blob') });
    expect(await vault.decrypt(Buffer.from('c').toString('base64'), { userId: 'u1' })).toBe('blob');
    expect(send.mock.calls[0][0].input).toEqual(expect.objectContaining({ KeyId: 'arn:enc', EncryptionContext: { userId: 'u1' } }));
  });
});
