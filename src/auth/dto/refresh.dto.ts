import { IsEnum, IsOptional, IsString } from 'class-validator';
import { UserRole } from '@prisma/client';

export class RefreshDto {
  @IsString()
  refreshToken!: string;

  // The portal the client is signed in to; kept across the refresh when the account has it.
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
