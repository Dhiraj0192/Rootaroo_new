import { errorHandler } from '../errorHandler';
import multer from 'multer';
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

  it('answers upload limit errors as client errors, not 500', () => {
    const big = mockRes();
    errorHandler(new multer.MulterError('LIMIT_FILE_SIZE', 'files'), {} as any, big, jest.fn());
    expect(big.status).toHaveBeenCalledWith(413);
    expect(big.json.mock.calls[0][0]).toMatchObject({ success: false, code: 'FILE_TOO_LARGE' });
    const many = mockRes();
    errorHandler(new multer.MulterError('LIMIT_FILE_COUNT', 'files'), {} as any, many, jest.fn());
    expect(many.status).toHaveBeenCalledWith(400);
  });
});
