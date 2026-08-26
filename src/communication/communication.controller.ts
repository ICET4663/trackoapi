import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
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

  // NOTE: conversations are not yet scoped to participants at the schema level (no
  // customerId/driverId/shipmentId on Conversation), so any authenticated user currently
  // sees every conversation on the platform, not just their own. Deriving the role from
  // the verified token (instead of a client-supplied ?role= query param) at least stops
  // someone from viewing conversations *as* a role they don't hold. Proper per-user
  // scoping needs a schema change - flagged as a follow-up, not fixed here.
  @Get('conversations')
  async listConversations(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.communicationService.listConversations(user.role);
  }

  @Get('conversations/:conversationId/messages')
  async listMessages(@Param('conversationId') conversationId: string, @Headers('authorization') authorization?: string) {
    await this.requestUser.fromAuthorizationHeader(authorization);
    return this.communicationService.listMessages(conversationId);
  }

  @Post('conversations/:conversationId/messages')
  async sendMessage(
    @Param('conversationId') conversationId: string,
    @Body() dto: SendMessageDto,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.communicationService.sendMessage(conversationId, user.sub, dto);
  }

  @Post('conversations/:conversationId/typing')
  async updateTypingStatus(
    @Param('conversationId') conversationId: string,
    @Body() dto: TypingStatusDto,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.communicationService.updateTypingStatus(conversationId, user.sub, dto);
  }

  @Post('voice/transcriptions')
  async transcribeVoiceNote(@Body() dto: TranscribeVoiceDto, @Headers('authorization') authorization?: string) {
    await this.requestUser.fromAuthorizationHeader(authorization);
    return this.communicationService.transcribeVoiceNote(dto);
  }

  @Post('notifications/push-token')
  async registerPushToken(@Body() dto: RegisterPushTokenDto, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.communicationService.registerPushToken(user.sub, dto.token, dto.platform, dto.deviceId);
  }

  @Post('media/upload')
  async uploadMedia(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.communicationService.uploadMedia(body, user.sub);
  }

  @Post('media')
  async uploadMediaAlias(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.communicationService.uploadMedia(body, user.sub);
  }
}
