/**
 * HCM Mock Server — Integration Tests
 * Tests run against the TypeScript server compiled via ts-node-dev.
 * supertest imports the compiled app directly.
 */

// Point to the TypeScript source via ts-node (registered in jest config)
process.env.LATENCY_MIN_MS = '0';
process.env.LATENCY_MAX_MS = '0';
process.env.ERROR_RATE_PERCENT = '0';

const request = require('supertest');

// We require the TS module — ts-node handles transpilation
const { app, startServer } = require('../src/index');

let server;

beforeAll(() => {
  server = startServer(4001);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(async () => {
  await request(app).post('/admin/reset');
});

// ─── Health ────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with server metadata', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.storeSize).toBeGreaterThan(0);
    expect(res.body).toHaveProperty('timestamp');
  });
});

// ─── GET /balances ─────────────────────────────────────────────────────────────

describe('GET /balances/:employeeId/:locationId', () => {
  it('returns all leave types for an employee at a location', async () => {
    const res = await request(app).get('/balances/emp_001/loc_NY');
    expect(res.status).toBe(200);
    expect(res.body.employeeId).toBe('emp_001');
    expect(Array.isArray(res.body.balances)).toBe(true);
    expect(res.body.balances.length).toBeGreaterThanOrEqual(3);
  });

  it('filters by leaveTypeId query param', async () => {
    const res = await request(app).get('/balances/emp_001/loc_NY?leaveTypeId=vacation');
    expect(res.status).toBe(200);
    expect(res.body.balances.every((b) => b.leaveTypeId === 'vacation')).toBe(true);
    expect(res.body.balances.length).toBe(1);
  });

  it('returns 404 for unknown employee', async () => {
    const res = await request(app).get('/balances/emp_GHOST/loc_NY');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('EMPLOYEE_NOT_FOUND');
  });
});

describe('GET /balances/:employeeId/:locationId/:leaveTypeId', () => {
  it('returns the specific balance with correct seed value', async () => {
    const res = await request(app).get('/balances/emp_001/loc_NY/vacation');
    expect(res.status).toBe(200);
    expect(res.body.availableDays).toBe(15);
    expect(res.body.leaveTypeId).toBe('vacation');
  });

  it('returns 404 for unknown leave type', async () => {
    const res = await request(app).get('/balances/emp_001/loc_NY/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('BALANCE_NOT_FOUND');
  });
});

// ─── POST /balances ─────────────────────────────────────────────────────────────

describe('POST /balances/:employeeId/:locationId/:leaveTypeId', () => {
  it('updates a balance and returns previous + new values', async () => {
    const res = await request(app)
      .post('/balances/emp_001/loc_NY/vacation')
      .send({ newBalance: 12, reason: 'time_off_approved' });

    expect(res.status).toBe(200);
    expect(res.body.previousBalance).toBe(15);
    expect(res.body.newBalance).toBe(12);
  });

  it('persists the update — subsequent GET reflects new value', async () => {
    await request(app)
      .post('/balances/emp_001/loc_NY/vacation')
      .send({ newBalance: 7, reason: 'test' });

    const get = await request(app).get('/balances/emp_001/loc_NY/vacation');
    expect(get.body.availableDays).toBe(7);
  });

  it('allows balance to be set to exactly 0', async () => {
    const res = await request(app)
      .post('/balances/emp_001/loc_NY/vacation')
      .send({ newBalance: 0, reason: 'fully_used' });

    expect(res.status).toBe(200);
    expect(res.body.newBalance).toBe(0);
  });

  it('rejects negative balance with 422', async () => {
    const res = await request(app)
      .post('/balances/emp_001/loc_NY/vacation')
      .send({ newBalance: -1 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_BALANCE');
  });

  it('rejects missing newBalance field with 400', async () => {
    const res = await request(app)
      .post('/balances/emp_001/loc_NY/vacation')
      .send({ reason: 'no balance' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_FIELD');
  });

  it('rejects non-numeric newBalance with 400', async () => {
    const res = await request(app)
      .post('/balances/emp_001/loc_NY/vacation')
      .send({ newBalance: 'ten' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_FIELD');
  });

  it('auto-creates a new balance entry with 201', async () => {
    const res = await request(app)
      .post('/balances/emp_NEW/loc_NY/vacation')
      .send({ newBalance: 10, reason: 'onboarding' });

    expect(res.status).toBe(201);
    expect(res.body.newBalance).toBe(10);
    expect(res.body.previousBalance).toBeNull();
  });
});

// ─── Admin: Anniversary ────────────────────────────────────────────────────────

describe('POST /admin/trigger-anniversary', () => {
  it('adds bonus days to vacation balance', async () => {
    const before = await request(app).get('/balances/emp_001/loc_NY/vacation');
    const prev = before.body.availableDays;

    const res = await request(app)
      .post('/admin/trigger-anniversary')
      .send({ employeeId: 'emp_001', locationId: 'loc_NY', bonusDays: 3 });

    expect(res.status).toBe(200);
    expect(res.body.newBalance).toBe(prev + 3);
  });

  it('defaults to 3 bonus days when bonusDays is omitted', async () => {
    const before = await request(app).get('/balances/emp_001/loc_NY/vacation');
    const prev = before.body.availableDays;

    const res = await request(app)
      .post('/admin/trigger-anniversary')
      .send({ employeeId: 'emp_001', locationId: 'loc_NY' });

    expect(res.body.newBalance).toBe(prev + 3);
  });

  it('returns 404 for unknown employee', async () => {
    const res = await request(app)
      .post('/admin/trigger-anniversary')
      .send({ employeeId: 'emp_GHOST', locationId: 'loc_NY' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when employeeId is missing', async () => {
    const res = await request(app)
      .post('/admin/trigger-anniversary')
      .send({ locationId: 'loc_NY' });
    expect(res.status).toBe(400);
  });
});

// ─── Admin: Year Refresh ───────────────────────────────────────────────────────

describe('POST /admin/trigger-year-refresh', () => {
  it('resets all balances to configured defaults', async () => {
    await request(app)
      .post('/balances/emp_001/loc_NY/vacation')
      .send({ newBalance: 3, reason: 'drain_for_test' });

    const res = await request(app)
      .post('/admin/trigger-year-refresh')
      .send({ defaultVacationDays: 15 });

    expect(res.status).toBe(200);
    expect(res.body.recordsUpdated).toBeGreaterThan(0);

    const after = await request(app).get('/balances/emp_001/loc_NY/vacation');
    expect(after.body.availableDays).toBe(15);
  });
});

// ─── Admin: Adjust Balance ─────────────────────────────────────────────────────

describe('POST /admin/adjust-balance', () => {
  it('sets an exact balance', async () => {
    const res = await request(app)
      .post('/admin/adjust-balance')
      .send({ employeeId: 'emp_001', locationId: 'loc_NY', leaveTypeId: 'vacation', newBalance: 20 });

    expect(res.status).toBe(200);
    expect(res.body.newBalance).toBe(20);
  });

  it('rejects negative balance with 400', async () => {
    const res = await request(app)
      .post('/admin/adjust-balance')
      .send({ employeeId: 'emp_001', locationId: 'loc_NY', leaveTypeId: 'vacation', newBalance: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_BALANCE');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/admin/adjust-balance')
      .send({ employeeId: 'emp_001' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_FIELDS');
  });
});

// ─── Admin: Chaos Controls ────────────────────────────────────────────────────

describe('POST /admin/set-error-rate', () => {
  afterEach(async () => {
    await request(app).post('/admin/set-error-rate').send({ percent: 0 });
  });

  it('accepts a valid percentage', async () => {
    const res = await request(app).post('/admin/set-error-rate').send({ percent: 50 });
    expect(res.status).toBe(200);
    expect(res.body.errorRatePercent).toBe(50);
  });

  it('rejects percent > 100', async () => {
    const res = await request(app).post('/admin/set-error-rate').send({ percent: 150 });
    expect(res.status).toBe(400);
  });

  it('rejects negative percent', async () => {
    const res = await request(app).post('/admin/set-error-rate').send({ percent: -1 });
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/set-latency', () => {
  afterEach(async () => {
    await request(app).post('/admin/set-latency').send({ minMs: 0, maxMs: 0 });
  });

  it('sets latency range successfully', async () => {
    const res = await request(app).post('/admin/set-latency').send({ minMs: 100, maxMs: 500 });
    expect(res.status).toBe(200);
    expect(res.body.latencyMinMs).toBe(100);
  });
});

// ─── Admin: Store & Reset ─────────────────────────────────────────────────────

describe('GET /admin/store', () => {
  it('returns the full store as a flat object', async () => {
    const res = await request(app).get('/admin/store');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).length).toBeGreaterThan(0);
  });
});

describe('POST /admin/reset', () => {
  it('restores seed values after manual modification', async () => {
    await request(app).post('/balances/emp_001/loc_NY/vacation').send({ newBalance: 0 });
    await request(app).post('/admin/reset');

    const res = await request(app).get('/balances/emp_001/loc_NY/vacation');
    expect(res.body.availableDays).toBe(15);
  });
});

// ─── Unknown Routes ───────────────────────────────────────────────────────────

describe('Unknown routes', () => {
  it('returns 404 with list of available routes', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(Array.isArray(res.body.availableRoutes)).toBe(true);
  });
});