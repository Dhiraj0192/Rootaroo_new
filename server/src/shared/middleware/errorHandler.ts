import { Request, Response, NextFunction } from 'express';
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
