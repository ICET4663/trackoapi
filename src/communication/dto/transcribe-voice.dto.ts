import { IsNumber, IsOptional, IsString } from 'class-validator';

export class TranscribeVoiceDto {
  @IsOptional()
  @IsString()
  localUri?: string;

  @IsNumber()
  durationSeconds!: number;

  // Real audio content, base64-encoded - a bare localUri is a path on the caller's own
  // device that the server can never read. Server-side transcription (Google
  // Speech-to-Text, when configured) needs this to do anything real.
  @IsOptional()
  @IsString()
  base64?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  // ISO 639-1 code (en/ha/yo/ig) - the caller's own preferred language, used to narrow
  // Google's language guess rather than forcing a single language.
  @IsOptional()
  @IsString()
  languageHint?: string;
}
