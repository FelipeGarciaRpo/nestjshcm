import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { OutboxWorker } from './outbox.worker';
import { OutboxEvent, OutboxStatus, OutboxEventType } from './entities/outbox-event.entity';
import { HcmClientService } from '../hcm-sync/hcm-client.service';

const mockRepo = () => ({
  find: jest.fn(),
  save: jest.fn(),
  count: jest.fn(),
});

const mockHcmClient = () => ({
  updateBalance: jest.fn(),
  circuitBreakerState: 'CLOSED',
});

const mockConfig = () => ({
  get: jest.fn().mockImplementation((key: string) => {
    if (key === 'app.outboxMaxRetries') return 5;
    return null;
  }),
});

function buildEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: 'outbox-1',
    eventType: OutboxEventType.BALANCE_DEBIT,
    payload: JSON.stringify({
      employeeId: 'emp_001',
      locationId: 'loc_NY',
      leaveTypeId: 'vacation',
      newBalance: 7,
      reason: 'time_off_approved',
    }),
    status: OutboxStatus.PENDING,
    attempts: 0,
    lastAttemptAt: null,
    errorMessage: null,
    idempotencyKey: 'idem-outbox-1',
    requestId: 'req-1',
    createdAt: new Date(),
    ...overrides,
  } as OutboxEvent;
}

describe('OutboxWorker', () => {
  let worker: OutboxWorker;
  let repo: ReturnType<typeof mockRepo>;
  let hcmClient: ReturnType<typeof mockHcmClient>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxWorker,
        { provide: getRepositoryToken(OutboxEvent), useFactory: mockRepo },
        { provide: HcmClientService, useFactory: mockHcmClient },
        { provide: ConfigService, useFactory: mockConfig },
      ],
    }).compile();

    worker = module.get(OutboxWorker);
    repo = module.get(getRepositoryToken(OutboxEvent));
    hcmClient = module.get(HcmClientService);
  });

  it('should be defined', () => {
    expect(worker).toBeDefined();
  });

  // ─── processEvent() ───────────────────────────────────────────────────────

  describe('processEvent()', () => {
    it('marks event as SENT when HCM call succeeds', async () => {
      const event = buildEvent();
      hcmClient.updateBalance.mockResolvedValue(true);
      repo.save.mockResolvedValue({ ...event, status: OutboxStatus.SENT });

      await worker.processEvent(event);

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: OutboxStatus.SENT }),
      );
    });

    it('increments attempts and keeps PENDING when HCM call fails (not max retries)', async () => {
      const event = buildEvent({ attempts: 2 });
      hcmClient.updateBalance.mockResolvedValue(false);
      repo.save.mockResolvedValue(event);

      await worker.processEvent(event);

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: OutboxStatus.PENDING,
          attempts: 3,
        }),
      );
    });

    it('marks event as FAILED after max retries exceeded', async () => {
      const event = buildEvent({ attempts: 4 }); // one more = 5 = max
      hcmClient.updateBalance.mockResolvedValue(false);
      repo.save.mockResolvedValue(event);

      await worker.processEvent(event);

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: OutboxStatus.FAILED,
          errorMessage: expect.stringContaining('max retries'),
        }),
      );
    });

    it('always increments attempts counter regardless of success', async () => {
      const event = buildEvent({ attempts: 0 });
      hcmClient.updateBalance.mockResolvedValue(true);
      repo.save.mockResolvedValue(event);

      await worker.processEvent(event);

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ attempts: 1 }),
      );
    });

    it('calls HCM with correct payload from the event', async () => {
      const event = buildEvent();
      hcmClient.updateBalance.mockResolvedValue(true);
      repo.save.mockResolvedValue(event);

      await worker.processEvent(event);

      expect(hcmClient.updateBalance).toHaveBeenCalledWith(
        'emp_001', 'loc_NY', 'vacation', 7, 'time_off_approved', 'idem-outbox-1',
      );
    });

    it('sets lastAttemptAt timestamp on every attempt', async () => {
      const event = buildEvent({ lastAttemptAt: null });
      hcmClient.updateBalance.mockResolvedValue(true);
      repo.save.mockResolvedValue(event);

      await worker.processEvent(event);

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          lastAttemptAt: expect.any(Date),
        }),
      );
    });
  });

  // ─── processPending() ─────────────────────────────────────────────────────

  describe('processPending()', () => {
    it('processes all pending events in order', async () => {
      const events = [buildEvent({ id: 'e1' }), buildEvent({ id: 'e2' })];
      repo.find.mockResolvedValue(events);
      hcmClient.updateBalance.mockResolvedValue(true);
      repo.save.mockResolvedValue({});

      await worker.processPending();

      expect(hcmClient.updateBalance).toHaveBeenCalledTimes(2);
    });

    it('does nothing when no pending events exist', async () => {
      repo.find.mockResolvedValue([]);

      await worker.processPending();

      expect(hcmClient.updateBalance).not.toHaveBeenCalled();
    });

    it('does not run concurrently — second call is skipped if first is running', async () => {
      let resolveFirst: () => void;
      const firstCallPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });

      repo.find.mockResolvedValueOnce([buildEvent()])
        .mockResolvedValueOnce([buildEvent({ id: 'e2' })]);

      hcmClient.updateBalance.mockImplementation(() => {
        return firstCallPromise.then(() => true);
      });
      repo.save.mockResolvedValue({});

      // Start first run (will block)
      const firstRun = worker.processPending();

      // Second run should skip (isRunning = true)
      await worker.processPending();

      // Now unblock first run
      resolveFirst!();
      await firstRun;

      // HCM should have been called only once (second run was skipped)
      expect(hcmClient.updateBalance).toHaveBeenCalledTimes(1);
    });
  });

  // ─── getStats() ───────────────────────────────────────────────────────────

  describe('getStats()', () => {
    it('returns pending and failed counts', async () => {
      repo.count
        .mockResolvedValueOnce(3)  // PENDING
        .mockResolvedValueOnce(1); // FAILED

      const stats = await worker.getStats();

      expect(stats).toEqual({ pending: 3, failed: 1 });
    });

    it('returns 0 for both when queue is empty', async () => {
      repo.count.mockResolvedValue(0);

      const stats = await worker.getStats();

      expect(stats).toEqual({ pending: 0, failed: 0 });
    });
  });
});