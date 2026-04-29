import {
  IsString,
  IsNotEmpty,
  IsDateString,
  IsOptional,
  IsNumber,
  Min,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTimeOffRequestDto {
  @ApiProperty({ example: 'emp_001' })
  @IsString()
  @IsNotEmpty()
  employeeId!: string;

  @ApiProperty({ example: 'loc_NY' })
  @IsString()
  @IsNotEmpty()
  locationId!: string;

  @ApiProperty({ example: 'vacation' })
  @IsString()
  @IsNotEmpty()
  leaveTypeId!: string;

  @ApiProperty({ example: '2025-03-10' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ example: '2025-03-14' })
  @IsDateString()
  endDate!: string;

  @ApiPropertyOptional({ example: 'Family trip' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'Client-generated UUID for idempotency' })
  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;
}

export class ApproveTimeOffRequestDto {
  @ApiProperty({ example: 'mgr_456', description: 'ID of the approving manager' })
  @IsString()
  @IsNotEmpty()
  managerId!: string;
}

export class RejectTimeOffRequestDto {
  @ApiProperty({ example: 'mgr_456' })
  @IsString()
  @IsNotEmpty()
  managerId!: string;

  @ApiPropertyOptional({ example: 'Insufficient staffing during that period' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ListRequestsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number;
}