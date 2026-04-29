import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum TimeOffStatus {
  PENDING   = 'PENDING',
  APPROVED  = 'APPROVED',
  REJECTED  = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'employee_id' })
  employeeId!: string;

  @Column({ name: 'location_id' })
  locationId!: string;

  @Column({ name: 'leave_type_id' })
  leaveTypeId!: string;

  @Column({ name: 'start_date' })
  startDate!: string;

  @Column({ name: 'end_date' })
  endDate!: string;

  @Column({ name: 'total_days', type: 'float' })
  totalDays!: number;

  @Column({
    type: 'varchar',
    default: TimeOffStatus.PENDING,
  })
  status!: TimeOffStatus;

  @Column({ name: 'manager_id', nullable: true })
  managerId!: string | null;

  @Column({ nullable: true, type: 'text' })
  notes!: string | null;

  /**
   * Client-generated idempotency key.
   * Ensures that duplicate submissions return the same response.
   */
  @Index({ unique: true })
  @Column({ name: 'idempotency_key', nullable: true })
  idempotencyKey!: string | null;

  /**
   * Flagged when the HCM was unavailable at submission time.
   * Approval will re-verify balance before proceeding.
   */
  @Column({ name: 'needs_verification', default: false })
  needsVerification!: boolean;

  @Column({ name: 'approved_at', type: 'datetime', nullable: true })
  approvedAt!: Date | null;

  @Column({ name: 'rejected_at', type: 'datetime', nullable: true })
  rejectedAt!: Date | null;

  @Column({ name: 'cancelled_at', type: 'datetime', nullable: true })
  cancelledAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}