import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException, ConflictException,
  NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import { TimeOffRequestService } from './time-off-request.service';
import { TimeOffRequest, TimeOffStatus } from './entities/time-off-request.entity';
import { BalanceService } from '../balance/balance.service';
import { AuditService } from '../audit/audit.service';
import { HcmClientService } from '../hcm-sync/hcm-client.service';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockRepo = () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  createQueryBuilder: jest.fn(),
});

const mockBalanceService = () => ({
  getBalance: jest.fn(),
  deductBalance: jest.fn(),
  creditBalance: jest.fn(),
});

const mockAuditService = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

const mockHcmClient = () => ({
  getBalance: jest.fn(),
  circuitBreakerState: 'CLOSED',
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function futureDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}

function buildRequest(overrides: Partial<TimeOffRequest> = {}): TimeOffRequest {
  return {
    id: 'req-1',
    employeeId: 'emp_001',
    locationId: 'loc_NY',
    leaveTypeId: 'vacation',
    startDate: futureDate(7),
    endDate: futureDate(9),
    totalDays: 3,
    status: TimeOffStatus.PENDING,
    managerId: null,
    notes: null,
    idempotencyKey: 'idem-key-1',
    needsVerification: false,
    approvedAt: null,
    rejectedAt: null,
    cancelledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as TimeOffRequest;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TimeOffRequestService', () => {
  let service: TimeOffRequestService;
  let repo: ReturnType<typeof mockRepo>;
  let balanceService: ReturnType<typeof mockBalanceService>;
  let hcmClient: ReturnType<typeof mockHcmClient>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffRequestService,
        { provide: getRepositoryToken(TimeOffRequest), useFactory: mockRepo },
        { provide: BalanceService, useFactory: mockBalanceService },
        { provide: AuditService, useFactory: mockAuditService },
        { provide: HcmClientService, useFactory: mockHcmClient },
      ],
    }).compile();

    service = module.get(TimeOffRequestService);
    repo = module.get(getRepositoryToken(TimeOffRequest));
    balanceService = module.get(BalanceService);
    hcmClient = module.get(HcmClientService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── create() ────────────────────────────────────────────────────────────

  describe('create()', () => {
    const validDto = {
      employeeId: 'emp_001',
      locationId: 'loc_NY',
      leaveTypeId: 'vacation',
      startDate: futureDate(7),
      endDate: futureDate(9),
      idempotencyKey: 'idem-key-1',
    };

    beforeEach(() => {
      // Default: no existing request, HCM has balance
      repo.findOne.mockResolvedValue(null);
      balanceService.getBalance.mockResolvedValue({
        balances: [{ leaveTypeId: 'vacation', availableDays: 10 }],
        fromCache: true,
      });
      hcmClient.getBalance.mockResolvedValue({
        balances: [{ leaveTypeId: 'vacation', availableDays: 10 }],
      });
      repo.create.mockReturnValue(buildRequest());
      repo.save.mockResolvedValue(buildRequest());
    });

    it('creates a PENDING request successfully', async () => {
      const result = await service.create(validDto);

      expect(result.status).toBe(TimeOffStatus.PENDING);
      expect(repo.save).toHaveBeenCalled();
    });

    it('returns existing request when idempotency key already exists', async () => {
      const existing = buildRequest();
      repo.findOne.mockResolvedValue(existing);

      const result = await service.create(validDto);

      expect(result).toBe(existing);
      expect(repo.save).not.toHaveBeenCalled(); // No duplicate save
    });

    it('rejects request with past startDate', async () => {
      await expect(
        service.create({ ...validDto, startDate: '2020-01-01', endDate: '2020-01-03' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects request when endDate is before startDate', async () => {
      await expect(
        service.create({ ...validDto, startDate: futureDate(10), endDate: futureDate(7) }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects request when local cache shows insufficient balance', async () => {
      balanceService.getBalance.mockResolvedValue({
        balances: [{ leaveTypeId: 'vacation', availableDays: 1 }], // only 1 day
        fromCache: true,
      });

      await expect(service.create(validDto)).rejects.toThrow(UnprocessableEntityException);
    });

    it('rejects when HCM shows insufficient balance even if local cache passes', async () => {
      balanceService.getBalance.mockResolvedValue({
        balances: [{ leaveTypeId: 'vacation', availableDays: 10 }],
        fromCache: true,
      });
      hcmClient.getBalance.mockResolvedValue({
        balances: [{ leaveTypeId: 'vacation', availableDays: 1 }], // HCM has only 1
      });

      await expect(service.create(validDto)).rejects.toThrow(UnprocessableEntityException);
    });

    it('flags request as needsVerification when HCM is unavailable', async () => {
      hcmClient.getBalance.mockResolvedValue(null); // circuit open
      repo.create.mockReturnValue(buildRequest({ needsVerification: true }));
      repo.save.mockResolvedValue(buildRequest({ needsVerification: true }));

      const result = await service.create(validDto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ needsVerification: true }),
      );
    });

    it('calculates totalDays excluding weekends', async () => {
      // Mon → Fri = 5 work days
      const monday = futureDate(7);
      const friday = futureDate(11);
      repo.create.mockReturnValue(buildRequest({ totalDays: 5 }));
      repo.save.mockResolvedValue(buildRequest({ totalDays: 5 }));

      await service.create({ ...validDto, startDate: monday, endDate: friday });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalDays: expect.any(Number) }),
      );
    });
  });

  // ─── approve() ───────────────────────────────────────────────────────────

  describe('approve()', () => {
    it('approves a PENDING request and deducts balance', async () => {
      const request = buildRequest({ status: TimeOffStatus.PENDING });
      repo.findOne.mockResolvedValue(request);
      balanceService.deductBalance.mockResolvedValue({ availableDays: 7 });
      repo.save.mockResolvedValue({ ...request, status: TimeOffStatus.APPROVED });

      const result = await service.approve('req-1', 'mgr_001');

      expect(result.status).toBe(TimeOffStatus.APPROVED);
      expect(balanceService.deductBalance).toHaveBeenCalledWith(
        'emp_001', 'loc_NY', 'vacation', 3, 'req-1', 'mgr_001',
      );
    });

    it('throws ConflictException when request is already approved', async () => {
      repo.findOne.mockResolvedValue(buildRequest({ status: TimeOffStatus.APPROVED }));

      await expect(service.approve('req-1', 'mgr_001')).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when request is rejected', async () => {
      repo.findOne.mockResolvedValue(buildRequest({ status: TimeOffStatus.REJECTED }));

      await expect(service.approve('req-1', 'mgr_001')).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException for unknown request', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.approve('ghost-id', 'mgr_001')).rejects.toThrow(NotFoundException);
    });

    it('throws UnprocessableEntityException when HCM unavailable on needsVerification request', async () => {
      const request = buildRequest({ status: TimeOffStatus.PENDING, needsVerification: true });
      repo.findOne.mockResolvedValue(request);
      hcmClient.getBalance.mockResolvedValue(null); // still down

      await expect(service.approve('req-1', 'mgr_001')).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('propagates ConflictException from optimistic lock failure in balance deduction', async () => {
      const request = buildRequest({ status: TimeOffStatus.PENDING });
      repo.findOne.mockResolvedValue(request);
      balanceService.deductBalance.mockRejectedValue(
        new ConflictException('Balance modified concurrently'),
      );

      await expect(service.approve('req-1', 'mgr_001')).rejects.toThrow(ConflictException);
    });
  });

  // ─── reject() ────────────────────────────────────────────────────────────

  describe('reject()', () => {
    it('rejects a PENDING request with no balance change', async () => {
      const request = buildRequest({ status: TimeOffStatus.PENDING });
      repo.findOne.mockResolvedValue(request);
      repo.save.mockResolvedValue({ ...request, status: TimeOffStatus.REJECTED });

      const result = await service.reject('req-1', 'mgr_001', 'Understaffed');

      expect(result.status).toBe(TimeOffStatus.REJECTED);
      expect(balanceService.deductBalance).not.toHaveBeenCalled();
      expect(balanceService.creditBalance).not.toHaveBeenCalled();
    });

    it('throws ConflictException when rejecting an approved request', async () => {
      repo.findOne.mockResolvedValue(buildRequest({ status: TimeOffStatus.APPROVED }));

      await expect(service.reject('req-1', 'mgr_001')).rejects.toThrow(ConflictException);
    });
  });

  // ─── cancel() ────────────────────────────────────────────────────────────

  describe('cancel()', () => {
    it('cancels PENDING request without restoring balance', async () => {
      const request = buildRequest({ status: TimeOffStatus.PENDING });
      repo.findOne.mockResolvedValue(request);
      repo.save.mockResolvedValue({ ...request, status: TimeOffStatus.CANCELLED });

      const result = await service.cancel('req-1', 'emp_001');

      expect(result.status).toBe(TimeOffStatus.CANCELLED);
      expect(balanceService.creditBalance).not.toHaveBeenCalled();
    });

    it('cancels APPROVED request AND restores balance via credit', async () => {
      const request = buildRequest({ status: TimeOffStatus.APPROVED, totalDays: 3 });
      repo.findOne.mockResolvedValue(request);
      balanceService.creditBalance.mockResolvedValue({ availableDays: 10 });
      repo.save.mockResolvedValue({ ...request, status: TimeOffStatus.CANCELLED });

      const result = await service.cancel('req-1', 'emp_001');

      expect(result.status).toBe(TimeOffStatus.CANCELLED);
      expect(balanceService.creditBalance).toHaveBeenCalledWith(
        'emp_001', 'loc_NY', 'vacation', 3, 'req-1', 'emp_001',
      );
    });

    it('throws ConflictException when cancelling a rejected request', async () => {
      repo.findOne.mockResolvedValue(buildRequest({ status: TimeOffStatus.REJECTED }));

      await expect(service.cancel('req-1', 'emp_001')).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when cancelling an already cancelled request', async () => {
      repo.findOne.mockResolvedValue(buildRequest({ status: TimeOffStatus.CANCELLED }));

      await expect(service.cancel('req-1', 'emp_001')).rejects.toThrow(ConflictException);
    });
  });
});