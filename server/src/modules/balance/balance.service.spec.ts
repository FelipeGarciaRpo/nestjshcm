import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { OptimisticLockVersionMismatchError, DataSource } from 'typeorm';
import { BalanceService } from './balance.service';
import { Balance } from './entities/balance.entity';
import { OutboxEvent, OutboxStatus, OutboxEventType } from '../outbox/entities/outbox-event.entity';
import { AuditService } from '../audit/audit.service';
import { HcmClientService } from '../hcm-sync/hcm-client.service';
import { AuditSource } from '../audit/entities/audit-log.entity';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockBalanceRepo = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
});

const mockOutboxRepo = () => ({
  find: jest.fn(),
  createQueryBuilder: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
});

const mockDataSource = () => ({
  transaction: jest.fn(),
});

const mockAuditService = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

const mockHcmClient = () => ({
  getBalance: jest.fn(),
  circuitBreakerState: 'CLOSED',
});

const mockConfig = () => ({
  get: jest.fn().mockImplementation((key: string) => {
    if (key === 'app.balanceCacheTtlSeconds') return 300;
    if (key === 'app.nodeEnv') return 'test';
    return null;
  }),
});

// ─── Helper builders ─────────────────────────────────────────────────────────

function buildBalance(overrides: Partial<Balance> = {}): Balance {
  return {
    id: 'bal-1',
    employeeId: 'emp_001',
    locationId: 'loc_NY',
    leaveTypeId: 'vacation',
    availableDays: 10,
    usedDays: 0,
    pendingDays: 0,
    lastHcmSync: new Date(),
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Balance;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BalanceService', () => {
  let service: BalanceService;
  let balanceRepo: ReturnType<typeof mockBalanceRepo>;
  let outboxRepo: ReturnType<typeof mockOutboxRepo>;
  let dataSource: ReturnType<typeof mockDataSource>;
  let hcmClient: ReturnType<typeof mockHcmClient>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(Balance), useFactory: mockBalanceRepo },
        { provide: getRepositoryToken(OutboxEvent), useFactory: mockOutboxRepo },
        { provide: DataSource, useFactory: mockDataSource },
        { provide: AuditService, useFactory: mockAuditService },
        { provide: HcmClientService, useFactory: mockHcmClient },
        { provide: ConfigService, useFactory: mockConfig },
      ],
    }).compile();

    service = module.get(BalanceService);
    balanceRepo = module.get(getRepositoryToken(Balance));
    outboxRepo = module.get(getRepositoryToken(OutboxEvent));
    dataSource = module.get(DataSource);
    hcmClient = module.get(HcmClientService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── getBalance ───────────────────────────────────────────────────────────

  describe('getBalance()', () => {
    it('returns cached balances when fresh (within TTL)', async () => {
      const balance = buildBalance({ lastHcmSync: new Date() });
      balanceRepo.find.mockResolvedValue([balance]);

      const result = await service.getBalance('emp_001', 'loc_NY');

      expect(result.fromCache).toBe(true);
      expect(result.balances).toHaveLength(1);
    });

    it('triggers async HCM sync when cache is stale', async () => {
      const staleDate = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      const balance = buildBalance({ lastHcmSync: staleDate });
      balanceRepo.find.mockResolvedValue([balance]);
      hcmClient.getBalance.mockResolvedValue(null); // HCM unavailable, doesn't block

      const result = await service.getBalance('emp_001', 'loc_NY');

      // Still returns cached data immediately
      expect(result.fromCache).toBe(true);
      expect(result.balances).toHaveLength(1);
    });

    it('pulls from HCM when no local balance exists', async () => {
      balanceRepo.find
        .mockResolvedValueOnce([]) // first call - empty
        .mockResolvedValueOnce([buildBalance()]); // after sync

      hcmClient.getBalance.mockResolvedValue({
        employeeId: 'emp_001',
        locationId: 'loc_NY',
        balances: [{ employeeId: 'emp_001', locationId: 'loc_NY', leaveTypeId: 'vacation', availableDays: 10, usedDays: 0 }],
        retrievedAt: new Date().toISOString(),
      });

      balanceRepo.findOne.mockResolvedValue(null);
      balanceRepo.create.mockReturnValue(buildBalance());
      balanceRepo.save.mockResolvedValue(buildBalance());

      const result = await service.getBalance('emp_001', 'loc_NY');

      expect(result.fromCache).toBe(false);
    });
  });

  // ─── deductBalance ────────────────────────────────────────────────────────

  describe('deductBalance()', () => {
    it('deducts days and creates outbox event in a transaction', async () => {
      const balance = buildBalance({ availableDays: 10 });
      const savedBalance = buildBalance({ availableDays: 7 });
      const outboxEntry = { id: 'outbox-1' } as OutboxEvent;

      const mockManager = {
        findOne: jest.fn().mockResolvedValue(balance),
        save: jest.fn().mockResolvedValueOnce(savedBalance).mockResolvedValueOnce(outboxEntry),
        create: jest.fn().mockReturnValue(outboxEntry),
      };

      dataSource.transaction.mockImplementation((cb: any) => cb(mockManager));

      const result = await service.deductBalance(
        'emp_001', 'loc_NY', 'vacation', 3, 'req-1', 'mgr_001',
      );

      expect(mockManager.findOne).toHaveBeenCalledWith(Balance, {
        where: { employeeId: 'emp_001', locationId: 'loc_NY', leaveTypeId: 'vacation' },
      });
      expect(mockManager.save).toHaveBeenCalledTimes(2); // balance + outbox
      expect(result.availableDays).toBe(7);
    });

    it('throws NotFoundException when balance does not exist', async () => {
      const mockManager = {
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn(),
        create: jest.fn(),
      };
      dataSource.transaction.mockImplementation((cb: any) => cb(mockManager));

      await expect(
        service.deductBalance('emp_GHOST', 'loc_NY', 'vacation', 3, 'req-1', 'mgr_001'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws UnprocessableEntityException when balance is insufficient', async () => {
      const balance = buildBalance({ availableDays: 2 }); // only 2 days
      const mockManager = {
        findOne: jest.fn().mockResolvedValue(balance),
        save: jest.fn(),
        create: jest.fn(),
      };
      dataSource.transaction.mockImplementation((cb: any) => cb(mockManager));

      await expect(
        service.deductBalance('emp_001', 'loc_NY', 'vacation', 5, 'req-1', 'mgr_001'), // wants 5
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws ConflictException on optimistic lock version mismatch', async () => {
      const balance = buildBalance({ availableDays: 10 });
      const mockManager = {
        findOne: jest.fn().mockResolvedValue(balance),
        save: jest.fn().mockRejectedValue(new OptimisticLockVersionMismatchError('Balance', 1, 2)),
        create: jest.fn(),
      };
      dataSource.transaction.mockImplementation((cb: any) => cb(mockManager));

      await expect(
        service.deductBalance('emp_001', 'loc_NY', 'vacation', 3, 'req-1', 'mgr_001'),
      ).rejects.toThrow(ConflictException);
    });

    it('creates outbox event with BALANCE_DEBIT type in same transaction', async () => {
      const balance = buildBalance({ availableDays: 10 });
      const mockManager = {
        findOne: jest.fn().mockResolvedValue(balance),
        save: jest.fn().mockResolvedValue(balance),
        create: jest.fn().mockReturnValue({ id: 'outbox-1' }),
      };
      dataSource.transaction.mockImplementation((cb: any) => cb(mockManager));

      await service.deductBalance('emp_001', 'loc_NY', 'vacation', 3, 'req-1', 'mgr_001');

      expect(mockManager.create).toHaveBeenCalledWith(
        OutboxEvent,
        expect.objectContaining({
          eventType: OutboxEventType.BALANCE_DEBIT,
          status: OutboxStatus.PENDING,
        }),
      );
    });

    it('balance cannot go below zero — exactly 0 is allowed', async () => {
      const balance = buildBalance({ availableDays: 3 });
      const mockManager = {
        findOne: jest.fn().mockResolvedValue(balance),
        save: jest.fn().mockResolvedValue({ ...balance, availableDays: 0 }),
        create: jest.fn().mockReturnValue({}),
      };
      dataSource.transaction.mockImplementation((cb: any) => cb(mockManager));

      const result = await service.deductBalance(
        'emp_001', 'loc_NY', 'vacation', 3, 'req-1', 'mgr_001',
      );

      expect(result.availableDays).toBe(0);
    });
  });

  // ─── creditBalance ────────────────────────────────────────────────────────

  describe('creditBalance()', () => {
    it('restores days and creates BALANCE_CREDIT outbox event', async () => {
      const balance = buildBalance({ availableDays: 7, usedDays: 3 });
      const mockManager = {
        findOne: jest.fn().mockResolvedValue(balance),
        save: jest.fn().mockResolvedValue({ ...balance, availableDays: 10, usedDays: 0 }),
        create: jest.fn().mockReturnValue({}),
      };
      dataSource.transaction.mockImplementation((cb: any) => cb(mockManager));

      const result = await service.creditBalance(
        'emp_001', 'loc_NY', 'vacation', 3, 'req-1', 'emp_001',
      );

      expect(result.availableDays).toBe(10);
      expect(mockManager.create).toHaveBeenCalledWith(
        OutboxEvent,
        expect.objectContaining({ eventType: OutboxEventType.BALANCE_CREDIT }),
      );
    });

    it('throws ConflictException on optimistic lock failure during credit', async () => {
      const balance = buildBalance({ availableDays: 7 });
      const mockManager = {
        findOne: jest.fn().mockResolvedValue(balance),
        save: jest.fn().mockRejectedValue(new OptimisticLockVersionMismatchError('Balance', 1, 2)),
        create: jest.fn(),
      };
      dataSource.transaction.mockImplementation((cb: any) => cb(mockManager));

      await expect(
        service.creditBalance('emp_001', 'loc_NY', 'vacation', 3, 'req-1', 'emp_001'),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ─── applyHcmBalance ──────────────────────────────────────────────────────

  describe('applyHcmBalance()', () => {
    it('applies HCM balance directly when no pending outbox events exist', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      outboxRepo.createQueryBuilder.mockReturnValue(qb);

      const existing = buildBalance({ availableDays: 8 });
      balanceRepo.findOne.mockResolvedValue(existing);
      balanceRepo.save.mockResolvedValue({ ...existing, availableDays: 15 });

      await service.applyHcmBalance(
        'emp_001', 'loc_NY', 'vacation', 15, AuditSource.HCM,
      );

      expect(balanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ availableDays: 15 }),
      );
    });

    it('applies conflict resolution when pending deductions exist', async () => {
      // HCM says 10, but we have a pending deduction of 3 (outbox not sent yet)
      const pendingEvent = {
        id: 'outbox-1',
        eventType: OutboxEventType.BALANCE_DEBIT,
        status: OutboxStatus.PENDING,
        payload: JSON.stringify({ newBalance: 7 }), // 10 - 3 = 7
      } as OutboxEvent;

      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([pendingEvent]),
      };
      outboxRepo.createQueryBuilder.mockReturnValue(qb);

      const existing = buildBalance({ availableDays: 7 });
      balanceRepo.findOne.mockResolvedValue(existing);
      balanceRepo.save.mockResolvedValue(existing);

      await service.applyHcmBalance(
        'emp_001', 'loc_NY', 'vacation', 10, AuditSource.HCM,
      );

      // Should apply 10 - 3 = 7, not 10
      expect(balanceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ availableDays: 7 }),
      );
    });
  });
});