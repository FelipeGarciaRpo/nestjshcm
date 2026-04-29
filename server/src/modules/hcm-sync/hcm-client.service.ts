import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import CircuitBreaker from 'opossum';

export interface HcmBalanceRecord {
  employeeId: string;
  locationId: string;
  leaveTypeId: string;
  availableDays: number;
  usedDays: number;
}

export interface HcmBalanceResponse {
  employeeId: string;
  locationId: string;
  balances: HcmBalanceRecord[];
  retrievedAt: string;
  fromCache?: boolean;
}

@Injectable()
export class HcmClientService {
  private readonly logger = new Logger(HcmClientService.name);
  private readonly http: AxiosInstance;
  private readonly breaker: CircuitBreaker;

  // Track circuit breaker state for /health endpoint
  circuitBreakerState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  constructor(private readonly config: ConfigService) {
    const baseURL = config.get<string>('app.hcmBaseUrl') ?? 'http://localhost:4000';

    this.http = axios.create({ baseURL, timeout: 10_000 });

    // Circuit breaker wraps the actual HTTP call
    // Opens after 5 failures in a 10s window, recovers after 30s
    this.breaker = new CircuitBreaker(this.fetchBalanceFromHcm.bind(this), {
      timeout: 10_000,
      errorThresholdPercentage: 50,
      resetTimeout: 30_000,
      volumeThreshold: 5,
    });

    this.breaker.on('open', () => {
      this.circuitBreakerState = 'OPEN';
      this.logger.warn('[CircuitBreaker] OPEN — HCM is unavailable, using cache fallback');
    });

    this.breaker.on('halfOpen', () => {
      this.circuitBreakerState = 'HALF_OPEN';
      this.logger.log('[CircuitBreaker] HALF_OPEN — probing HCM recovery');
    });

    this.breaker.on('close', () => {
      this.circuitBreakerState = 'CLOSED';
      this.logger.log('[CircuitBreaker] CLOSED — HCM recovered');
    });
  }

  /**
   * Get balance from HCM with circuit breaker protection.
   * Returns null if circuit is open (caller should fall back to cache).
   */
  async getBalance(employeeId: string, locationId: string): Promise<HcmBalanceResponse | null> {
    try {
      const result = await this.breaker.fire(employeeId, locationId) as HcmBalanceResponse;
      return result;
    } catch (err: any) {
      if (err.message?.includes('Breaker is open')) {
        this.logger.warn(`[CircuitBreaker] Short-circuited for ${employeeId}/${locationId}`);
        return null; // caller falls back to local cache
      }
      this.logger.error(`[HCM] getBalance failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Update a balance in HCM. Called by the Outbox worker.
   * Returns true on success, false on failure (worker will retry).
   */
  async updateBalance(
    employeeId: string,
    locationId: string,
    leaveTypeId: string,
    newBalance: number,
    reason: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    try {
      await this.http.post(
        `/balances/${employeeId}/${locationId}/${leaveTypeId}`,
        { newBalance, reason, idempotencyKey },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      );
      return true;
    } catch (err: any) {
      this.logger.error(`[HCM] updateBalance failed: ${err.message}`);
      return false;
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async fetchBalanceFromHcm(
    employeeId: string,
    locationId: string,
  ): Promise<HcmBalanceResponse> {
    const res = await this.http.get<HcmBalanceResponse>(
      `/balances/${employeeId}/${locationId}`,
    );
    return res.data;
  }
}