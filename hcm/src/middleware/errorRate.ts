import { Request, Response, NextFunction } from 'express';

export function errorRateMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/admin') || req.path === '/health') {
    next();
    return;
  }

  const errorRate = parseFloat(process.env.ERROR_RATE_PERCENT ?? '0');

  if (errorRate > 0 && Math.random() * 100 < errorRate) {
    res.status(500).json({
      error: 'HCM_INTERNAL_ERROR',
      message: 'Simulated HCM internal error (chaos testing)',
      retryAfter: 30,
    });
    return;
  }

  next();
}