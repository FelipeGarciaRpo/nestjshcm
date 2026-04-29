import {
  Controller, Post, Body, Headers, HttpCode,
  UnauthorizedException, Logger, Inject, forwardRef,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { HcmWebhookDto, HcmBatchSyncDto } from './dto/hcm-sync.dto';
import { BalanceService } from '../balance/balance.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AuditSource } from '../audit/entities/audit-log.entity';

@ApiTags('HCM Sync')
@Controller('hcm')
export class HcmSyncController {
  private readonly logger = new Logger(HcmSyncController.name);

  constructor(
    @Inject(forwardRef(() => BalanceService))
    private readonly balanceService: BalanceService,
    private readonly auditService: AuditService,
    private readonly config: ConfigService,
  ) {}

  /**
   * POST /hcm/webhook
   * Receives HCM-initiated balance change events (anniversary, HR adjustment, etc.)
   * Verifies HMAC-SHA256 signature before processing.
   */
  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Receive HCM-initiated balance change webhook' })
  async receiveWebhook(
    @Headers('x-hcm-signature') signature: string,
    @Body() dto: HcmWebhookDto,
  ) {
    this.verifySignature(dto, signature);

    this.logger.log(
      `[Webhook] Received ${dto.eventType} for ${dto.employeeId}/${dto.locationId}/${dto.leaveTypeId}`,
    );

    await this.balanceService.applyHcmBalance(
      dto.employeeId,
      dto.locationId,
      dto.leaveTypeId,
      dto.newBalance,
      AuditSource.HCM,
      { hcmEventId: dto.hcmEventId, reason: dto.reason, eventType: dto.eventType },
    );

    await this.auditService.log({
      entityType: 'Balance',
      action: AuditAction.WEBHOOK_RECEIVED,
      source: AuditSource.HCM,
      newValue: { newBalance: dto.newBalance },
      metadata: { hcmEventId: dto.hcmEventId, eventType: dto.eventType, reason: dto.reason },
    });

    return { received: true, hcmEventId: dto.hcmEventId };
  }

  /**
   * POST /hcm/batch-sync
   * Receives the full corpus of balances from HCM.
   * Processed asynchronously with conflict resolution per record.
   */
  @Post('batch-sync')
  @HttpCode(202)
  @ApiOperation({ summary: 'Receive full balance batch from HCM' })
  async receiveBatch(
    @Headers('x-hcm-signature') signature: string,
    @Body() dto: HcmBatchSyncDto,
  ) {
    this.verifySignature(dto, signature);

    this.logger.log(
      `[Batch] Received batch ${dto.batchId} with ${dto.records.length} records`,
    );

    await this.auditService.log({
      entityType: 'Batch',
      action: AuditAction.BATCH_SYNC_RECEIVED,
      source: AuditSource.HCM,
      metadata: { batchId: dto.batchId, recordCount: dto.records.length, generatedAt: dto.generatedAt },
    });

    // Process async — don't block the 202 response
    setImmediate(async () => {
      for (const record of dto.records) {
        try {
          await this.balanceService.applyHcmBalance(
            record.employeeId,
            record.locationId,
            record.leaveTypeId,
            record.balance,
            AuditSource.HCM,
            { batchId: dto.batchId },
          );
        } catch (err: any) {
          this.logger.error(
            `[Batch] Failed to apply record ${record.employeeId}/${record.locationId}: ${err.message}`,
          );
        }
      }
      this.logger.log(`[Batch] ${dto.batchId} processing complete`);
    });

    return { accepted: true, batchId: dto.batchId, recordCount: dto.records.length };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private verifySignature(payload: object, signature: string): void {
    if (!signature) {
      throw new UnauthorizedException('Missing x-hcm-signature header');
    }

    const secret = this.config.get<string>('app.webhookSecret') ?? '';
    const expected = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex');

    try {
      const valid = crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(signature, 'hex'),
      );
      if (!valid) throw new UnauthorizedException('Invalid webhook signature');
    } catch {
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }
}