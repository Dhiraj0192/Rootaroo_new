import { errorHandler } from '../errorHandler';
import { AppError } from '../../utils/errors';

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('errorHandler', () => {
  it('merges AppError details into the body', () => {
    const res = mockRes();
    errorHandler(new AppError(402, 'Pay up', 'SUBSCRIPTION_REQUIRED', { reason: 'subscription_required', isAdmin: true }), {} as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      reason: 'subscription_required', isAdmin: true,
      success: false, error: 'Pay up', message: 'Pay up', code: 'SUBSCRIPTION_REQUIRED',
    });
  });

  it('never lets details override the core fields', () => {
    const res = mockRes();
    errorHandler(new AppError(409, 'No', 'X', { success: true, code: 'HACK' }), {} as any, res, jest.fn());
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: false, code: 'X' });
  });

  it('keeps the old shape when there are no details', () => {
    const res = mockRes();
    errorHandler(new AppError(404, 'Gone', 'NOT_FOUND'), {} as any, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Gone', message: 'Gone', code: 'NOT_FOUND' });
  });
});
