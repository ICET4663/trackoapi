import { IsOptional, IsString, MinLength } from 'class-validator';

export class DeleteAccountDto {
  @IsString()
  @MinLength(6)
  password!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
