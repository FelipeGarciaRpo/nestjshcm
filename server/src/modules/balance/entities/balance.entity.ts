import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  VersionColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('balances')
@Index(['employeeId', 'locationId', 'leaveTypeId'], { unique: true })
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'employee_id' })
  employeeId!: string;

  @Column({ name: 'location_id' })
  locationId!: string;

  @Column({ name: 'leave_type_id' })
  leaveTypeId!: string;

  /**
   * Days available for use. Never goes below 0.
   * Updated via optimistic-locked transactions only.
   */
  @Column({ name: 'available_days', type: 'float', default: 0 })
  availableDays!: number;

  @Column({ name: 'used_days', type: 'float', default: 0 })
  usedDays!: number;

  /**
   * Sum of days in PENDING requests not yet approved.
   * Used for displaying "effective available" to the user.
   */
  @Column({ name: 'pending_days', type: 'float', default: 0 })
  pendingDays!: number;

  /**
   * Timestamp of the last successful sync with HCM.
   * Used to determine if the cache is stale.
   */
  @Column({ name: 'last_hcm_sync', type: 'datetime', nullable: true })
  lastHcmSync!: Date | null;

  /**
   * @VersionColumn — TypeORM automatically increments this on every save().
   * If the version doesn't match at save time, throws OptimisticLockVersionMismatchError.
   * This is our primary defence against concurrent double-spending.
   */
  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}