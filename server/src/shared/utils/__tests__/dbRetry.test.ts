import { withDeadlockRetry, isDeadlock } from '../dbRetry';

const deadlock = () => Object.assign(new Error('Deadlock'), { parent: { code: 'ER_LOCK_DEADLOCK' } });

describe('withDeadlockRetry', () => {
  it('detects deadlocks on parent/original/code', () => {
    expect(isDeadlock(deadlock())).toBe(true);
    expect(isDeadlock({ original: { code: 'ER_LOCK_DEADLOCK' } })).toBe(true);
    expect(isDeadlock(new Error('x'))).toBe(false);
  });

  it('retries up to 3 times then succeeds', async () => {
    const fn = jest.fn().mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(deadlock()).mockResolvedValue('ok');
    await expect(withDeadlockRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('gives up after 3 retries', async () => {
    const fn = jest.fn().mockRejectedValue(deadlock());
    await expect(withDeadlockRetry(fn)).rejects.toThrow('Deadlock');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('does not retry other errors', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('other'));
    await expect(withDeadlockRetry(fn)).rejects.toThrow('other');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
