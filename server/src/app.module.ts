import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { appConfig, configValidationSchema } from './config/config';
import { DatabaseModule } from './database/database.module';
import { BalanceModule } from './modules/balance/balance.module';
import { TimeOffRequestModule } from './modules/time-off-request/time-off-request.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { AuditModule } from './modules/audit/audit.module';
import { HcmSyncModule } from './modules/hcm-sync/hcm-sync.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      validationSchema: configValidationSchema,
      validationOptions: { allowUnknown: true },
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuditModule,
    BalanceModule,
    HcmSyncModule,
    TimeOffRequestModule,
    OutboxModule,
    HealthModule,
  ],
})
export class AppModule {}