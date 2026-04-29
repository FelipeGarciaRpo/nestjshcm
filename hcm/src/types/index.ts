// ─── Domain Types ─────────────────────────────────────────────────────────────

export type LeaveTypeId = 'vacation' | 'sick' | 'personal' | 'maternity' | string;
export type LocationId = string;
export type EmployeeId = string;

export interface BalanceRecord {
  employeeId: EmployeeId;
  locationId: LocationId;
  leaveTypeId: LeaveTypeId;
  availableDays: number;
  usedDays: number;
  lastUpdated: string;
  updatedBy: string;
  idempotencyKey?: string;
}

export type BalanceStore = Map<string, BalanceRecord>;

// ─── Webhook Types ────────────────────────────────────────────────────────────

export type WebhookEventType =
  | 'BALANCE_CREDIT'
  | 'BALANCE_REFRESH'
  | 'BALANCE_ADJUSTMENT'
  | 'BALANCE_DEBIT';

export interface WebhookPayload {
  hcmEventId: string;
  eventType: WebhookEventType;
  employeeId: EmployeeId;
  locationId: LocationId;
  leaveTypeId: LeaveTypeId;
  newBalance: number;
  previousBalance: number;
  reason: string;
  effectiveDate: string;
}

// ─── API Request/Response Types ───────────────────────────────────────────────

export interface UpdateBalanceBody {
  newBalance: number;
  reason?: string;
  idempotencyKey?: string;
}

export interface TriggerAnniversaryBody {
  employeeId: EmployeeId;
  locationId: LocationId;
  bonusDays?: number;
}

export interface TriggerYearRefreshBody {
  defaultVacationDays?: number;
  defaultSickDays?: number;
  defaultPersonalDays?: number;
}

export interface AdjustBalanceBody {
  employeeId: EmployeeId;
  locationId: LocationId;
  leaveTypeId: LeaveTypeId;
  newBalance: number;
  reason?: string;
}

export interface SetErrorRateBody {
  percent: number;
}

export interface SetLatencyBody {
  minMs?: number;
  maxMs?: number;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

export interface WebhookDispatchResult {
  success: boolean;
  error?: string;
}

export interface HcmConfig {
  port: number;
  webhookSecret: string;
  readyonWebhookUrl: string;
  latencyMinMs: number;
  latencyMaxMs: number;
  errorRatePercent: number;
}