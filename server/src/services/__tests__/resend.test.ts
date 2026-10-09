jest.mock('../../config/resend', () => ({ getResendClient: jest.fn() }));
import { getResendClient } from '../../config/resend';
import { resendEmail } from '../providers/email';

const send = (to = 'user@test.com') => resendEmail.send({ to, subject: 'Subject', text: 'Body' });

describe('resend email provider', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should throw if Resend is not configured', async () => {
    (getResendClient as jest.Mock).mockReturnValue(null);
    await expect(send()).rejects.toThrow('Resend is not configured');
  });

  it('should send successfully when the API returns no error', async () => {
    const emails = jest.fn().mockResolvedValue({ data: { id: 'email-1' }, error: null });
    (getResendClient as jest.Mock).mockReturnValue({ emails: { send: emails } });

    await send();

    expect(emails).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'user@test.com', subject: 'Subject', text: 'Body' }),
    );
  });

  // Resend's SDK resolves with { data, error } for API-level failures, so the
  // provider must check `error` itself or a failed send looks like success.
  it('should throw when the API returns an error, even though the promise resolved', async () => {
    const emails = jest.fn().mockResolvedValue({
      data: null,
      error: { statusCode: 403, message: 'The example.com domain is not verified.', name: 'validation_error' },
    });
    (getResendClient as jest.Mock).mockReturnValue({ emails: { send: emails } });

    await expect(send()).rejects.toThrow('domain is not verified');
  });
});
