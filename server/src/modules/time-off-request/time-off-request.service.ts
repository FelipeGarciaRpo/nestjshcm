import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TimeOffRequest, TimeOffStatus } from './entities/time-off-request.entity';
import { CreateTimeOffRequestDto, ListRequestsQueryDto } from './dto/time-off-request.dto';
import { BalanceService } from '../balance/balance.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AuditSource } from '../audit/entities/audit-log.entity';
import { HcmClientService } from '../hcm-sync/hcm-client.service';

@Injectable()
export class TimeOffRequestService {
  private readonly logger = new Logger(TimeOffRequestService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly repo: Repository<TimeOffRequest>,
    private readonly balanceService: BalanceService,
    private readonly auditService: AuditService,
    private readonly hcmClient: HcmClientService,
  ) {}

  /**
   * Creates a new time-off request.
   * Validates dates, checks balance locally, verifies with HCM.
   * Idempotent: duplicate idempotencyKey returns the original request.
   */
  async create(dto: CreateTimeOffRequestDto): Promise<TimeOffRequest> {
    // Idempotency check
    if (dto.idempotencyKey) {
      const existing = await this.repo.findOne({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        this.logger.log(`[Idempotency] Returning existing request for key ${dto.idempotencyKey}`);
        return existing;
      }
    }

    // Validate date logic
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (start < today) {
      throw new BadRequestException('startDate cannot be in the past');
    }

    if (end < start) {
      throw new BadRequestException('endDate must be after or equal to startDate');
    }

    const totalDays = this.calculateWorkDays(start, end);

    // Layer 1: Local cache check (fast, no HCM call)
    const { balances } = await this.balanceService.getBalance(dto.employeeId, dto.locationId);
    const localBalance = balances.find((b) => b.leaveTypeId === dto.leaveTypeId);

    if (localBalance && localBalance.availableDays < totalDays) {
      throw new UnprocessableEntityException({
        error: 'INSUFFICIENT_BALANCE',
        message: `Insufficient balance. Available: ${localBalance.availableDays}, Requested: ${totalDays}`,
        available: localBalance.availableDays,
        requested: totalDays,
        balanceSource: 'cache',
      });
    }

    // Layer 2: HCM realtime check
    let needsVerification = false;
    const hcmData = await this.hcmClient.getBalance(dto.employeeId, dto.locationId);

    if (!hcmData) {
      // HCM unavailable — proceed with local cache but flag for re-verification at approval
      this.logger.warn(`[HCM] Unavailable for ${dto.employeeId} — flagging request for re-verification`);
      needsVerification = true;
    } else {
      const hcmRecord = hcmData.balances.find((b) => b.leaveTypeId === dto.leaveTypeId);
      if (hcmRecord && hcmRecord.availableDays < totalDays) {
        throw new UnprocessableEntityException({
          error: 'INSUFFICIENT_BALANCE',
          message: `Insufficient balance per HCM. Available: ${hcmRecord.availableDays}, Requested: ${totalDays}`,
          available: hcmRecord.availableDays,
          requested: totalDays,
          balanceSource: 'hcm',
        });
      }
    }

    const request = this.repo.create({
      ...dto,
      totalDays,
      status: TimeOffStatus.PENDING,
      idempotencyKey: dto.idempotencyKey ?? uuidv4(),
      needsVerification,
    });

    const saved = await this.repo.save(request);

    await this.auditService.log({
      entityType: 'TimeOffRequest',
      entityId: saved.id,
      action: AuditAction.REQUEST_CREATED,
      actorId: dto.employeeId,
      source: AuditSource.USER,
      newValue: { status: saved.status, totalDays, needsVerification },
    });

    return saved;
  }

  /**
   * Manager approves a pending request.
   * Re-validates balance, deducts via optimistic lock, writes outbox event.
   */
  async approve(id: string, managerId: string): Promise<TimeOffRequest> {
    const request = await this.findOrThrow(id);

    if (request.status !== TimeOffStatus.PENDING) {
      throw new ConflictException(`Cannot approve a request with status ${request.status}`);
    }

    // If flagged for re-verification (HCM was down at submission time)
    if (request.needsVerification) {
      const hcmData = await this.hcmClient.getBalance(request.employeeId, request.locationId);
      if (!hcmData) {
        throw new UnprocessableEntityException(
          'Cannot approve: HCM is unavailable and balance requires verification',
        );
      }
    }

    // Deduct balance with optimistic locking (may throw ConflictException — caller retries)
    await this.balanceService.deductBalance(
      request.employeeId,
      request.locationId,
      request.leaveTypeId,
      request.totalDays,
      request.id,
      managerId,
    );

    request.status = TimeOffStatus.APPROVED;
    request.managerId = managerId;
    request.approvedAt = new Date();
    request.needsVerification = false;
    await this.repo.save(request);

    await this.auditService.log({
      entityType: 'TimeOffRequest',
      entityId: request.id,
      action: AuditAction.REQUEST_APPROVED,
      actorId: managerId,
      source: AuditSource.USER,
      previousValue: { status: TimeOffStatus.PENDING },
      newValue: { status: TimeOffStatus.APPROVED },
    });

    return request;
  }

  /**
   * Manager rejects a pending request. No balance changes needed.
   */
  async reject(id: string, managerId: string, reason?: string): Promise<TimeOffRequest> {
    const request = await this.findOrThrow(id);

    if (request.status !== TimeOffStatus.PENDING) {
      throw new ConflictException(`Cannot reject a request with status ${request.status}`);
    }

    request.status = TimeOffStatus.REJECTED;
    request.managerId = managerId;
    request.rejectedAt = new Date();
    if (reason) request.notes = reason;
    await this.repo.save(request);

    await this.auditService.log({
      entityType: 'TimeOffRequest',
      entityId: request.id,
      action: AuditAction.REQUEST_REJECTED,
      actorId: managerId,
      source: AuditSource.USER,
      metadata: { reason },
    });

    return request;
  }

  /**
   * Employee cancels their own request.
   * If APPROVED → restores balance via credit (also creates outbox event).
   * If PENDING → just cancels with no balance change.
   */
  async cancel(id: string, actorId: string): Promise<TimeOffRequest> {
    const request = await this.findOrThrow(id);

    if (![TimeOffStatus.PENDING, TimeOffStatus.APPROVED].includes(request.status)) {
      throw new ConflictException(`Cannot cancel a request with status ${request.status}`);
    }

    if (request.status === TimeOffStatus.APPROVED) {
      await this.balanceService.creditBalance(
        request.employeeId,
        request.locationId,
        request.leaveTypeId,
        request.totalDays,
        request.id,
        actorId,
      );
    }

    request.status = TimeOffStatus.CANCELLED;
    request.cancelledAt = new Date();
    await this.repo.save(request);

    await this.auditService.log({
      entityType: 'TimeOffRequest',
      entityId: request.id,
      action: AuditAction.REQUEST_CANCELLED,
      actorId,
      source: AuditSource.USER,
      previousValue: { status: request.status },
      newValue: { status: TimeOffStatus.CANCELLED },
    });

    return request;
  }

  async findOne(id: string): Promise<TimeOffRequest> {
    return this.findOrThrow(id);
  }

  async findAll(query: ListRequestsQueryDto): Promise<{ data: TimeOffRequest[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.repo.createQueryBuilder('r');

    if (query.employeeId) qb.andWhere('r.employeeId = :empId', { empId: query.employeeId });
    if (query.locationId) qb.andWhere('r.locationId = :locId', { locId: query.locationId });
    if (query.status) qb.andWhere('r.status = :status', { status: query.status });
    if (query.startDate) qb.andWhere('r.startDate >= :start', { start: query.startDate });
    if (query.endDate) qb.andWhere('r.endDate <= :end', { end: query.endDate });

    qb.skip((page - 1) * limit).take(limit).orderBy('r.createdAt', 'DESC');

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async findOrThrow(id: string): Promise<TimeOffRequest> {
    const request = await this.repo.findOne({ where: { id } });
    if (!request) throw new NotFoundException(`TimeOffRequest ${id} not found`);
    return request;
  }

  private calculateWorkDays(start: Date, end: Date): number {
    let count = 0;
    const current = new Date(start);
    while (current <= end) {
      const day = current.getDay();
      if (day !== 0 && day !== 6) count++;
      current.setDate(current.getDate() + 1);
    }
    return count;
  }
}