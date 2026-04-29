import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum AuditSource {
  USER   = 'USER',
  HCM    = 'HCM',
  SYSTEM = 'SYSTEM',
}

export enum AuditAction {
  BALANCE_DEBIT        = 'BALANCE_DEBIT',
  BALANCE_CREDIT       = 'BALANCE_CREDIT',
  BALANCE_SYNC         = 'BALANCE_SYNC',
  REQUEST_CREATED      = 'REQUEST_CREATED',
  REQUEST_APPROVED     = 'REQUEST_APPROVED',
  REQUEST_REJECTED     = 'REQUEST_REJECTED',
  REQUEST_CANCELLED    = 'REQUEST_CANCELLED',
  WEBHOOK_RECEIVED     = 'WEBHOOK_RECEIVED',
  BATCH_SYNC_RECEIVED  = 'BATCH_SYNC_RECEIVED',
  CONFLICT_RESOLVED    = 'CONFLICT_RESOLVED',
}

/**
 * Immutable audit log. This table is NEVER updated or deleted.
 * Every balance mutation and request lifecycle event is recorded here.
 */
@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'entity_type' })
  entityType!: string;

  @Column({ name: 'entity_id', nullable: true })
  entityId!: string | null;

  @Column({ type: 'varchar' })
  action!: AuditAction;

  /** Who triggered the action (employeeId, managerId, or 'system') */
  @Column({ name: 'actor_id', nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar' })
  source!: AuditSource;

  /** Snapshot of the value before the change (JSON string) */
  @Column({ name: 'previous_value', nullable: true, type: 'text' })
  previousValue!: string | null;

  /** Snapshot of the value after the change (JSON string) */
  @Column({ name: 'new_value', nullable: true, type: 'text' })
  newValue!: string | null;

  /** Extra context: reason, batchId, hcmEventId, etc. */
  @Column({ nullable: true, type: 'text' })
  metadata!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}