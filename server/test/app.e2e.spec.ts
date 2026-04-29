import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import * as crypto from 'crypto';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';

const WEBHOOK_SECRET = 'test-secret-e2e';
 
function signPayload(payload: object): string {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(payload)).digest('hex');
}
 
function futureDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}
 
function uuid(): string {
  return crypto.randomUUID();
}
 
describe('Time-Off Microservice (E2E)', () => {
  let app: INestApplication;
 
  beforeAll(async () => {
    process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.HCM_BASE_URL = 'http://localhost:4000';
    process.env.DATABASE_PATH = 'memory';
    process.env.NODE_ENV = 'test';
 
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
 
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }));
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  }, 30000);
 
  afterAll(async () => {
    await app.close();
  });
 
  describe('GET /health', () => {
    it('returns 200 with service metadata', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('time-off-microservice');
      expect(res.body).toHaveProperty('hcm');
      expect(res.body).toHaveProperty('outbox');
    });
  });
 
  describe('POST /time-off/requests — validation', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/time-off/requests').send({ employeeId: 'emp_001' });
      expect(res.status).toBe(400);
    });
 
    it('returns 400 when startDate is in the past', async () => {
      const res = await request(app.getHttpServer())
        .post('/time-off/requests')
        .send({ employeeId: 'emp_001', locationId: 'loc_NY', leaveTypeId: 'vacation', startDate: '2020-01-01', endDate: '2020-01-05' });
      expect(res.status).toBe(400);
    });
 
    it('returns 400 when endDate is before startDate', async () => {
      const res = await request(app.getHttpServer())
        .post('/time-off/requests')
        .send({ employeeId: 'emp_001', locationId: 'loc_NY', leaveTypeId: 'vacation', startDate: futureDate(10), endDate: futureDate(5) });
      expect(res.status).toBe(400);
    });
 
    it('returns 400 with unknown extra fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/time-off/requests')
        .send({ employeeId: 'emp_001', locationId: 'loc_NY', leaveTypeId: 'vacation', startDate: futureDate(7), endDate: futureDate(9), hackerField: 'injection' });
      expect(res.status).toBe(400);
    });
  });
 
  describe('Full request lifecycle', () => {
    let pendingRequestId: string;
    const idempotencyKey = uuid();
 
    it('creates a PENDING request', async () => {
      const res = await request(app.getHttpServer())
        .post('/time-off/requests')
        .send({ employeeId: 'emp_lifecycle_001', locationId: 'loc_NY', leaveTypeId: 'vacation', startDate: futureDate(7), endDate: futureDate(9), notes: 'E2E test', idempotencyKey });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('PENDING');
      pendingRequestId = res.body.id;
    });
 
    it('idempotent: same key returns same request', async () => {
      const res = await request(app.getHttpServer())
        .post('/time-off/requests')
        .send({ employeeId: 'emp_lifecycle_001', locationId: 'loc_NY', leaveTypeId: 'vacation', startDate: futureDate(7), endDate: futureDate(9), idempotencyKey });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe(pendingRequestId);
    });
 
    it('GET /time-off/requests/:id retrieves the request', async () => {
      const res = await request(app.getHttpServer()).get(`/time-off/requests/${pendingRequestId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(pendingRequestId);
    });
 
    it('GET /time-off/requests lists with filter', async () => {
      const res = await request(app.getHttpServer()).get('/time-off/requests?employeeId=emp_lifecycle_001');
      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThan(0);
    });
 
    it('rejects the request', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/time-off/requests/${pendingRequestId}/reject`)
        .send({ managerId: 'mgr_001', reason: 'E2E rejection' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('REJECTED');
    });
 
    it('cannot approve a rejected request — returns 409', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/time-off/requests/${pendingRequestId}/approve`)
        .send({ managerId: 'mgr_001' });
      expect(res.status).toBe(409);
    });
  });
 
  describe('Cancel flow', () => {
    let cancelRequestId: string;
 
    it('creates a request to cancel', async () => {
      const res = await request(app.getHttpServer())
        .post('/time-off/requests')
        .send({ employeeId: 'emp_cancel_001', locationId: 'loc_NY', leaveTypeId: 'vacation', startDate: futureDate(14), endDate: futureDate(16), idempotencyKey: uuid() });
      expect(res.status).toBe(201);
      cancelRequestId = res.body.id;
    });
 
    it('cancels a PENDING request', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/time-off/requests/${cancelRequestId}/cancel`)
        .send({ actorId: 'emp_cancel_001' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
    });
 
    it('cannot cancel an already cancelled request — returns 409', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/time-off/requests/${cancelRequestId}/cancel`)
        .send({ actorId: 'emp_cancel_001' });
      expect(res.status).toBe(409);
    });
  });
 
  describe('Error response format', () => {
    it('404 has correct structure with requestId and timestamp', async () => {
      const res = await request(app.getHttpServer())
        .get('/time-off/requests/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('statusCode', 404);
      expect(res.body).toHaveProperty('message');
      expect(res.body).toHaveProperty('requestId');
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).toHaveProperty('path');
    });
  });
 
  describe('POST /hcm/webhook — HMAC security', () => {
    const validPayload = {
      hcmEventId: '550e8400-e29b-41d4-a716-446655440000',
      eventType: 'BALANCE_REFRESH',
      employeeId: 'emp_001', locationId: 'loc_NY', leaveTypeId: 'vacation',
      newBalance: 15, previousBalance: 10,
      reason: 'year_start_refresh',
      effectiveDate: new Date().toISOString(),
    };
 
    it('returns 401 when signature header is missing', async () => {
      const res = await request(app.getHttpServer()).post('/hcm/webhook').send(validPayload);
      expect(res.status).toBe(401);
    });
 
    it('returns 401 when signature is invalid', async () => {
      const res = await request(app.getHttpServer())
        .post('/hcm/webhook').set('x-hcm-signature', 'deadbeef').send(validPayload);
      expect(res.status).toBe(401);
    });
 
    it('returns 200 when signature is valid', async () => {
      const signature = signPayload(validPayload);
      const res = await request(app.getHttpServer())
        .post('/hcm/webhook').set('x-hcm-signature', signature).send(validPayload);
      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });
  });
 
  describe('POST /hcm/batch-sync', () => {
    it('returns 401 with invalid HMAC', async () => {
      const res = await request(app.getHttpServer())
        .post('/hcm/batch-sync').set('x-hcm-signature', 'bad')
        .send({ batchId: 'b1', generatedAt: new Date().toISOString(), records: [] });
      expect(res.status).toBe(401);
    });
 
    it('returns 202 Accepted with valid HMAC', async () => {
      const payload = {
        batchId: uuid(),
        generatedAt: new Date().toISOString(),
        records: [
          { employeeId: 'emp_batch_001', locationId: 'loc_NY', leaveTypeId: 'vacation', balance: 12, usedDays: 3 },
          { employeeId: 'emp_batch_002', locationId: 'loc_LA', leaveTypeId: 'sick', balance: 8, usedDays: 2 },
        ],
      };
      const res = await request(app.getHttpServer())
        .post('/hcm/batch-sync').set('x-hcm-signature', signPayload(payload)).send(payload);
      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(true);
      expect(res.body.recordCount).toBe(2);
    });
  });
 
  describe('GET /balances', () => {
    it('returns 200 with correct shape', async () => {
      const res = await request(app.getHttpServer()).get('/balances/emp_001/loc_NY');
      expect(res.status).toBe(200);
      expect(res.body.employeeId).toBe('emp_001');
      expect(res.body).toHaveProperty('balanceSource');
    });
 
    it('POST /balances/sync force sync returns 200', async () => {
      const res = await request(app.getHttpServer()).post('/balances/sync/emp_001/loc_NY');
      expect(res.status).toBe(200);
      expect(res.body.synced).toBe(true);
    });
  });
 
  describe('Pagination', () => {
    beforeAll(async () => {
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post('/time-off/requests')
          .send({ employeeId: 'emp_page_test', locationId: 'loc_NY', leaveTypeId: 'vacation', startDate: futureDate(30 + i * 5), endDate: futureDate(32 + i * 5), idempotencyKey: uuid() });
      }
    }, 15000);
 
    it('respects limit param', async () => {
      const res = await request(app.getHttpServer())
        .get('/time-off/requests?employeeId=emp_page_test&limit=2&page=1');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      expect(res.body).toHaveProperty('total');
    });
  });
});
 
