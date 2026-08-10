import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequestUserService } from '../common/request-user.service';
import { CommunicationService } from './communication.service';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { TranscribeVoiceDto } from './dto/transcribe-voice.dto';
import { TypingStatusDto } from './dto/typing-status.dto';

@Controller()
export class CommunicationController {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly requestUser: RequestUserService,
  ) {}

  @Get('conversations')
  listConversations(@Query('role') role: UserRole) {
    return this.communicationService.listConversations(role);
  }

  @Get('conversations/:conversationId/messages')
  listMessages(@Param('conversationId') conversationId: string) {
    return this.communicationService.listMessages(conversationId);
  }

  @Post('conversations/:conversationId/messages')
  sendMessage(@Param('conversationId') conversationId: string, @Body() dto: SendMessageDto) {
    return this.communicationService.sendMessage(conversationId, dto.senderId ?? 'preview-customer', dto);
  }

  @Post('conversations/:conversationId/typing')
  updateTypingStatus(@Param('conversationId') conversationId: string, @Body() dto: TypingStatusDto) {
    return this.communicationService.updateTypingStatus(conversationId, dto.userId ?? 'preview-customer', dto);
  }

  @Post('voice/transcriptions')
  transcribeVoiceNote(@Body() dto: TranscribeVoiceDto) {
    return this.communicationService.transcribeVoiceNote(dto);
  }

  @Post('notifications/push-token')
  registerPushToken(@Body() dto: RegisterPushTokenDto) {
    return this.communicationService.registerPushToken('preview-customer', dto.token, dto.platform, dto.deviceId);
  }

  @Post('media/upload')
  async uploadMedia(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.communicationService.uploadMedia(body, user.sub);
  }

  @Post('media')
  async uploadMediaAlias(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.communicationService.uploadMedia(body, user.sub);
  }
}
