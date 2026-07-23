import { IsNumber, IsOptional, IsString } from 'class-validator';

export class TranscribeVoiceDto {
  @IsOptional()
  @IsString()
  localUri?: string;

  @IsNumber()
  durationSeconds!: number;
}
