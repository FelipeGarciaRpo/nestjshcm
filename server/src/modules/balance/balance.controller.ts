import { Controller, Get, Post, Param, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiHeader } from '@nestjs/swagger';
import { BalanceService } from './balance.service';
import { HcmClientService } from '../hcm-sync/hcm-client.service';

@ApiTags('Balances')
@Controller('balances')
export class BalanceController {
  constructor(
    private readonly balanceService: BalanceService,
    private readonly hcmClient: HcmClientService,
  ) {}

  @Get(':employeeId/:locationId')
  @ApiOperation({ summary: 'Get all leave balances for an employee at a location' })
  @ApiParam({ name: 'employeeId', example: 'emp_001' })
  @ApiParam({ name: 'locationId', example: 'loc_NY' })
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    const { balances, fromCache } = await this.balanceService.getBalance(employeeId, locationId);
    return {
      employeeId,
      locationId,
      balances,
      balanceSource: fromCache ? 'cache' : 'hcm',
      circuitBreakerState: this.hcmClient.circuitBreakerState,
    };
  }

  @Post('sync/:employeeId/:locationId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Force re-sync balance from HCM for a specific employee' })
  async forceSync(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    await this.balanceService.syncFromHcm(employeeId, locationId);
    const { balances } = await this.balanceService.getBalance(employeeId, locationId);
    return { synced: true, balances };
  }
}