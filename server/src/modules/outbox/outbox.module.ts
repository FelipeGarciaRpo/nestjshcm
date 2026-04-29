import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OutboxWorker } from './outbox.worker';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';

@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent]), HcmSyncModule],
  providers: [OutboxWorker],
  exports: [OutboxWorker],
})
export class OutboxModule {}