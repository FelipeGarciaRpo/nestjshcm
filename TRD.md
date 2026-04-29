# TRD: Time-Off Microservice
**Document version:** 1.0.0  
**Status:** Approved  
**Author:** Felipe Pipe  
**Last updated:** 2025  
**Reviewers:** Engineering Lead, Platform Team, HCM Integration Team

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Goals & Non-Goals](#3-goals--non-goals)
4. [Background & Context](#4-background--context)
5. [Architecture Overview](#5-architecture-overview)
6. [Core Challenges & Proposed Solutions](#6-core-challenges--proposed-solutions)
7. [Data Model](#7-data-model)
8. [API Contract](#8-api-contract)
9. [HCM Integration Design](#9-hcm-integration-design)
10. [Sync Strategies](#10-sync-strategies)
11. [Error Handling & Defensive Design](#11-error-handling--defensive-design)
12. [Security Considerations](#12-security-considerations)
13. [Observability & Health](#13-observability--health)
14. [Test Strategy](#14-test-strategy)
15. [Alternatives Considered](#15-alternatives-considered)
16. [Architecture Decision Records (ADRs)](#16-architecture-decision-records-adrs)
17. [Open Questions & Future Work](#17-open-questions--future-work)

---

## 1. Executive Summary

This document describes the design and implementation of the **Time-Off Microservice** — a backend system responsible for managing the complete lifecycle of employee time-off requests while maintaining **eventual consistency** with an external Human Capital Management (HCM) system (e.g., Workday, SAP).

The core tension this service resolves is: **ReadyOn is not the source of truth for balances, but must behave as if it were** — delivering instant feedback to users while guaranteeing that no request is approved against an invalid or insufficient balance, even when the HCM is temporarily unavailable or inconsistent.

The proposed solution is a **local balance cache + dual-write + optimistic locking + outbox pattern** architecture that guarantees correctness under concurrent load, network failures, and asynchronous HCM updates.

---

## 2. Problem Statement

### 2.1 Current State

ReadyOn operates alongside an HCM system where:

- The HCM is the **canonical source of truth** for employee leave balances.
- ReadyOn allows employees to **submit time-off requests** and managers to **approve or reject** them.
- Balances must be **debited in the HCM** when a request is approved.
- The HCM can **modify balances independently** (e.g., work anniversary bonus, start-of-year refresh, manual HR adjustments).

### 2.2 The Problem

Keeping balances synchronized between two systems creates the following failure modes:

| Failure Mode | Description | Impact |
|---|---|---|
| **Double spend** | Two concurrent requests approved against the same balance | Employee gets more time off than entitled |
| **Stale cache** | Local balance not reflecting an HCM-side bonus | Employee sees incorrect available balance |
| **HCM timeout** | Approval blocked indefinitely waiting for HCM response | Bad UX, failed transactions |
| **HCM silent failure** | HCM accepts a request but doesn't debit the balance | Data inconsistency |
| **Batch conflict** | Batch sync overwrites a locally-applied balance change | Lost transactions |

### 2.3 Why This Is Hard

The fundamental challenge is the **CAP theorem applied to two-system synchronization**: we cannot simultaneously guarantee consistency (exact HCM balance), availability (instant response to users), and partition tolerance (work when HCM is down). This design explicitly chooses **availability + eventual consistency** with strict idempotency and conflict resolution guarantees.

---

## 3. Goals & Non-Goals

### 3.1 Goals

- ✅ Manage the full lifecycle of a time-off request (draft → pending → approved/rejected → cancelled).
- ✅ Maintain a local balance cache per `(employeeId, locationId)` pair.
- ✅ Sync balances with HCM via **realtime API** (per-employee) and **batch endpoint** (full corpus).
- ✅ Handle HCM-initiated balance changes (webhooks, batch) without losing local pending state.
- ✅ Prevent double-spending via **optimistic locking**.
- ✅ Guarantee exactly-once delivery to HCM via **Outbox Pattern**.
- ✅ Be defensive about HCM errors — validate locally before trusting the HCM response.
- ✅ Provide a full **audit trail** of every balance mutation.
- ✅ Expose a **circuit breaker** for HCM calls to prevent cascading failures.

### 3.2 Non-Goals

- ❌ This service does not manage employee authentication or authorization (assumed to be handled by an API Gateway / Auth service upstream).
- ❌ This service does not calculate accrual logic (e.g., how many days an employee earns per month).
- ❌ This service does not send email/push notifications (handled by a Notification service).
- ❌ This service does not manage leave types or company policies (managed by a Policy service).

---

## 4. Background & Context

### 4.1 System Landscape

```
┌─────────────────────────────────────────────────────────────┐
│                      ReadyOn Platform                        │
│                                                              │
│  ┌──────────────┐      ┌─────────────────────────────────┐  │
│  │  Frontend    │─────▶│   Time-Off Microservice (THIS)  │  │
│  │  (Employee/  │      │         NestJS + SQLite          │  │
│  │   Manager)   │      └─────────────────┬───────────────┘  │
│  └──────────────┘                        │                   │
│                                          │                   │
│  ┌──────────────┐                        │                   │
│  │  Auth        │                        │                   │
│  │  Service     │                        │                   │
│  └──────────────┘                        │                   │
└──────────────────────────────────────────┼──────────────────┘
                                           │ REST / Webhook
                                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  HCM System (Workday / SAP)                  │
│                                                              │
│  GET  /balances/:employeeId/:locationId   (realtime)         │
│  POST /balances/:employeeId/:locationId   (realtime write)   │
│  POST /batch-sync                         (batch ingest)     │
│  POST /webhook  ──────────────────────────▶ (our endpoint)  │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Balance Dimensions

A balance in this system is always scoped to:

```
Balance = f(employeeId, locationId, leaveTypeId)
```

Each balance represents the number of **days available** for a given employee at a given location for a given leave type (vacation, sick leave, personal, etc.).

---

## 5. Architecture Overview

### 5.1 Module Structure

```
src/
├── modules/
│   ├── balance/              # Local balance cache + mutations
│   ├── time-off-request/     # Request lifecycle management
│   ├── hcm-sync/             # HCM integration (realtime + batch)
│   ├── outbox/               # Guaranteed event delivery to HCM
│   ├── audit/                # Immutable audit log
│   └── health/               # /health + /metrics endpoints
├── common/
│   ├── filters/              # Global exception filters
│   ├── guards/               # Auth guards
│   ├── interceptors/         # Logging, timeout interceptors
│   └── circuit-breaker/      # Circuit breaker for HCM calls
├── config/                   # Environment config validation
└── database/                 # TypeORM + SQLite setup, migrations
```

### 5.2 Request Approval Flow (Happy Path)

```
Employee                  Time-Off Service              HCM
   │                             │                       │
   │── POST /time-off/request ──▶│                       │
   │                             │ 1. Validate locally   │
   │                             │    (check local cache)│
   │                             │                       │
   │                             │── GET /balances ─────▶│
   │                             │◀─ { balance: 10 } ────│
   │                             │                       │
   │                             │ 2. Optimistic lock    │
   │                             │    (version check)    │
   │                             │                       │
   │◀── 201 Created (PENDING) ───│                       │
   │                             │                       │
Manager── PATCH /approve ───────▶│                       │
   │                             │ 3. Debit local cache  │
   │                             │ 4. Write to Outbox    │
   │                             │                       │
   │◀── 200 OK (APPROVED) ───────│                       │
   │                             │                       │
   │                    [Outbox Worker]                   │
   │                             │── POST /balances ────▶│
   │                             │◀─ 200 OK ─────────────│
   │                             │ 5. Mark Outbox SENT   │
```

### 5.3 HCM-Initiated Balance Change Flow (Webhook)

```
HCM                       Time-Off Service
 │                               │
 │── POST /hcm/webhook ─────────▶│
 │   { employeeId, locationId,   │
 │     newBalance, reason }      │
 │                               │ 1. Verify HMAC signature
 │                               │ 2. Check for pending requests
 │                               │    on this (employee, location)
 │                               │ 3. Apply conflict resolution:
 │                               │    - If pending: defer update
 │                               │      or cancel pending
 │                               │    - If no pending: update cache
 │                               │ 4. Write to Audit Log
 │◀── 200 OK ────────────────────│
```

---

## 6. Core Challenges & Proposed Solutions

### Challenge 1: Race Condition on Balance Deduction

**Problem:** Two managers approve two different requests for the same employee simultaneously. Both read balance = 5. Both deduct 3 days. Employee ends up with -1 days.

**Solution: Optimistic Locking with version column**

The `Balance` entity has a `version` integer column. Every update uses a `WHERE version = :currentVersion` clause. If another transaction has already modified the row, the update affects 0 rows → the transaction retries or fails with a `409 Conflict`.

```sql
UPDATE balances
SET available_days = available_days - 3,
    version = version + 1
WHERE employee_id = 'emp_123'
  AND location_id = 'loc_NY'
  AND version = 7          -- ← optimistic lock check
  AND available_days >= 3; -- ← defensive balance check
```

This is **lockless** (no `SELECT FOR UPDATE`) and scales horizontally.

---

### Challenge 2: Guaranteed Delivery to HCM (Outbox Pattern)

**Problem:** We approve a request, debit the local balance, but then crash before calling the HCM API. The local balance is 7, but HCM still shows 10. Inconsistency.

**Solution: Transactional Outbox Pattern**

When approving a request, we write the balance deduction AND an outbox event **in the same database transaction**. A separate background worker reads pending outbox events and calls the HCM API, marking events as `SENT` only after a successful response.

```
[Approval Transaction]  ─────────────────────────────────┐
│                                                         │
│  UPDATE balances SET available_days = 7, version = 8   │
│  INSERT INTO outbox (payload, status) VALUES (...)      │
│                              ↑ ATOMIC                   │
└─────────────────────────────────────────────────────────┘

[Outbox Worker - runs every 5s]
  SELECT * FROM outbox WHERE status = 'PENDING'
  → POST /hcm/balances/:employeeId/:locationId { days: 7 }
  → UPDATE outbox SET status = 'SENT'
```

**Guarantees:** At-least-once delivery. The HCM call must be **idempotent** (we use an idempotency key = `outboxEventId`).

---

### Challenge 3: HCM Unavailability (Circuit Breaker)

**Problem:** The HCM is down. Every request to check balance hangs for 30 seconds, blocking our thread pool and degrading the entire service.

**Solution: Circuit Breaker (opossum library)**

```
States:
  CLOSED → Normal operation, calls pass through
  OPEN   → HCM is failing, calls short-circuit immediately (fallback to local cache)
  HALF_OPEN → Test mode: one call allowed through to probe recovery
```

Configuration:
- Opens after **5 consecutive failures**
- Remains open for **30 seconds**
- Falls back to **local cached balance** with a `x-balance-source: cache` response header so clients know the data may be slightly stale

---

### Challenge 4: Batch Sync Overwriting Pending State

**Problem:** The HCM sends a batch update with `{ employeeId: emp_123, balance: 10 }`. But we have a locally-pending approved request for 3 days that hasn't been written to HCM yet (outbox is delayed). If we blindly apply the batch, we'll overwrite to 10 and then double-credit.

**Solution: Conflict Resolution Strategy**

When receiving a batch or webhook update:

```
1. Check outbox for any PENDING events for this (employeeId, locationId)
2. If PENDING events exist:
   a. Log a conflict warning to the audit log
   b. Calculate the "true" balance:
      trueBalance = hcmBalance - sum(pendingDeductions)
   c. Apply trueBalance to the local cache
   d. Mark the conflicting outbox events as CONFIRMED (HCM already has the base)
3. If no PENDING events:
   a. Apply hcmBalance directly (HCM wins)
```

This ensures we never lose an approved-but-not-yet-synced deduction.

---

### Challenge 5: Defensive Validation (HCM Cannot Be Trusted)

**Problem:** The instructions say "HCM may not always return errors for insufficient balance." We cannot rely solely on HCM to reject bad requests.

**Solution: Three-Layer Validation**

```
Layer 1: DTO validation (class-validator)
  → Ensures request is structurally valid (dates, types, etc.)

Layer 2: Local cache check (before calling HCM)
  → Reject immediately if local cache shows insufficient balance
  → Avoids unnecessary HCM calls

Layer 3: HCM realtime check (during submission)
  → Re-verify with HCM before creating the request
  → If HCM says balance is lower than our cache: update cache, reject request
  → If HCM is unavailable: use local cache + flag request as NEEDS_VERIFICATION

Final gate at approval time:
  → Re-check local cache with optimistic lock before applying deduction
  → If balance insufficient: reject even if it was valid at submission time
```

---

## 7. Data Model

### 7.1 Entity Relationship Diagram

```
┌──────────────────────┐     ┌──────────────────────────────┐
│       Balance        │     │       TimeOffRequest          │
├──────────────────────┤     ├──────────────────────────────┤
│ id (UUID) PK         │     │ id (UUID) PK                 │
│ employeeId           │◀────│ employeeId                   │
│ locationId           │     │ locationId                   │
│ leaveTypeId          │     │ leaveTypeId                  │
│ availableDays        │     │ startDate                    │
│ usedDays             │     │ endDate                      │
│ pendingDays          │     │ totalDays                    │
│ lastHcmSync (date)   │     │ status (enum)                │
│ version (int)        │     │ managerId                    │
│ createdAt            │     │ notes                        │
│ updatedAt            │     │ idempotencyKey               │
└──────────────────────┘     │ needsVerification (bool)     │
                             │ createdAt / updatedAt        │
                             └──────────────────────────────┘

┌──────────────────────┐     ┌──────────────────────────────┐
│    OutboxEvent       │     │        AuditLog              │
├──────────────────────┤     ├──────────────────────────────┤
│ id (UUID) PK         │     │ id (UUID) PK                 │
│ eventType            │     │ entityType                   │
│ payload (JSON)       │     │ entityId                     │
│ status (enum)        │     │ action                       │
│ attempts             │     │ actorId                      │
│ lastAttemptAt        │     │ previousValue (JSON)         │
│ idempotencyKey       │     │ newValue (JSON)              │
│ createdAt            │     │ source (USER/HCM/SYSTEM)     │
└──────────────────────┘     │ createdAt                    │
                             └──────────────────────────────┘
```

### 7.2 Status Enums

**TimeOffRequest.status:**
```
DRAFT → PENDING → APPROVED → CANCELLED
                └──────────▶ REJECTED
```

**OutboxEvent.status:**
```
PENDING → SENT
        └─▶ FAILED (after max retries)
```

### 7.3 Key Constraints

- `Balance`: Unique index on `(employeeId, locationId, leaveTypeId)`
- `TimeOffRequest`: Unique index on `idempotencyKey` (prevents duplicate submissions)
- `OutboxEvent`: Unique index on `idempotencyKey` (prevents duplicate HCM calls)
- `AuditLog`: No deletes, no updates — insert-only table

---

## 8. API Contract

### 8.1 Balance Endpoints

#### `GET /balances/:employeeId/:locationId`
Returns the current balance for an employee at a location.

**Response 200:**
```json
{
  "employeeId": "emp_123",
  "locationId": "loc_NY",
  "leaveTypes": [
    {
      "leaveTypeId": "vacation",
      "availableDays": 8,
      "usedDays": 2,
      "pendingDays": 1,
      "lastHcmSync": "2025-01-15T10:30:00Z"
    }
  ],
  "balanceSource": "cache",
  "cacheAge": "2m30s"
}
```

**Headers returned:**
- `x-balance-source: hcm | cache` — indicates if balance was fetched live or from cache

---

#### `POST /balances/sync/:employeeId/:locationId`
Forces a realtime sync with HCM for a specific employee/location.

**Response 200:**
```json
{
  "synced": true,
  "previousBalance": 8,
  "newBalance": 11,
  "delta": 3,
  "reason": "work_anniversary_bonus"
}
```

---

### 8.2 Time-Off Request Endpoints

#### `POST /time-off/requests`
Creates a new time-off request.

**Request:**
```json
{
  "employeeId": "emp_123",
  "locationId": "loc_NY",
  "leaveTypeId": "vacation",
  "startDate": "2025-03-10",
  "endDate": "2025-03-14",
  "notes": "Family trip",
  "idempotencyKey": "client-generated-uuid"
}
```

**Response 201:**
```json
{
  "id": "req_abc",
  "status": "PENDING",
  "totalDays": 5,
  "balanceAfterApproval": 3,
  "balanceSource": "hcm",
  "createdAt": "2025-01-20T08:00:00Z"
}
```

**Error responses:**
- `400` — Invalid date range or missing fields
- `409` — Duplicate idempotency key (request already submitted)
- `422` — Insufficient balance (with breakdown)
- `503` — HCM unavailable and local cache too stale (configurable threshold)

---

#### `PATCH /time-off/requests/:id/approve`
Manager approves a pending request.

**Headers required:** `X-Manager-Id: mgr_456`

**Response 200:**
```json
{
  "id": "req_abc",
  "status": "APPROVED",
  "newBalance": 3,
  "hcmSyncScheduled": true,
  "approvedAt": "2025-01-20T09:00:00Z"
}
```

**Error responses:**
- `404` — Request not found
- `409` — Version conflict (optimistic lock failed — retry)
- `422` — Insufficient balance at approval time (balance changed since submission)

---

#### `PATCH /time-off/requests/:id/reject`
Manager rejects a pending request.

#### `PATCH /time-off/requests/:id/cancel`
Employee cancels their own request (only if PENDING or APPROVED and within cancellation window).

#### `GET /time-off/requests`
List requests with filters: `employeeId`, `locationId`, `status`, `startDate`, `endDate`, pagination.

---

### 8.3 Sync Endpoints

#### `POST /hcm/webhook`
Receives HCM-initiated balance changes.

**Headers required:**
- `x-hcm-signature: hmac-sha256-hash` — HMAC verification

**Request:**
```json
{
  "eventType": "BALANCE_REFRESH",
  "employeeId": "emp_123",
  "locationId": "loc_NY",
  "leaveTypeId": "vacation",
  "newBalance": 15,
  "reason": "year_start_refresh",
  "effectiveDate": "2025-01-01T00:00:00Z",
  "hcmEventId": "hcm-evt-789"
}
```

---

#### `POST /hcm/batch-sync`
Receives a full batch of balances from HCM.

**Request:**
```json
{
  "batchId": "batch_2025_Q1",
  "generatedAt": "2025-01-20T00:00:00Z",
  "records": [
    {
      "employeeId": "emp_123",
      "locationId": "loc_NY",
      "leaveTypeId": "vacation",
      "balance": 10
    }
  ]
}
```

**Response 202 Accepted** — Batch processed asynchronously. Returns `batchId` for status tracking.

---

### 8.4 Observability Endpoints

#### `GET /health`
```json
{
  "status": "ok",
  "hcm": { "status": "connected", "circuitBreaker": "CLOSED" },
  "database": { "status": "ok" },
  "outboxPending": 3,
  "outboxFailed": 0
}
```

#### `GET /metrics`
Prometheus-compatible metrics: request counts, latency histograms, outbox queue depth, circuit breaker state.

---

## 9. HCM Integration Design

### 9.1 HCM Client Service

The `HcmClientService` wraps all outbound calls with:
- **Timeout:** 10 seconds per call
- **Retry:** Exponential backoff (1s, 2s, 4s) for transient errors (5xx, network timeout)
- **Circuit Breaker:** Opens after 5 failures in 10s window
- **Idempotency Key:** Passed as `Idempotency-Key` header on all write calls

### 9.2 Mock HCM Server

A separate Express.js server (`mock-hcm/`) simulates the HCM with:

| Endpoint | Behavior |
|---|---|
| `GET /balances/:emp/:loc` | Returns stored balance |
| `POST /balances/:emp/:loc` | Updates balance (validates for negative) |
| `POST /batch-sync` | Pushes batch to ReadyOn webhook |
| `POST /webhook/trigger` | Manually trigger a balance change (for testing) |

**Simulated scenarios:**
- Random latency (100ms–2000ms) to simulate slow HCM
- Configurable error rate (5% 500 errors)
- Work anniversary bonus trigger (adds 3 days to a specific employee)
- Year-start batch refresh (resets all balances to configured values)

---

## 10. Sync Strategies

### 10.1 Strategy Comparison

| Strategy | When | Consistency | Latency |
|---|---|---|---|
| Realtime pull | On every balance read | High | High |
| Realtime push | On every approval | High | Medium |
| Webhook (HCM → us) | HCM-initiated events | High | Low |
| Scheduled batch | Every 1h / 24h | Medium | Low |
| On-demand sync | User triggers refresh | High | Medium |

### 10.2 Chosen Strategy: Hybrid

```
1. On read:
   - Serve from local cache
   - If cache is older than CACHE_TTL (default: 5min): async refresh from HCM
   - Return x-balance-source header

2. On write (approval):
   - Deduct locally with optimistic lock
   - Queue outbox event → HCM call guaranteed

3. HCM → ReadyOn:
   - Webhook handler with HMAC verification
   - Conflict resolution for pending deductions

4. Scheduled batch:
   - Every 1h: pull all balances for active employees
   - Apply conflict resolution strategy
```

### 10.3 Cache TTL Configuration

| Scenario | TTL |
|---|---|
| Normal operation | 5 minutes |
| HCM circuit open | Use cache indefinitely, flag as stale |
| Post-approval | Invalidated immediately for that employee |
| Post-webhook | Invalidated immediately for that employee |

---

## 11. Error Handling & Defensive Design

### 11.1 Global Exception Filter

All errors are normalized to:
```json
{
  "statusCode": 422,
  "error": "INSUFFICIENT_BALANCE",
  "message": "Employee emp_123 has 2 available days but requested 5",
  "details": {
    "available": 2,
    "requested": 5,
    "leaveType": "vacation",
    "balanceSource": "hcm"
  },
  "requestId": "req-trace-uuid",
  "timestamp": "2025-01-20T08:00:00Z"
}
```

### 11.2 Idempotency

All write operations accept an `Idempotency-Key` header (or `idempotencyKey` in body). If a request with the same key is received within 24 hours, the original response is returned from cache — no double processing.

### 11.3 Retry Policy for Outbox

| Attempt | Delay |
|---|---|
| 1st | Immediate |
| 2nd | 30 seconds |
| 3rd | 5 minutes |
| 4th | 30 minutes |
| 5th+ | Dead letter + alert |

---

## 12. Security Considerations

| Concern | Mitigation |
|---|---|
| Unauthorized approval | `X-Manager-Id` header validated against employee's manager in auth context |
| Webhook forgery | HMAC-SHA256 signature verification with shared secret |
| SQL injection | TypeORM parameterized queries — no raw SQL |
| Data exposure | Employees can only query their own balances (enforced by middleware) |
| Replay attacks | `hcmEventId` deduplicated — same event ID never processed twice |
| Audit non-repudiation | Audit log is insert-only; no update/delete endpoints exposed |

---

## 13. Observability & Health

### 13.1 Structured Logging

Every request logs:
- `requestId` (trace correlation)
- `employeeId`, `locationId`
- Operation type
- Duration
- HCM call result
- Cache hit/miss

### 13.2 Key Metrics

| Metric | Description |
|---|---|
| `timeoff_requests_total` | Counter by status |
| `hcm_call_duration_ms` | Histogram |
| `hcm_circuit_breaker_state` | Gauge (0=CLOSED, 1=OPEN, 2=HALF_OPEN) |
| `outbox_pending_events` | Gauge |
| `outbox_failed_events` | Gauge |
| `balance_sync_conflicts_total` | Counter |

### 13.3 SLA Targets

| Operation | P50 | P99 | SLA |
|---|---|---|---|
| GET balance (cache hit) | 5ms | 20ms | 99.9% |
| GET balance (HCM call) | 100ms | 800ms | 99.5% |
| POST request | 150ms | 1000ms | 99.5% |
| PATCH approve | 100ms | 500ms | 99.9% |
| Batch sync processing | < 30s for 10k records | — | 99% |

---

## 14. Test Strategy

### 14.1 Philosophy

> "Tests are the executable specification of the system. If a behavior isn't tested, it doesn't exist."

Given the agentic development approach, test rigor is the primary signal of engineering maturity. Tests are written to be **regression guards** — any future change that breaks a tested behavior must fail CI immediately.

### 14.2 Test Pyramid

```
         ┌───────────────────┐
         │    E2E Tests      │  (10%)  Full stack with mock HCM deployed
         │  (supertest)      │         Key user journeys
         ├───────────────────┤
         │ Integration Tests │  (30%)  Module + DB interactions
         │  (in-memory SQLite│         Real TypeORM, mocked HCM HTTP
         ├───────────────────┤
         │   Unit Tests      │  (60%)  Services, guards, utilities
         │   (Jest)          │         Pure logic, all edge cases
         └───────────────────┘
```

### 14.3 Critical Test Cases

#### Balance & Concurrency
- ✅ Concurrent approval of two requests exceeding available balance → exactly one succeeds
- ✅ Balance deduction is atomic and does not go below zero
- ✅ Optimistic lock version mismatch returns 409
- ✅ Balance read returns `x-balance-source: cache` when HCM is unavailable

#### Outbox Pattern
- ✅ Outbox event is created in same transaction as approval
- ✅ If outbox worker fails, event remains PENDING and is retried
- ✅ After max retries, event is marked FAILED and alert fires
- ✅ Duplicate idempotency key → same result returned, no second HCM call

#### HCM Integration
- ✅ Webhook with valid HMAC signature is processed
- ✅ Webhook with invalid HMAC signature returns 401
- ✅ Batch sync with conflicting pending deductions applies correct conflict resolution
- ✅ HCM unavailability → circuit breaker opens → fallback to cache
- ✅ HCM recovery → circuit breaker closes → normal operation resumes
- ✅ HCM returns insufficient balance error → local cache is updated

#### Request Lifecycle
- ✅ Duplicate request submission with same idempotency key → 200 with original response
- ✅ Request with past start date → 400
- ✅ Approve already-approved request → 409
- ✅ Cancel approved request within window → success, balance restored
- ✅ Cancel approved request outside window → 422

#### Audit Log
- ✅ Every balance mutation creates an audit entry
- ✅ Audit log entries are never deleted or updated
- ✅ Source is correctly tagged (USER, HCM, SYSTEM)

### 14.4 Coverage Requirements

| Type | Target |
|---|---|
| Line coverage | ≥ 85% |
| Branch coverage | ≥ 80% |
| Critical paths (approval, sync, outbox) | 100% |

---

## 15. Alternatives Considered

### 15.1 Always Call HCM in Real-Time (No Local Cache)

**Idea:** Never store balance locally; always call HCM on every request.

**Pros:** Always consistent. No sync complexity.

**Cons:** Service is 100% coupled to HCM availability. HCM has SLA of 99.5% → our service becomes unavailable when HCM is. Latency of every operation increases to HCM response time (100ms–2s). **Rejected.**

---

### 15.2 Eventual Consistency Without Optimistic Locking

**Idea:** Accept all requests, sync to HCM, let HCM reject over-balance requests asynchronously, then cancel the approved request.

**Pros:** No race condition complexity. Simple.

**Cons:** User sees approved request, plans accordingly, then gets it cancelled — very bad UX. Manager is notified of approval, then notified of cancellation — erodes trust. **Rejected.**

---

### 15.3 Pessimistic Locking (`SELECT FOR UPDATE`)

**Idea:** Use database-level row locks for balance updates.

**Pros:** Guaranteed consistency, no version conflicts.

**Cons:** SQLite's WAL mode doesn't support `SELECT FOR UPDATE` efficiently. Row locks block concurrent reads. Doesn't scale beyond single instance. **Rejected in favor of optimistic locking.**

---

### 15.4 Event Sourcing for Balance

**Idea:** Store balance as a log of events (credits and debits), derive current balance from the log.

**Pros:** Perfect audit trail. Trivially replayable. No sync conflicts.

**Cons:** Significant complexity increase. Query performance degrades as event log grows. Requires CQRS. Overkill for this bounded context. **Deferred to v2 if needed.**

---

### 15.5 Message Queue (Kafka/RabbitMQ) Instead of Outbox

**Idea:** Publish HCM sync events to a message broker instead of local outbox table.

**Pros:** Battle-tested at scale. Decoupled.

**Cons:** Adds significant infrastructure dependency for a microservice that should be deployable standalone. The Outbox pattern achieves the same guarantees with only SQLite. **Rejected for this scope; revisit if service scales.**

---

## 16. Architecture Decision Records (ADRs)

### ADR-001: SQLite with TypeORM over PostgreSQL
**Status:** Accepted  
**Context:** Assessment requires SQLite. In production, this service would use PostgreSQL.  
**Decision:** Use SQLite with TypeORM in WAL mode for concurrent read performance.  
**Consequences:** Some PostgreSQL-specific features (row locking, native JSON operators) must be emulated. Migration to PostgreSQL requires only TypeORM config change.

---

### ADR-002: NestJS over Express
**Status:** Accepted  
**Context:** Assessment requires NestJS.  
**Decision:** Use NestJS with its module system, DI container, and decorators.  
**Consequences:** Opinionated structure. Excellent testability via `@nestjs/testing`. Built-in support for guards, interceptors, and pipes aligns with our needs.

---

### ADR-003: Outbox Pattern over Direct HCM Call
**Status:** Accepted  
**Context:** We need guaranteed exactly-once delivery to HCM on approval.  
**Decision:** Write outbox event in same transaction as balance deduction; worker delivers asynchronously.  
**Consequences:** HCM sync is eventually consistent (typically < 10s delay). Requires background worker. Enables retry and dead-letter handling without blocking the approval flow.

---

### ADR-004: HMAC-SHA256 for Webhook Verification
**Status:** Accepted  
**Context:** HCM webhooks must be authenticated to prevent spoofed balance updates.  
**Decision:** Verify `x-hcm-signature` header using shared secret.  
**Consequences:** Shared secret must be rotated periodically. Replay attacks mitigated by `hcmEventId` deduplication + timestamp validation (reject events older than 5 minutes).

---

### ADR-005: Optimistic Locking over Database Transactions for Balance
**Status:** Accepted  
**Context:** Balance deductions must be atomic under concurrent load.  
**Decision:** Version column + conditional UPDATE. Retry on conflict.  
**Consequences:** Under very high concurrency (unlikely at this scale), a request may need 2–3 retries. Max retry count (3) prevents starvation. Retry logic is transparent to the API caller.

---

## 17. Open Questions & Future Work

| Question | Notes |
|---|---|
| How should partial-day requests be handled? | Current model assumes whole-day increments. Half-days would require `availableDays` to support decimals. |
| Should cancelled approved requests restore balance in HCM? | Yes — requires a reverse outbox event. Not in v1 scope but architecture supports it. |
| What happens if HCM sends a batch with an employee we don't have locally? | Current: create balance record. Alternative: reject and alert. Needs product decision. |
| Should the audit log be queryable by the employee? | GDPR compliance consideration. |
| What is the maximum batch size we must support? | Affects processing strategy (streaming vs in-memory). Assumed < 100k records for v1. |

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| **HCM** | Human Capital Management system (e.g., Workday, SAP) — source of truth for employment data |
| **Balance** | Number of days available for a given employee, location, and leave type |
| **Outbox Pattern** | Design pattern ensuring database writes and message sends are atomic |
| **Optimistic Locking** | Concurrency control that detects conflicts at write time using a version counter |
| **Circuit Breaker** | Pattern that stops calling a failing service and falls back gracefully |
| **Idempotency Key** | Client-provided unique key ensuring a request is processed exactly once |
| **Soft Delete** | Marking records as deleted without removing them from the database |
| **HMAC** | Hash-based Message Authentication Code — used to verify webhook authenticity |

---

*This document is subject to revision as implementation progresses. All major deviations from this design must be recorded as new ADRs.*