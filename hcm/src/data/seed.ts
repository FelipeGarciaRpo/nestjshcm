import { BalanceRecord, BalanceStore } from '../types';

export const LEAVE_TYPES = {
  VACATION: 'vacation',
  SICK: 'sick',
  PERSONAL: 'personal',
  MATERNITY: 'maternity',
} as const;

export const LOCATIONS = {
  NY: 'loc_NY',
  LA: 'loc_LA',
  MIA: 'loc_MIA',
  CHI: 'loc_CHI',
} as const;

export function buildKey(employeeId: string, locationId: string, leaveTypeId: string): string {
  return `${employeeId}:${locationId}:${leaveTypeId}`;
}

export function buildInitialStore(): BalanceStore {
  const store: BalanceStore = new Map();

  const entries: Omit<BalanceRecord, 'lastUpdated' | 'updatedBy'>[] = [
    // emp_001 — New York — full balances
    { employeeId: 'emp_001', locationId: LOCATIONS.NY, leaveTypeId: LEAVE_TYPES.VACATION, availableDays: 15, usedDays: 0 },
    { employeeId: 'emp_001', locationId: LOCATIONS.NY, leaveTypeId: LEAVE_TYPES.SICK,     availableDays: 10, usedDays: 0 },
    { employeeId: 'emp_001', locationId: LOCATIONS.NY, leaveTypeId: LEAVE_TYPES.PERSONAL, availableDays: 3,  usedDays: 0 },

    // emp_002 — Los Angeles — low balance (for insufficient funds tests)
    { employeeId: 'emp_002', locationId: LOCATIONS.LA, leaveTypeId: LEAVE_TYPES.VACATION, availableDays: 2,  usedDays: 8  },
    { employeeId: 'emp_002', locationId: LOCATIONS.LA, leaveTypeId: LEAVE_TYPES.SICK,     availableDays: 5,  usedDays: 5  },
    { employeeId: 'emp_002', locationId: LOCATIONS.LA, leaveTypeId: LEAVE_TYPES.PERSONAL, availableDays: 1,  usedDays: 2  },

    // emp_003 — Miami
    { employeeId: 'emp_003', locationId: LOCATIONS.MIA, leaveTypeId: LEAVE_TYPES.VACATION, availableDays: 10, usedDays: 5 },
    { employeeId: 'emp_003', locationId: LOCATIONS.MIA, leaveTypeId: LEAVE_TYPES.SICK,     availableDays: 10, usedDays: 0 },

    // emp_004 — Chicago (concurrency tests — exactly 5 days)
    { employeeId: 'emp_004', locationId: LOCATIONS.CHI, leaveTypeId: LEAVE_TYPES.VACATION, availableDays: 5,  usedDays: 0 },
    { employeeId: 'emp_004', locationId: LOCATIONS.CHI, leaveTypeId: LEAVE_TYPES.SICK,     availableDays: 10, usedDays: 0 },

    // emp_005 — New York (webhook tests)
    { employeeId: 'emp_005', locationId: LOCATIONS.NY, leaveTypeId: LEAVE_TYPES.VACATION, availableDays: 8,  usedDays: 2 },
    { employeeId: 'emp_005', locationId: LOCATIONS.NY, leaveTypeId: LEAVE_TYPES.SICK,     availableDays: 10, usedDays: 0 },
  ];

  for (const entry of entries) {
    const key = buildKey(entry.employeeId, entry.locationId, entry.leaveTypeId);
    store.set(key, {
      ...entry,
      lastUpdated: new Date().toISOString(),
      updatedBy: 'SEED',
    });
  }

  return store;
}