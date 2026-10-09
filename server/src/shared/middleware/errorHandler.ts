import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import logger from '../utils/logger';
import { AppError } from '../utils/errors';
import { getErrorReporter } from '../../services';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      ...(err.details ?? {}),
      success: false,
      error: err.message,
      message: err.message,
      code: err.code,
    });
    return;
  }

  // Upload limits (too big, too many files) are the client's mistake, not a server failure.
  if (err instanceof multer.MulterError) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      success: false,
      error: err.message,
      message: err.message,
      code: tooLarge ? 'FILE_TOO_LARGE' : 'UPLOAD_REJECTED',
    });
    return;
  }

  logger.error('Unhandled error:', err);
  try {
    getErrorReporter().capture(err, { method: req.method, path: req.path });
  } catch {
    // reporting must never change the response
  }

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
}
