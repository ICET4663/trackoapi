import { IsEmail, IsEnum, IsPhoneNumber, IsString, Length, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsPhoneNumber('NG')
  phone!: string;

  @IsString()
  fullName!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  @IsEnum(UserRole)
  role!: UserRole;
}
