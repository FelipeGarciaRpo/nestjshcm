import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum OutboxStatus {
  PENDING = 'PENDING',
  SENT    = 'SENT',
  FAILED  = 'FAILED',
}

export enum OutboxEventType {
  BALANCE_DEBIT  = 'BALANCE_DEBIT',
  BALANCE_CREDIT = 'BALANCE_CREDIT',
}

@Entity('outbox_events')
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  eventType!: OutboxEventType;

  /**
   * JSON payload sent to the HCM API.
   * Contains: employeeId, locationId, leaveTypeId, newBalance.
   */
  @Column({ type: 'text' })
  payload!: string;

  @Column({ type: 'varchar', default: OutboxStatus.PENDING })
  status!: OutboxStatus;

  @Column({ default: 0 })
  attempts!: number;

  @Column({ name: 'last_attempt_at', type: 'datetime', nullable: true })
  lastAttemptAt!: Date | null;

  @Column({ name: 'error_message', nullable: true, type: 'text' })
  errorMessage!: string | null;

  /**
   * Idempotency key passed to HCM on every attempt.
   * Guarantees the HCM processes this event exactly once.
   */
  @Index({ unique: true })
  @Column({ name: 'idempotency_key' })
  idempotencyKey!: string;

  /**
   * Reference to the TimeOffRequest that triggered this event.
   */
  @Column({ name: 'request_id', nullable: true })
  requestId!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}