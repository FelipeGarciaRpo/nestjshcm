import { Router, Request, Response } from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  BalanceStore,
  TriggerAnniversaryBody,
  TriggerYearRefreshBody,
  AdjustBalanceBody,
  SetErrorRateBody,
  SetLatencyBody,
  WebhookPayload,
  WebhookEventType,
  WebhookDispatchResult,
} from '../types';
import { buildKey, buildInitialStore, LEAVE_TYPES } from '../data/seed';
import { signPayload } from '../utils/hmac';

export function buildAdminRouter(store: BalanceStore): Router {
  const router = Router();

  /**
   * POST /admin/trigger-anniversary
   * Simulates work anniversary bonus: adds days to an employee's vacation balance.
   */
  router.post('/trigger-anniversary', async (
    req: Request<object, unknown, TriggerAnniversaryBody>,
    res: Response,
  ): Promise<void> => {
    const { employeeId, locationId, bonusDays = 3 } = req.body;

    if (!employeeId || !locationId) {
      res.status(400).json({ error: 'employeeId and locationId are required' });
      return;
    }

    const key = buildKey(employeeId, locationId, LEAVE_TYPES.VACATION);
    const existing = store.get(key);

    if (!existing) {
      res.status(404).json({
        error: 'BALANCE_NOT_FOUND',
        message: `No vacation balance for ${employeeId} at ${locationId}`,
      });
      return;
    }

    const previousBalance = existing.availableDays;
    const newBalance = previousBalance + bonusDays;

    store.set(key, {
      ...existing,
      availableDays: newBalance,
      lastUpdated: new Date().toISOString(),
      updatedBy: 'WORK_ANNIVERSARY',
    });

    const webhookResult = await dispatchWebhook({
      hcmEventId: uuidv4(),
      eventType: 'BALANCE_CREDIT',
      employeeId,
      locationId,
      leaveTypeId: LEAVE_TYPES.VACATION,
      newBalance,
      previousBalance,
      reason: 'work_anniversary_bonus',
      effectiveDate: new Date().toISOString(),
    });

    res.status(200).json({
      message: 'Anniversary bonus applied',
      employeeId,
      locationId,
      previousBalance,
      newBalance,
      bonusDays,
      webhookDispatched: webhookResult.success,
      webhookError: webhookResult.error,
    });
  });

  /**
   * POST /admin/trigger-year-refresh
   * Simulates start-of-year balance reset for all employees.
   */
  router.post('/trigger-year-refresh', async (
    req: Request<object, unknown, TriggerYearRefreshBody>,
    res: Response,
  ): Promise<void> => {
    const {
      defaultVacationDays = 15,
      defaultSickDays = 10,
      defaultPersonalDays = 3,
    } = req.body;

    const defaults: Record<string, number> = {
      [LEAVE_TYPES.VACATION]: defaultVacationDays,
      [LEAVE_TYPES.SICK]: defaultSickDays,
      [LEAVE_TYPES.PERSONAL]: defaultPersonalDays,
    };

    let recordsUpdated = 0;
    const webhookPromises: Promise<WebhookDispatchResult>[] = [];

    for (const [key, record] of store.entries()) {
      const defaultDays = defaults[record.leaveTypeId];
      if (defaultDays === undefined) continue;

      const previousBalance = record.availableDays;
      store.set(key, {
        ...record,
        availableDays: defaultDays,
        usedDays: 0,
        lastUpdated: new Date().toISOString(),
        updatedBy: 'YEAR_START_REFRESH',
      });

      recordsUpdated++;

      webhookPromises.push(
        dispatchWebhook({
          hcmEventId: uuidv4(),
          eventType: 'BALANCE_REFRESH',
          employeeId: record.employeeId,
          locationId: record.locationId,
          leaveTypeId: record.leaveTypeId,
          newBalance: defaultDays,
          previousBalance,
          reason: 'year_start_refresh',
          effectiveDate: new Date().toISOString(),
        }),
      );
    }

    const results = await Promise.allSettled(webhookPromises);
    const successCount = results.filter(
      (r) => r.status === 'fulfilled' && r.value.success,
    ).length;

    res.status(200).json({
      message: 'Year-start refresh applied',
      recordsUpdated,
      webhooksDispatched: successCount,
      defaults,
    });
  });

  /**
   * POST /admin/adjust-balance
   * Manual HR override — set an exact balance for any employee/location/leaveType.
   */
  router.post('/adjust-balance', async (
    req: Request<object, unknown, AdjustBalanceBody>,
    res: Response,
  ): Promise<void> => {
    const { employeeId, locationId, leaveTypeId, newBalance, reason } = req.body;

    if (!employeeId || !locationId || !leaveTypeId || newBalance === undefined) {
      res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'employeeId, locationId, leaveTypeId, and newBalance are required',
      });
      return;
    }

    if (typeof newBalance !== 'number' || newBalance < 0) {
      res.status(400).json({
        error: 'INVALID_BALANCE',
        message: 'newBalance must be a non-negative number',
      });
      return;
    }

    const key = buildKey(employeeId, locationId, leaveTypeId);
    const existing = store.get(key);
    const previousBalance = existing?.availableDays ?? 0;

    store.set(key, {
      employeeId,
      locationId,
      leaveTypeId,
      availableDays: newBalance,
      usedDays: existing?.usedDays ?? 0,
      lastUpdated: new Date().toISOString(),
      updatedBy: reason ?? 'HR_ADJUSTMENT',
    });

    const webhookResult = await dispatchWebhook({
      hcmEventId: uuidv4(),
      eventType: 'BALANCE_ADJUSTMENT',
      employeeId,
      locationId,
      leaveTypeId,
      newBalance,
      previousBalance,
      reason: reason ?? 'hr_manual_adjustment',
      effectiveDate: new Date().toISOString(),
    });

    res.status(200).json({
      message: 'Balance adjusted',
      employeeId,
      locationId,
      leaveTypeId,
      previousBalance,
      newBalance,
      reason,
      webhookDispatched: webhookResult.success,
    });
  });

  /**
   * POST /admin/set-error-rate
   * Dynamically change chaos error injection rate (0–100).
   */
  router.post('/set-error-rate', (
    req: Request<object, unknown, SetErrorRateBody>,
    res: Response,
  ): void => {
    const { percent } = req.body;

    if (typeof percent !== 'number' || percent < 0 || percent > 100) {
      res.status(400).json({
        error: 'INVALID_PERCENT',
        message: 'percent must be a number between 0 and 100',
      });
      return;
    }

    process.env.ERROR_RATE_PERCENT = String(percent);
    res.status(200).json({ message: `Error rate set to ${percent}%`, errorRatePercent: percent });
  });

  /**
   * POST /admin/set-latency
   * Dynamically change simulated latency range.
   */
  router.post('/set-latency', (
    req: Request<object, unknown, SetLatencyBody>,
    res: Response,
  ): void => {
    const { minMs = 0, maxMs = 0 } = req.body;

    process.env.LATENCY_MIN_MS = String(minMs);
    process.env.LATENCY_MAX_MS = String(maxMs);

    res.status(200).json({
      message: `Latency set to ${minMs}ms–${maxMs}ms`,
      latencyMinMs: minMs,
      latencyMaxMs: maxMs,
    });
  });

  /**
   * POST /admin/batch-sync
   * Pushes the full corpus of balances to ReadyOn's batch endpoint.
   */
  router.post('/batch-sync', async (_req: Request, res: Response): Promise<void> => {
    const records = [...store.values()].map((r) => ({
      employeeId: r.employeeId,
      locationId: r.locationId,
      leaveTypeId: r.leaveTypeId,
      balance: r.availableDays,
      usedDays: r.usedDays,
    }));

    const batchPayload = {
      batchId: uuidv4(),
      generatedAt: new Date().toISOString(),
      records,
    };

    const readyonUrl =
      process.env.READYON_WEBHOOK_URL?.replace('/webhook', '/batch-sync') ??
      'http://localhost:3000/hcm/batch-sync';

    try {
      const secret = process.env.HCM_WEBHOOK_SECRET ?? 'super-secret-hmac-key-change-in-prod';
      const signature = signPayload(batchPayload, secret);

      await axios.post(readyonUrl, batchPayload, {
        headers: { 'Content-Type': 'application/json', 'x-hcm-signature': signature },
        timeout: 10_000,
      });

      res.status(200).json({
        message: 'Batch sync dispatched',
        batchId: batchPayload.batchId,
        recordCount: records.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: 'BATCH_DISPATCH_FAILED', message, readyonUrl });
    }
  });

  /**
   * GET /admin/store
   * Returns the full in-memory store. Useful for test assertions.
   */
  router.get('/store', (_req: Request, res: Response): void => {
    const data: Record<string, unknown> = {};
    for (const [key, value] of store.entries()) {
      data[key] = value;
    }
    res.status(200).json(data);
  });

  /**
   * POST /admin/reset
   * Resets store to the initial seed state. Used in test beforeEach.
   */
  router.post('/reset', (_req: Request, res: Response): void => {
    store.clear();
    const fresh = buildInitialStore();
    for (const [key, value] of fresh.entries()) {
      store.set(key, value);
    }
    res.status(200).json({ message: 'Store reset to seed state', count: store.size });
  });

  return router;
}

// ─── Internal webhook dispatcher ─────────────────────────────────────────────

async function dispatchWebhook(payload: WebhookPayload): Promise<WebhookDispatchResult> {
  const webhookUrl =
    process.env.READYON_WEBHOOK_URL ?? 'http://localhost:3000/hcm/webhook';
  const secret =
    process.env.HCM_WEBHOOK_SECRET ?? 'super-secret-hmac-key-change-in-prod';

  try {
    const signature = signPayload(payload, secret);

    await axios.post(webhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-hcm-signature': signature,
      },
      timeout: 5_000,
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[HCM] Webhook dispatch failed: ${message}`);
    return { success: false, error: message };
  }
}