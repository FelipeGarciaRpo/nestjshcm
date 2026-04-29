import { Router, Request, Response } from 'express';
import { BalanceStore, UpdateBalanceBody } from '../types';
import { buildKey } from '../data/seed';

export function buildBalanceRouter(store: BalanceStore): Router {
  const router = Router();

  /**
   * GET /balances/:employeeId/:locationId
   * Returns all leave-type balances for an employee at a location.
   * Optionally filtered by ?leaveTypeId=vacation
   */
  router.get('/:employeeId/:locationId', (req: Request, res: Response): void => {
    const { employeeId, locationId } = req.params;
    const { leaveTypeId } = req.query as { leaveTypeId?: string };

    const results = [...store.values()].filter(
      (r) =>
        r.employeeId === employeeId &&
        r.locationId === locationId &&
        (!leaveTypeId || r.leaveTypeId === leaveTypeId),
    );

    if (results.length === 0) {
      res.status(404).json({
        error: 'EMPLOYEE_NOT_FOUND',
        message: `No balance found for employee ${employeeId} at location ${locationId}`,
      });
      return;
    }

    res.status(200).json({
      employeeId,
      locationId,
      balances: results,
      retrievedAt: new Date().toISOString(),
    });
  });

  /**
   * GET /balances/:employeeId/:locationId/:leaveTypeId
   * Returns one specific balance.
   */
  router.get('/:employeeId/:locationId/:leaveTypeId', (req: Request, res: Response): void => {
    const { employeeId, locationId, leaveTypeId } = req.params;
    const record = store.get(buildKey(employeeId, locationId, leaveTypeId));

    if (!record) {
      res.status(404).json({
        error: 'BALANCE_NOT_FOUND',
        message: `No balance found for ${employeeId}/${locationId}/${leaveTypeId}`,
      });
      return;
    }

    res.status(200).json(record);
  });

  /**
   * POST /balances/:employeeId/:locationId/:leaveTypeId
   * Updates a balance. Called by the ReadyOn Outbox worker on approval.
   * Body: { newBalance: number, reason?: string, idempotencyKey?: string }
   */
  router.post('/:employeeId/:locationId/:leaveTypeId', (req: Request<
    { employeeId: string; locationId: string; leaveTypeId: string },
    unknown,
    UpdateBalanceBody
  >, res: Response): void => {
    const { employeeId, locationId, leaveTypeId } = req.params;
    const { newBalance, reason, idempotencyKey } = req.body;

    if (newBalance === undefined || newBalance === null) {
      res.status(400).json({ error: 'MISSING_FIELD', message: 'newBalance is required' });
      return;
    }

    if (typeof newBalance !== 'number') {
      res.status(400).json({ error: 'INVALID_FIELD', message: 'newBalance must be a number' });
      return;
    }

    if (newBalance < 0) {
      res.status(422).json({
        error: 'INSUFFICIENT_BALANCE',
        message: `Cannot set balance to ${newBalance}. Balance cannot be negative.`,
        currentBalance: store.get(buildKey(employeeId, locationId, leaveTypeId))?.availableDays ?? 0,
      });
      return;
    }

    const key = buildKey(employeeId, locationId, leaveTypeId);
    const existing = store.get(key);

    if (!existing) {
      store.set(key, {
        employeeId,
        locationId,
        leaveTypeId,
        availableDays: newBalance,
        usedDays: 0,
        lastUpdated: new Date().toISOString(),
        updatedBy: reason ?? 'READYON_SYNC',
        idempotencyKey,
      });

      res.status(201).json({
        employeeId,
        locationId,
        leaveTypeId,
        previousBalance: null,
        newBalance,
        reason: reason ?? 'CREATED',
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    const previousBalance = existing.availableDays;

    store.set(key, {
      ...existing,
      availableDays: newBalance,
      lastUpdated: new Date().toISOString(),
      updatedBy: reason ?? 'READYON_SYNC',
      idempotencyKey,
    });

    res.status(200).json({
      employeeId,
      locationId,
      leaveTypeId,
      previousBalance,
      newBalance,
      reason: reason ?? 'READYON_SYNC',
      updatedAt: new Date().toISOString(),
    });
  });

  /**
   * DELETE /balances/:employeeId/:locationId/:leaveTypeId
   * Removes a balance entry. Used in test teardown only.
   */
  router.delete('/:employeeId/:locationId/:leaveTypeId', (req: Request, res: Response): void => {
    const { employeeId, locationId, leaveTypeId } = req.params;
    const key = buildKey(employeeId, locationId, leaveTypeId);

    if (!store.has(key)) {
      res.status(404).json({ error: 'BALANCE_NOT_FOUND' });
      return;
    }

    store.delete(key);
    res.status(204).send();
  });

  return router;
}