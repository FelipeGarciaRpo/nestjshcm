import { IsString, IsNotEmpty, IsNumber, IsEnum, IsDateString, IsArray, ValidateNested, IsUUID, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export enum WebhookEventType {
  BALANCE_CREDIT     = 'BALANCE_CREDIT',
  BALANCE_REFRESH    = 'BALANCE_REFRESH',
  BALANCE_ADJUSTMENT = 'BALANCE_ADJUSTMENT',
  BALANCE_DEBIT      = 'BALANCE_DEBIT',
}

export class HcmWebhookDto {
  @IsUUID()
  hcmEventId!: string;

  @IsEnum(WebhookEventType)
  eventType!: WebhookEventType;

  @IsString() @IsNotEmpty()
  employeeId!: string;

  @IsString() @IsNotEmpty()
  locationId!: string;

  @IsString() @IsNotEmpty()
  leaveTypeId!: string;

  @IsNumber() @Min(0)
  newBalance!: number;

  @IsNumber()
  previousBalance!: number;

  @IsString()
  reason!: string;

  @IsDateString()
  effectiveDate!: string;
}

export class BatchRecordDto {
  @ApiProperty()
  @IsString() @IsNotEmpty()
  employeeId!: string;

  @ApiProperty()
  @IsString() @IsNotEmpty()
  locationId!: string;

  @ApiProperty()
  @IsString() @IsNotEmpty()
  leaveTypeId!: string;

  @ApiProperty()
  @IsNumber() @Min(0)
  balance!: number;

  @ApiProperty()
  @IsNumber() @Min(0)
  usedDays!: number;
}

export class HcmBatchSyncDto {
  @IsString() @IsNotEmpty()
  batchId!: string;

  @IsDateString()
  generatedAt!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchRecordDto)
  records!: BatchRecordDto[];
}