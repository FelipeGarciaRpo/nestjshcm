import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { OutboxEvent, OutboxStatus, OutboxEventType } from './entities/outbox-event.entity';
import { HcmClientService } from '../hcm-sync/hcm-client.service';

interface OutboxPayload {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  newBalance: number;
  reason: string;
}

@Injectable()
export class OutboxWorker {
  private readonly logger = new Logger(OutboxWorker.name);
  private isRunning = false;

  constructor(
    @InjectRepository(OutboxEvent)
    private readonly repo: Repository<OutboxEvent>,
    private readonly hcmClient: HcmClientService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Polls every 5 seconds for PENDING outbox events and attempts delivery to HCM.
   * Uses a mutex (isRunning) to prevent overlapping runs.
   */
  @Cron(CronExpression.EVERY_5_SECONDS)
  async processPending(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const pending = await this.repo.find({
        where: { status: OutboxStatus.PENDING },
        order: { createdAt: 'ASC' },
        take: 50,
      });

      if (pending.length === 0) return;

      this.logger.log(`[Outbox] Processing ${pending.length} pending event(s)`);

      for (const event of pending) {
        await this.processEvent(event);
      }
    } finally {
      this.isRunning = false;
    }
  }

  async processEvent(event: OutboxEvent): Promise<void> {
    const maxRetries = this.config.get<number>('app.outboxMaxRetries') ?? 5;
    const payload = JSON.parse(event.payload) as OutboxPayload;

    event.attempts++;
    event.lastAttemptAt = new Date();

    const success = await this.hcmClient.updateBalance(
      payload.employeeId,
      payload.locationId,
      payload.leaveTypeId,
      payload.newBalance,
      payload.reason,
      event.idempotencyKey,
    );

    if (success) {
      event.status = OutboxStatus.SENT;
      this.logger.log(`[Outbox] Event ${event.id} delivered to HCM ✓`);
    } else {
      if (event.attempts >= maxRetries) {
        event.status = OutboxStatus.FAILED;
        event.errorMessage = `Exceeded max retries (${maxRetries})`;
        this.logger.error(`[Outbox] Event ${event.id} FAILED after ${maxRetries} attempts`);
        // In production: send alert to PagerDuty / Slack
      } else {
        this.logger.warn(
          `[Outbox] Event ${event.id} attempt ${event.attempts}/${maxRetries} failed — will retry`,
        );
      }
    }

    await this.repo.save(event);
  }

  /** Returns stats for the /health endpoint */
  async getStats(): Promise<{ pending: number; failed: number }> {
    const [pending, failed] = await Promise.all([
      this.repo.count({ where: { status: OutboxStatus.PENDING } }),
      this.repo.count({ where: { status: OutboxStatus.FAILED } }),
    ]);
    return { pending, failed };
  }
}