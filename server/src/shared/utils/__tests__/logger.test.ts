import { redactSecrets, deepRedact, redactFormat } from '../logger';

const k = (...p: string[]) => p.join('_');
const SK = k('sk', 'live', 'Abcdef123456');
const RK = k('rk', 'test', 'Zyxw98765432');
const WH = k('whsec', 'Qwerty123456789');

describe('logger redaction', () => {
  it('redacts every key shape in a string', () => {
    expect(redactSecrets(`a ${SK} b ${RK} c ${WH}`)).toBe('a [REDACTED] b [REDACTED] c [REDACTED]');
  });

  it('redacts nested objects, arrays and error stacks', () => {
    const err = new Error(`boom ${SK}`);
    const out = deepRedact({ a: [RK], b: { c: WH }, err }) as any;
    expect(JSON.stringify(out)).not.toMatch(/sk_live_A|rk_test_Z|whsec_Q/);
    expect(out.err.message).toBe('boom [REDACTED]');
  });

  it('redacts the winston info object including message, stack and meta', () => {
    const info: any = { level: 'error', message: `x ${SK}`, stack: `at ${WH}`, meta: { key: RK } };
    const out: any = redactFormat().transform(info, {});
    expect(out.message).toBe('x [REDACTED]');
    expect(out.stack).toBe('at [REDACTED]');
    expect(out.meta.key).toBe('[REDACTED]');
  });
});
