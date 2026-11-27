import { MessageKind } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DATA_URL_MAX } from '../../common/input-rules';

export class SendMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  senderId?: string;

  @IsEnum(MessageKind)
  kind!: MessageKind;

  @IsOptional()
  @IsString()
  @MaxLength(4000, { message: 'Keep the message under 4,000 characters.' })
  body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(DATA_URL_MAX)
  attachmentUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(DATA_URL_MAX)
  attachmentUri?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  transcript?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  sourceTranscript?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  englishTranscript?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  sourceLanguage?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(3600)
  durationSeconds?: number;
}
