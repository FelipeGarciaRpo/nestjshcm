import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { TimeOffRequestService } from './time-off-request.service';
import { TimeOffRequestController } from './time-off-request.controller';
import { BalanceModule } from '../balance/balance.module';
import { AuditModule } from '../audit/audit.module';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest]),
    BalanceModule,
    AuditModule,
    HcmSyncModule,
  ],
  controllers: [TimeOffRequestController],
  providers: [TimeOffRequestService],
  exports: [TimeOffRequestService],
})
export class TimeOffRequestModule {}