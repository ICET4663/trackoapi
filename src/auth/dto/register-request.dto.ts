import { IsEmail, IsEnum, IsPhoneNumber } from 'class-validator';
import { UserRole } from '@prisma/client';

export class RegisterRequestDto {
  @IsEmail()
  email!: string;

  @IsPhoneNumber('NG')
  phone!: string;

  @IsEnum(UserRole)
  role!: UserRole;
}
