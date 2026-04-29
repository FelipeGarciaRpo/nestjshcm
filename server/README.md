# Time-Off Microservice

A production-grade backend system for managing employee time-off requests, maintaining balance integrity, and synchronizing with an external HCM system (Workday/SAP).

Built with **NestJS + TypeScript + SQLite (sql.js)** as part of the ReadyOn platform.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Running Tests](#running-tests)
- [Key Design Decisions](#key-design-decisions)
- [Technical Requirements Document](#technical-requirements-document)

---

## Architecture Overview

```
root/
├── hcm/        ← Mock HCM server (Express + TypeScript) — simulates Workday/SAP
└── server/     ← Time-Off Microservice (NestJS + TypeScript + SQLite)
```

The system solves the core challenge of **keeping balances synchronized between two systems** — ReadyOn and an external HCM — while guaranteeing:

- **No double-spending** via optimistic locking (`@VersionColumn`)
- **Guaranteed HCM delivery** via the Outbox Pattern
- **Graceful HCM degradation** via Circuit Breaker (opossum)
- **Conflict resolution** when HCM sends batch updates while local changes are pending

---

## Project Structure

```
server/
├── src/
│   ├── modules/
│   │   ├── balance/          # Local balance cache + mutations
│   │   ├── time-off-request/ # Request lifecycle (PENDING → APPROVED/REJECTED/CANCELLED)
│   │   ├── outbox/           # Guaranteed HCM delivery worker (runs every 5s)
│   │   ├── audit/            # Immutable audit log of every balance mutation
│   │   ├── hcm-sync/         # HCM client (circuit breaker) + webhook/batch endpoints
│   │   └── health/           # /health endpoint
│   ├── config/               # Joi-validated environment config
│   ├── database/             # TypeORM + sql.js setup
│   └── common/filters/       # Global exception filter (normalized error responses)
└── test/
    ├── app.e2e-spec.ts        # E2E tests (23 tests)
    └── jest-e2e.json

hcm/
├── src/
│   ├── routes/
│   │   ├── balances.ts        # GET/POST/DELETE balance API
│   │   └── admin.ts           # Trigger anniversary, year refresh, chaos controls
│   ├── middleware/
│   │   ├── latency.ts         # Simulated HCM latency (configurable)
│   │   └── errorRate.ts       # Chaos error injection (configurable)
│   └── utils/hmac.ts          # HMAC-SHA256 signing for webhooks
└── __tests__/hcm.test.js      # 28 tests
```

---

## Prerequisites

- **Node.js** v18+ (v22 recommended)
- **npm** v9+
- **Git**

> No native build tools required. The project uses `sql.js` (pure JavaScript SQLite) instead of `better-sqlite3` to avoid C++ compilation on Windows.

---

## Quick Start

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd <repo-name>
```

### 2. Set up the HCM Mock Server

```bash
cd hcm
cp .env.example .env
npm install
npm run dev
# HCM Mock running on http://localhost:4000
```

### 3. Set up the NestJS Server

Open a new terminal:

```bash
cd server
cp .env.example .env
npm install
npm run start:dev
# Time-Off Microservice running on http://localhost:3000
# Swagger docs at http://localhost:3000/api/docs
```

### 4. Verify both servers are running

```bash
# Health check — NestJS
curl http://localhost:3000/health

# Health check — HCM Mock
curl http://localhost:4000/health
```

---

## Environment Variables

### `server/.env`

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | NestJS server port |
| `NODE_ENV` | `development` | Environment (`development`, `production`, `test`) |
| `DATABASE_PATH` | `./timeoff.sqlite` | SQLite file path (`memory` for in-memory) |
| `WEBHOOK_SECRET` | *(required)* | Shared HMAC secret with HCM for webhook verification |
| `HCM_BASE_URL` | `http://localhost:4000` | HCM Mock server base URL |
| `OUTBOX_POLL_INTERVAL_MS` | `5000` | How often the outbox worker polls for pending events |
| `OUTBOX_MAX_RETRIES` | `5` | Max retry attempts before marking an outbox event as FAILED |
| `BALANCE_CACHE_TTL_SECONDS` | `300` | Max cache age before triggering async HCM re-sync |
| `WEBHOOK_MAX_AGE_SECONDS` | `300` | Max webhook age — rejects replay attacks older than this |

### `hcm/.env`

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HCM Mock server port |
| `HCM_WEBHOOK_SECRET` | *(required)* | Must match `WEBHOOK_SECRET` in server |
| `READYON_WEBHOOK_URL` | `http://localhost:3000/hcm/webhook` | Where HCM pushes balance change events |
| `LATENCY_MIN_MS` | `50` | Minimum simulated response latency |
| `LATENCY_MAX_MS` | `300` | Maximum simulated response latency |
| `ERROR_RATE_PERCENT` | `0` | % of requests that fail with 500 (chaos testing) |

> **Important:** `WEBHOOK_SECRET` in `server/.env` must match `HCM_WEBHOOK_SECRET` in `hcm/.env`.

---

## API Reference

Full interactive documentation available at **http://localhost:3000/api/docs** (Swagger UI).

### Balance Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/balances/:employeeId/:locationId` | Get all leave balances for an employee |
| `POST` | `/balances/sync/:employeeId/:locationId` | Force re-sync balance from HCM |

### Time-Off Request Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/time-off/requests` | Create a new time-off request |
| `GET` | `/time-off/requests` | List requests (filter by `employeeId`, `status`, `locationId`, etc.) |
| `GET` | `/time-off/requests/:id` | Get a specific request |
| `PATCH` | `/time-off/requests/:id/approve` | Manager approves a pending request |
| `PATCH` | `/time-off/requests/:id/reject` | Manager rejects a pending request |
| `PATCH` | `/time-off/requests/:id/cancel` | Employee cancels their own request |

### HCM Sync Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/hcm/webhook` | Receive HCM-initiated balance change (requires `x-hcm-signature`) |
| `POST` | `/hcm/batch-sync` | Receive full balance corpus from HCM (requires `x-hcm-signature`) |

### Observability

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Service health, circuit breaker state, outbox queue depth |

### Example: Create a Time-Off Request

```bash
curl -X POST http://localhost:3000/time-off/requests \
  -H "Content-Type: application/json" \
  -d '{
    "employeeId": "emp_001",
    "locationId": "loc_NY",
    "leaveTypeId": "vacation",
    "startDate": "2025-06-10",
    "endDate": "2025-06-13",
    "notes": "Family trip",
    "idempotencyKey": "550e8400-e29b-41d4-a716-446655440001"
  }'
```

### Example: Trigger Work Anniversary Bonus (HCM Event)

```bash
curl -X POST http://localhost:4000/admin/trigger-anniversary \
  -H "Content-Type: application/json" \
  -d '{
    "employeeId": "emp_001",
    "locationId": "loc_NY",
    "bonusDays": 3
  }'
# This fires a signed webhook to NestJS automatically
```

---

## Running Tests

### Unit Tests (NestJS server)

```bash
cd server
npm test
# 51 tests across 4 suites
```

### E2E Tests (NestJS server)

```bash
cd server
npm run test:e2e
# 23 tests — runs against in-memory SQLite, no external services required
```

### Coverage Report

```bash
cd server
npm run test:coverage
# Generates ./coverage/index.html
```

### HCM Mock Tests

```bash
cd hcm
npm test
# 28 tests
```

### Run All Tests

```bash
# From root
cd hcm && npm test
cd ../server && npm test && npm run test:e2e
```

**Total: 102 tests across both packages.**

---

## Key Design Decisions

### Optimistic Locking (Race Condition Prevention)

The `Balance` entity uses TypeORM's `@VersionColumn()`. Every update includes an implicit `WHERE version = :current` check. If two managers approve requests for the same employee simultaneously, exactly one will succeed — the other gets a `409 Conflict` and can retry.

### Outbox Pattern (Guaranteed HCM Delivery)

When a request is approved, the balance deduction and an outbox event are written **in the same database transaction**. A background worker polls every 5 seconds and delivers pending events to the HCM. This guarantees delivery even if the server crashes between the approval and the HCM call.

### Circuit Breaker (HCM Resilience)

All HCM calls are wrapped with `opossum`. After 5 consecutive failures, the circuit opens and calls short-circuit immediately — falling back to the local cached balance. The circuit auto-recovers after 30 seconds.

### Conflict Resolution (Batch Sync Safety)

When the HCM sends a batch update, the service checks for pending outbox events (approved but not yet synced). If found, it applies:

```
resolvedBalance = hcmBalance - sum(pendingDeductions)
```

This prevents the batch from overwriting locally-approved deductions that haven't been sent to HCM yet.

### HMAC Webhook Verification

All inbound HCM webhooks require an `x-hcm-signature` header containing an HMAC-SHA256 digest of the payload. Uses `crypto.timingSafeEqual` to prevent timing attacks.

---

## Engineering Highlights

Beyond the baseline requirements, this implementation includes several production-grade patterns worth calling out explicitly:

### Optimistic Locking — Race Condition Prevention
The `Balance` entity uses TypeORM's `@VersionColumn()`. Every deduction runs a conditional `WHERE version = :current` — if two approvals hit the same balance simultaneously, exactly one succeeds. The other receives `409 Conflict` and can retry. No row locks, no serialization bottleneck.

### Outbox Pattern — Guaranteed HCM Delivery
Balance deductions and their corresponding HCM sync events are written **in the same SQLite transaction**. A background worker delivers pending events with exponential backoff. If the server crashes between approval and HCM call, the event survives and is retried on restart. This is the standard solution to the dual-write problem in distributed systems.

### Conflict Resolution — Safe Batch Sync
When HCM sends a batch update, the service checks for locally-approved requests not yet confirmed by HCM. Instead of blindly overwriting, it applies:
```
resolvedBalance = hcmBalance - sum(pendingDeductions)
```
This prevents a nightly HCM refresh from silently cancelling locally-approved time off.

### Circuit Breaker — HCM Resilience
All outbound HCM calls are wrapped with `opossum`. After 5 consecutive failures, the circuit opens and calls short-circuit to the local cache immediately — no thread starvation, no cascading timeouts. The circuit auto-recovers after 30 seconds.

### HMAC Webhook Security
Inbound HCM webhooks are verified with HMAC-SHA256 using `crypto.timingSafeEqual` (constant-time comparison to prevent timing attacks). Replay attacks are mitigated by `hcmEventId` deduplication.

### Immutable Audit Log
Every balance mutation — from any source (user, HCM webhook, batch sync) — is recorded in an insert-only `audit_logs` table with `previousValue`, `newValue`, `actorId`, and `source`. No deletes, no updates. Full traceability.

### Idempotent API
Every write endpoint accepts an `idempotencyKey`. Duplicate submissions within 24h return the original response without re-processing. The same key is forwarded to HCM on outbox delivery to prevent double-debiting.

### Three-Layer Balance Validation
Requests are validated at three points: (1) local cache check on submission, (2) HCM realtime check on submission, (3) optimistic lock re-check at approval time. If HCM is unavailable at submission, the request is flagged `needsVerification` and re-validated before approval.

### Chaos-Ready Mock HCM
The HCM mock server exposes admin endpoints to dynamically adjust simulated latency (`/admin/set-latency`) and error rate (`/admin/set-error-rate`) at runtime — enabling circuit breaker and retry logic to be tested without code changes.

### 102 Tests Across 3 Layers
- **28 HCM mock tests** — route validation, chaos controls, HMAC signing
- **51 NestJS unit tests** — optimistic lock failures, conflict resolution, retry exhaustion, idempotency
- **23 E2E tests** — full request lifecycle, HMAC rejection, batch processing, pagination

---

## Technical Requirements Document

See [`TRD.md`](./TRD.md) for the full Technical Requirements Document including:

- Problem statement and failure mode analysis
- Architecture diagrams and sequence flows
- Alternatives considered with trade-off analysis
- Architecture Decision Records (ADRs)
- Test strategy and coverage requirements
- SLA targets and observability plan