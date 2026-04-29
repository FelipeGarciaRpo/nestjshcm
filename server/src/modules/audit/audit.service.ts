import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog, AuditAction, AuditSource } from './entities/audit-log.entity';

interface LogParams {
  entityType: string;
  entityId?: string;
  action: AuditAction;
  actorId?: string;
  source: AuditSource;
  previousValue?: object | null;
  newValue?: object | null;
  metadata?: object;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
  ) {}

  async log(params: LogParams): Promise<void> {
    const entry = this.repo.create({
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      action: params.action,
      actorId: params.actorId ?? null,
      source: params.source,
      previousValue: params.previousValue ? JSON.stringify(params.previousValue) : null,
      newValue: params.newValue ? JSON.stringify(params.newValue) : null,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    });
    await this.repo.save(entry);
  }
}