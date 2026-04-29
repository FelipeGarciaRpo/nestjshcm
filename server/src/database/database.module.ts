import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Balance } from '../modules/balance/entities/balance.entity';
import { TimeOffRequest } from '../modules/time-off-request/entities/time-off-request.entity';
import { OutboxEvent } from '../modules/outbox/entities/outbox-event.entity';
import { AuditLog } from '../modules/audit/entities/audit-log.entity';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const dbPath = config.get<string>('app.databasePath') ?? './timeoff.sqlite';
        const isMemory = dbPath === ':memory:' || dbPath === 'memory';

        return {
          type: 'sqljs',
          location: isMemory ? undefined : dbPath,
          autoSave: !isMemory,
          autoSaveCallback: undefined,
          useLocalForage: false,
          entities: [Balance, TimeOffRequest, OutboxEvent, AuditLog],
          synchronize: true,
          logging: false,
        };
      },
    }),
  ],
})
export class DatabaseModule {}