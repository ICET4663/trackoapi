import { MessageKind } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';

export class SendMessageDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  senderId?: string;

  @IsEnum(MessageKind)
  kind!: MessageKind;

  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @IsString()
  attachmentUrl?: string;

  @IsOptional()
  @IsString()
  attachmentUri?: string;

  @IsOptional()
  @IsString()
  transcript?: string;

  @IsOptional()
  @IsString()
  sourceTranscript?: string;

  @IsOptional()
  @IsString()
  englishTranscript?: string;

  @IsOptional()
  @IsString()
  sourceLanguage?: string;

  @IsOptional()
  @IsNumber()
  durationSeconds?: number;
}
