import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { OptimisticLockVersionMismatchError } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Balance } from './entities/balance.entity';
import { OutboxEvent, OutboxEventType, OutboxStatus } from '../outbox/entities/outbox-event.entity';
import { AuditService } from '../audit/audit.service';
import { HcmClientService } from '../hcm-sync/hcm-client.service';
import { AuditAction, AuditSource } from '../audit/entities/audit-log.entity';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    private readonly dataSource: DataSource,
    private readonly hcmClient: HcmClientService,
    private readonly auditService: AuditService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns the current balance for an employee/location.
   * Serves from local cache, async-refreshes if stale.
   */
  async getBalance(
    employeeId: string,
    locationId: string,
  ): Promise<{ balances: Balance[]; fromCache: boolean }> {
    const balances = await this.balanceRepo.find({
      where: { employeeId, locationId },
    });

    if (balances.length === 0) {
      // Never seen this employee — pull fresh from HCM
      await this.syncFromHcm(employeeId, locationId);
      const fresh = await this.balanceRepo.find({ where: { employeeId, locationId } });
      return { balances: fresh, fromCache: false };
    }

    const ttlSeconds = this.config.get<number>('app.balanceCacheTtlSeconds') ?? 300;
    const oldest = balances.reduce((a, b) =>
      (a.lastHcmSync ?? new Date(0)) < (b.lastHcmSync ?? new Date(0)) ? a : b,
    );
    const ageSeconds = oldest.lastHcmSync
      ? (Date.now() - oldest.lastHcmSync.getTime()) / 1000
      : Infinity;

    if (ageSeconds > ttlSeconds) {
      // Refresh async — don't block the response
      this.syncFromHcm(employeeId, locationId).catch((err) =>
        this.logger.error(`Background sync failed: ${err.message}`),
      );
    }

    return { balances, fromCache: true };
  }

  /**
   * Deducts days from the local balance using optimistic locking.
   * Also creates an Outbox event to sync the deduction to HCM.
   * Everything happens in a single DB transaction — atomic.
   *
   * @throws ConflictException if optimistic lock fails (caller should retry)
   * @throws UnprocessableEntityException if balance is insufficient
   */
  async deductBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    days: number,
    requestId: string,
    actorId: string,
  ): Promise<Balance> {
    return this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(Balance, {
        where: { employeeId, locationId, leaveTypeId },
      });

      if (!balance) {
        throw new NotFoundException(
          `No balance found for ${employeeId}/${locationId}/${leaveTypeId}`,
        );
      }

      if (balance.availableDays < days) {
        throw new UnprocessableEntityException({
          error: 'INSUFFICIENT_BALANCE',
          message: `Employee ${employeeId} has ${balance.availableDays} available days but requested ${days}`,
          available: balance.availableDays,
          requested: days,
          leaveType: leaveTypeId,
        });
      }

      const previousBalance = balance.availableDays;
      balance.availableDays = balance.availableDays - days;
      balance.usedDays = balance.usedDays + days;
      balance.pendingDays = Math.max(0, balance.pendingDays - days);

      // TypeORM will add WHERE version = :currentVersion — throws if concurrent update
      try {
        await manager.save(Balance, balance);
      } catch (err) {
        if (err instanceof OptimisticLockVersionMismatchError) {
          throw new ConflictException(
            'Balance was modified concurrently. Please retry the operation.',
          );
        }
        throw err;
      }

      // Write outbox event in same transaction — atomic with balance deduction
      const outboxEntry = manager.create(OutboxEvent, {
        eventType: OutboxEventType.BALANCE_DEBIT,
        payload: JSON.stringify({
          employeeId,
          locationId,
          leaveTypeId,
          newBalance: balance.availableDays,
          reason: 'time_off_approved',
        }),
        status: OutboxStatus.PENDING,
        idempotencyKey: uuidv4(),
        requestId,
      });
      await manager.save(OutboxEvent, outboxEntry);

      // Audit log (outside transaction — non-critical, best effort)
      this.auditService
        .log({
          entityType: 'Balance',
          entityId: balance.id,
          action: AuditAction.BALANCE_DEBIT,
          actorId,
          source: AuditSource.USER,
          previousValue: { availableDays: previousBalance },
          newValue: { availableDays: balance.availableDays },
          metadata: { requestId, days },
        })
        .catch((err) => this.logger.error(`Audit log failed: ${err.message}`));

      return balance;
    });
  }

  /**
   * Credits days back to a balance (used when a request is cancelled after approval).
   */
  async creditBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    days: number,
    requestId: string,
    actorId: string,
  ): Promise<Balance> {
    return this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(Balance, {
        where: { employeeId, locationId, leaveTypeId },
      });

      if (!balance) {
        throw new NotFoundException(`No balance found for ${employeeId}/${locationId}/${leaveTypeId}`);
      }

      const previousBalance = balance.availableDays;
      balance.availableDays = balance.availableDays + days;
      balance.usedDays = Math.max(0, balance.usedDays - days);

      try {
        await manager.save(Balance, balance);
      } catch (err) {
        if (err instanceof OptimisticLockVersionMismatchError) {
          throw new ConflictException('Balance was modified concurrently. Please retry.');
        }
        throw err;
      }

      const outboxEntry = manager.create(OutboxEvent, {
        eventType: OutboxEventType.BALANCE_CREDIT,
        payload: JSON.stringify({
          employeeId, locationId, leaveTypeId,
          newBalance: balance.availableDays,
          reason: 'time_off_cancelled',
        }),
        status: OutboxStatus.PENDING,
        idempotencyKey: uuidv4(),
        requestId,
      });
      await manager.save(OutboxEvent, outboxEntry);

      this.auditService.log({
        entityType: 'Balance',
        entityId: balance.id,
        action: AuditAction.BALANCE_CREDIT,
        actorId,
        source: AuditSource.USER,
        previousValue: { availableDays: previousBalance },
        newValue: { availableDays: balance.availableDays },
        metadata: { requestId, days },
      }).catch(() => {});

      return balance;
    });
  }

  /**
   * Applies HCM balance data to local cache with conflict resolution.
   * Called by webhook handler and batch sync processor.
   */
  async applyHcmBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    hcmBalance: number,
    source: AuditSource,
    metadata?: object,
  ): Promise<void> {
    // Check for pending outbox events that haven't been confirmed by HCM yet
    const pendingEvents = await this.outboxRepo
      .createQueryBuilder('o')
      .where('o.status = :status', { status: OutboxStatus.PENDING })
      .andWhere(`json_extract(o.payload, '$.employeeId') = :empId`, { empId: employeeId })
      .andWhere(`json_extract(o.payload, '$.locationId') = :locId`, { locId: locationId })
      .andWhere(`json_extract(o.payload, '$.leaveTypeId') = :ltId`, { ltId: leaveTypeId })
      .getMany();

    let resolvedBalance = hcmBalance;

    if (pendingEvents.length > 0) {
      // Conflict resolution: HCM doesn't know about our pending deductions yet
      // True balance = hcmBalance - sum(pendingDeductions)
      const pendingDeductions = pendingEvents
        .filter((e) => e.eventType === OutboxEventType.BALANCE_DEBIT)
        .reduce((sum, e) => {
          const p = JSON.parse(e.payload) as { newBalance: number };
          return sum + (hcmBalance - p.newBalance);
        }, 0);

      resolvedBalance = hcmBalance - pendingDeductions;

      this.logger.warn(
        `[ConflictResolution] ${employeeId}/${locationId}/${leaveTypeId}: ` +
        `HCM=${hcmBalance}, pendingDeductions=${pendingDeductions}, resolved=${resolvedBalance}`,
      );

      await this.auditService.log({
        entityType: 'Balance',
        action: AuditAction.CONFLICT_RESOLVED,
        source,
        metadata: { hcmBalance, pendingDeductions, resolvedBalance, pendingEventCount: pendingEvents.length },
      });
    }

    await this.upsertBalance(employeeId, locationId, leaveTypeId, resolvedBalance, source, metadata);
  }

  /**
   * Force-pulls balance from HCM and updates local cache.
   */
  async syncFromHcm(employeeId: string, locationId: string): Promise<void> {
    const hcmData = await this.hcmClient.getBalance(employeeId, locationId);

    if (!hcmData) {
      this.logger.warn(`[Sync] HCM unavailable for ${employeeId}/${locationId}, keeping cache`);
      return;
    }

    for (const record of hcmData.balances) {
      await this.upsertBalance(
        record.employeeId,
        record.locationId,
        record.leaveTypeId,
        record.availableDays,
        AuditSource.HCM,
        { triggeredBy: 'on_demand_sync' },
      );
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private async upsertBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    availableDays: number,
    source: AuditSource,
    metadata?: object,
  ): Promise<void> {
    const existing = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveTypeId },
    });

    if (existing) {
      const prev = existing.availableDays;
      existing.availableDays = availableDays;
      existing.lastHcmSync = new Date();
      await this.balanceRepo.save(existing);

      await this.auditService.log({
        entityType: 'Balance',
        entityId: existing.id,
        action: AuditAction.BALANCE_SYNC,
        source,
        previousValue: { availableDays: prev },
        newValue: { availableDays },
        metadata,
      });
    } else {
      const created = this.balanceRepo.create({
        employeeId, locationId, leaveTypeId,
        availableDays,
        usedDays: 0,
        pendingDays: 0,
        lastHcmSync: new Date(),
      });
      await this.balanceRepo.save(created);

      await this.auditService.log({
        entityType: 'Balance',
        entityId: created.id,
        action: AuditAction.BALANCE_SYNC,
        source,
        newValue: { availableDays },
        metadata,
      });
    }
  }
}