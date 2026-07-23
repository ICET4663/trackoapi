import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class TypingStatusDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsBoolean()
  isTyping!: boolean;
}
