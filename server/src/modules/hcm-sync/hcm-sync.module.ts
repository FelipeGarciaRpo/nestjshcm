import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HcmClientService } from './hcm-client.service';
import { HcmSyncController } from './hcm-sync.controller';
import { Balance } from '../balance/entities/balance.entity';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity';
import { AuditModule } from '../audit/audit.module';
import { BalanceModule } from '../balance/balance.module';
 
@Module({
  imports: [
    TypeOrmModule.forFeature([Balance, OutboxEvent]),
    AuditModule,
    forwardRef(() => BalanceModule),
  ],
  controllers: [HcmSyncController],
  providers: [HcmClientService],
  exports: [HcmClientService],
})
export class HcmSyncModule {}