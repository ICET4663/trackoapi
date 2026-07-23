import { IsOptional, IsString } from 'class-validator';

export class RegisterPushTokenDto {
  @IsString()
  token!: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsString()
  deviceId?: string;
}
