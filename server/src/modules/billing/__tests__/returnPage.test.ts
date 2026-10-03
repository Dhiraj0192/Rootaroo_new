import { buildReturnTarget, returnPageHtml } from '../returnPage';
import { deriveCheckoutState } from '../checkout';

describe('return route (§8.2, B1)', () => {
  it.each([
    ['success', 'cs_test_a1B2', 'rootaroo://billing/success?session_id=cs_test_a1B2'],
    ['cancel', undefined, 'rootaroo://billing/cancel'],
    ['portal', undefined, 'rootaroo://billing/portal'],
  ])('%s -> deep link', (result, sid, target) => expect(buildReturnTarget(result, sid)).toBe(target));

  it.each([
    ['refund', undefined], ['success', 'cs_test_<script>'], ['success', 'pi_123'], ['success', ['cs_test_a', 'cs_test_b']], ['SUCCESS', undefined],
  ])('rejects %s / %p', (result, sid) => expect(buildReturnTarget(result as string, sid)).toBeNull());

  it('renders a static page with a plain link and no script', () => {
    const html = returnPageHtml('rootaroo://billing/success?session_id=cs_test_1');
    expect(html).toContain('href="rootaroo://billing/success?session_id=cs_test_1"');
    expect(html).toContain('Return to Rootaroo');
    expect(html).not.toMatch(/<script/i);
    expect(returnPageHtml(null)).not.toContain('href=');
  });
});

describe('deriveCheckoutState', () => {
  it('maps session status and entitlement', () => {
    expect(deriveCheckoutState('open', false)).toBe('open');
    expect(deriveCheckoutState('complete', false)).toBe('processing');
    expect(deriveCheckoutState('complete', true)).toBe('complete');
    expect(deriveCheckoutState('expired', false)).toBe('expired');
  });
});
