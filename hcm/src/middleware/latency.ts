import { Request, Response, NextFunction } from 'express';

export function latencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const min = parseInt(process.env.LATENCY_MIN_MS ?? '50', 10);
  const max = parseInt(process.env.LATENCY_MAX_MS ?? '300', 10);

  if (min === 0 && max === 0) {
    next();
    return;
  }

  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  setTimeout(next, delay);
}