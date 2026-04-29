import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';
import { OutboxModule } from '../outbox/outbox.module';
 
@Module({
  imports: [HcmSyncModule, OutboxModule],
  controllers: [HealthController],
})
export class HealthModule {}