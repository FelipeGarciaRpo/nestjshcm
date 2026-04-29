import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from './audit.service';
import { AuditLog, AuditAction, AuditSource } from './entities/audit-log.entity';

const mockRepo = () => ({
  create: jest.fn(),
  save: jest.fn(),
});

describe('AuditService', () => {
  let service: AuditService;
  let repo: jest.Mocked<Partial<Repository<AuditLog>>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditLog), useFactory: mockRepo },
      ],
    }).compile();

    service = module.get(AuditService);
    repo = module.get(getRepositoryToken(AuditLog));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('log()', () => {
    it('creates and saves an audit entry with all fields', async () => {
      const entry = { id: 'audit-1' } as AuditLog;
      (repo.create as jest.Mock).mockReturnValue(entry);
      (repo.save as jest.Mock).mockResolvedValue(entry);

      await service.log({
        entityType: 'Balance',
        entityId: 'bal-1',
        action: AuditAction.BALANCE_DEBIT,
        actorId: 'emp_001',
        source: AuditSource.USER,
        previousValue: { availableDays: 10 },
        newValue: { availableDays: 7 },
        metadata: { requestId: 'req-1', days: 3 },
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'Balance',
          entityId: 'bal-1',
          action: AuditAction.BALANCE_DEBIT,
          actorId: 'emp_001',
          source: AuditSource.USER,
          previousValue: JSON.stringify({ availableDays: 10 }),
          newValue: JSON.stringify({ availableDays: 7 }),
          metadata: JSON.stringify({ requestId: 'req-1', days: 3 }),
        }),
      );
      expect(repo.save).toHaveBeenCalledWith(entry);
    });

    it('serializes null values correctly', async () => {
      const entry = {} as AuditLog;
      (repo.create as jest.Mock).mockReturnValue(entry);
      (repo.save as jest.Mock).mockResolvedValue(entry);

      await service.log({
        entityType: 'TimeOffRequest',
        action: AuditAction.REQUEST_CREATED,
        source: AuditSource.USER,
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          previousValue: null,
          newValue: null,
          metadata: null,
          actorId: null,
          entityId: null,
        }),
      );
    });

    it('saves even when optional fields are omitted', async () => {
      (repo.create as jest.Mock).mockReturnValue({});
      (repo.save as jest.Mock).mockResolvedValue({});

      await expect(
        service.log({
          entityType: 'Balance',
          action: AuditAction.BALANCE_SYNC,
          source: AuditSource.HCM,
        }),
      ).resolves.not.toThrow();
    });
  });
});