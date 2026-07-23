import { IsOptional, IsString, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

export class LoginDto {
  @IsString()
  identifier!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsOptional()
  role?: UserRole;
}
