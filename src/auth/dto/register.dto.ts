import { IsEmail, IsEnum, IsObject, IsOptional, IsPhoneNumber, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsPhoneNumber('NG')
  phone!: string;

  @IsString()
  @Length(2, 120, { message: 'Full name must be 2 to 120 characters.' })
  fullName!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  @IsEnum(UserRole)
  role!: UserRole;

  // Role-specific details gathered across the multi-step signup (account type,
  // truck info, identity references, address). Free-form: only the fields the
  // backend recognises are persisted (see UsersService.create), the rest are
  // accepted-and-ignored rather than 400-ing an otherwise valid registration.
  @IsOptional()
  @IsObject()
  profile?: Record<string, unknown>;
}
