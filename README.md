# Time-Off Microservice — ReadyOn Platform

A production-grade backend system for managing employee time-off requests and synchronizing balances with an external HCM system (Workday/SAP).

**102 tests passing across 3 layers — unit, E2E, and integration.**

---

## Repository Structure

```
/
├── hcm/          ← Mock HCM server (Express + TypeScript) — simulates Workday/SAP
├── server/       ← Time-Off Microservice (NestJS + TypeScript + SQLite)
├── TRD.md        ← Technical Requirements Document (RFC-level)
└── README.md     ← This file
```

---

## Prerequisites

- **Node.js** v18 or higher (v22 recommended)
- **npm** v9 or higher
- No C++ build tools required — uses `sql.js` (pure JS SQLite)

---

## Installation & Setup

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/time-off-microservice.git
cd time-off-microservice
```

### 2. Set up the HCM Mock Server

```bash
cd hcm
cp .env.example .env
npm install
```

### 3. Set up the NestJS Server

```bash
cd ../server
cp .env.example .env
npm install
```

> **Important:** The `WEBHOOK_SECRET` in `server/.env` must match `HCM_WEBHOOK_SECRET` in `hcm/.env`. Both `.env.example` files have matching defaults — if you change one, change the other.

---

## Running the Project

You need **two terminals** running simultaneously.

### Terminal 1 — HCM Mock Server

```bash
cd hcm
npm run dev
```

Expected output:
```
🏢  HCM Mock Server running on http://localhost:4000
📦  Store initialized with 12 balance records
⚡  Error rate: 0%
🐌  Latency: 50ms–300ms
```

### Terminal 2 — Time-Off Microservice

```bash
cd server
npm run start:dev
```

Expected output:
```
🚀  Time-Off Microservice running on http://localhost:3000
📖  Swagger docs at http://localhost:3000/api/docs
```

---

## Verify Everything Works

```bash
# Health check — NestJS (should show circuitBreaker: CLOSED)
curl http://localhost:3000/health

# Health check — HCM Mock
curl http://localhost:4000/health

# Get balance for a seed employee
curl http://localhost:3000/balances/emp_001/loc_NY

# Open Swagger UI in browser
open http://localhost:3000/api/docs
```

---

## Running Tests

### All Tests (recommended)

Run these from two separate terminals or sequentially:

```bash
# HCM Mock tests (28 tests)
cd hcm
npm test

# NestJS unit tests (51 tests)
cd server
npm test

# NestJS E2E tests (23 tests) — no external servers needed
cd server
npm run test:e2e
```

### Coverage Report

```bash
cd server
npm run test:coverage
# Opens coverage/index.html
```

### Test Summary

| Package | Tests | Description |
|---|---|---|
| `hcm/` | 28 ✅ | Route validation, chaos controls, HMAC signing |
| `server/` unit | 51 ✅ | Optimistic lock, outbox, conflict resolution, lifecycle |
| `server/` E2E | 23 ✅ | Full API flows, HMAC security, pagination |
| **Total** | **102 ✅** | |

> E2E tests use an in-memory SQLite database — **no servers need to be running** to execute them.

---

## Quick API Tour

### Create a time-off request

```bash
curl -X POST http://localhost:3000/time-off/requests \
  -H "Content-Type: application/json" \
  -d '{
    "employeeId": "emp_001",
    "locationId": "loc_NY",
    "leaveTypeId": "vacation",
    "startDate": "2025-08-10",
    "endDate": "2025-08-14",
    "notes": "Summer vacation",
    "idempotencyKey": "550e8400-e29b-41d4-a716-446655440001"
  }'
```

### Approve the request (replace REQUEST_ID)

```bash
curl -X PATCH http://localhost:3000/time-off/requests/REQUEST_ID/approve \
  -H "Content-Type: application/json" \
  -d '{ "managerId": "mgr_001" }'
```

### Simulate a work anniversary bonus (HCM → NestJS webhook)

```bash
curl -X POST http://localhost:4000/admin/trigger-anniversary \
  -H "Content-Type: application/json" \
  -d '{ "employeeId": "emp_001", "locationId": "loc_NY", "bonusDays": 3 }'
# Fires a signed HMAC webhook to NestJS automatically
```

### Simulate HCM chaos (test circuit breaker)

```bash
# Set 100% error rate on HCM
curl -X POST http://localhost:4000/admin/set-error-rate \
  -H "Content-Type: application/json" \
  -d '{ "percent": 100 }'

# NestJS now falls back to local cache
curl http://localhost:3000/balances/emp_001/loc_NY
# Response includes: "balanceSource": "cache", "circuitBreakerState": "OPEN"

# Restore HCM
curl -X POST http://localhost:4000/admin/set-error-rate \
  -H "Content-Type: application/json" \
  -d '{ "percent": 0 }'
```

---

## Documentation

- **[TRD.md](./TRD.md)** — Full Technical Requirements Document with architecture diagrams, ADRs, alternatives considered, SLA targets, and test strategy
- **[server/README.md](./server/README.md)** — NestJS server documentation with engineering highlights, environment variables, and API reference
- **[http://localhost:3000/api/docs](http://localhost:3000/api/docs)** — Live Swagger UI (when server is running)

---

## CI/CD

GitHub Actions runs all 102 tests automatically on every push to `main`.

See [`.github/workflows/ci.yml`](.github/workflows/ci.yml) for the pipeline configuration.