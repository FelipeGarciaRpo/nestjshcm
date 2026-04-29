import {
  Controller, Get, Post, Patch, Param, Body, Query, HttpCode
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TimeOffRequestService } from './time-off-request.service';
import {
  CreateTimeOffRequestDto,
  ApproveTimeOffRequestDto,
  RejectTimeOffRequestDto,
  ListRequestsQueryDto,
} from './dto/time-off-request.dto';

@ApiTags('Time-Off Requests')
@Controller('time-off/requests')
export class TimeOffRequestController {
  constructor(private readonly service: TimeOffRequestService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new time-off request' })
  create(@Body() dto: CreateTimeOffRequestDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List time-off requests with optional filters' })
  findAll(@Query() query: ListRequestsQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific time-off request by ID' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Manager approves a pending request' })
  approve(@Param('id') id: string, @Body() dto: ApproveTimeOffRequestDto) {
    return this.service.approve(id, dto.managerId);
  }

  @Patch(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Manager rejects a pending request' })
  reject(@Param('id') id: string, @Body() dto: RejectTimeOffRequestDto) {
    return this.service.reject(id, dto.managerId, dto.reason);
  }

  @Patch(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Employee cancels their own request' })
  cancel(@Param('id') id: string, @Body() body: { actorId: string }) {
    return this.service.cancel(id, body.actorId);
  }
}