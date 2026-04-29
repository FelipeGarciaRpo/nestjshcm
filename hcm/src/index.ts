import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { Server } from 'http';

import { buildInitialStore } from './data/seed';
import { latencyMiddleware } from './middleware/latency';
import { errorRateMiddleware } from './middleware/errorRate';
import { buildBalanceRouter } from './routes/balances';
import { buildAdminRouter } from './routes/admin';

const PORT = parseInt(process.env.PORT ?? '4000', 10);

const store = buildInitialStore();
const app = express();

// ─── Global Middleware ─────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('[:method] :url :status :response-time ms'));
app.use(latencyMiddleware);
app.use(errorRateMiddleware);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/balances', buildBalanceRouter(store));
app.use('/admin', buildAdminRouter(store));

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    server: 'HCM Mock',
    storeSize: store.size,
    errorRatePercent: parseFloat(process.env.ERROR_RATE_PERCENT ?? '0'),
    latencyRange: {
      minMs: parseInt(process.env.LATENCY_MIN_MS ?? '50', 10),
      maxMs: parseInt(process.env.LATENCY_MAX_MS ?? '300', 10),
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────

app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: `Route ${req.method} ${req.path} not found`,
    availableRoutes: [
      'GET  /health',
      'GET  /balances/:employeeId/:locationId',
      'GET  /balances/:employeeId/:locationId/:leaveTypeId',
      'POST /balances/:employeeId/:locationId/:leaveTypeId',
      'DELETE /balances/:employeeId/:locationId/:leaveTypeId',
      'POST /admin/trigger-anniversary',
      'POST /admin/trigger-year-refresh',
      'POST /admin/adjust-balance',
      'POST /admin/batch-sync',
      'POST /admin/set-error-rate',
      'POST /admin/set-latency',
      'GET  /admin/store',
      'POST /admin/reset',
    ],
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[HCM] Unhandled error:', err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
});

// ─── Server Bootstrap ─────────────────────────────────────────────────────────

export function startServer(port: number = PORT): Server {
  const server = app.listen(port, () => {
    console.log(`\n🏢  HCM Mock Server running on http://localhost:${port}`);
    console.log(`📦  Store initialized with ${store.size} balance records`);
    console.log(`⚡  Error rate: ${process.env.ERROR_RATE_PERCENT ?? 0}%`);
    console.log(`🐌  Latency: ${process.env.LATENCY_MIN_MS ?? 50}ms–${process.env.LATENCY_MAX_MS ?? 300}ms\n`);
  });
  return server;
}

export { app, store };

if (require.main === module) {
  startServer();
}