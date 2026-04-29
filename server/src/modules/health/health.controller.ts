import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { HcmClientService } from '../hcm-sync/hcm-client.service';
import { OutboxWorker } from '../outbox/outbox.worker';
 
@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(
    private readonly hcmClient: HcmClientService,
    private readonly outboxWorker: OutboxWorker,
  ) {}
 
  @Get('health')
  @ApiOperation({ summary: 'Service health check' })
  async health() {
    const outboxStats = await this.outboxWorker.getStats();
    return {
      status: 'ok',
      service: 'time-off-microservice',
      hcm: { circuitBreaker: this.hcmClient.circuitBreakerState },
      outbox: outboxStats,
      timestamp: new Date().toISOString(),
    };
  }
}