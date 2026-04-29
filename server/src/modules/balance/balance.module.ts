import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from './entities/balance.entity';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity';
import { BalanceService } from './balance.service';
import { BalanceController } from './balance.controller';
import { AuditModule } from '../audit/audit.module';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Balance, OutboxEvent]),
    AuditModule,
    forwardRef(() => HcmSyncModule),
  ],
  controllers: [BalanceController],
  providers: [BalanceService],
  exports: [BalanceService],
})
export class BalanceModule {}