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

  // Conversations are scoped to their two participants (customerId/driverId on the
  // Conversation row) - listConversations only returns the caller's own threads, and
  // listMessages/sendMessage assert the caller is one of the two participants (or ops
  // staff) before allowing access. Legacy threads created before scoping existed
  // (customerId/driverId both null) stay reachable by anyone, unchanged.
  @Get('conversations')
  async listConversations(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.communicationService.listConversations(user);
  }

  // Gets (or lazily creates) the single conversation thread for a shipment, scoped to
  // its customer and assigned driver. This is the real entry point for "message the
  // driver/customer about this shipment" - the client never invents a conversation id.
  @Post('shipments/:shipmentId/conversation')
  async getShipmentConversation(@Param('shipmentId') shipmentId: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.communicationService.getOrCreateShipmentConversation(shipmentId, user);
  }

  @Get('conversations/:conversationId/messages')
  async listMessages(@Param('conversationId') conversationId: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.communicationService.listMessages(conversationId, user);
  }

  @Post('conversations/:conversationId/messages')
  async sendMessage(
    @Param('conversationId') conversationId: string,
    @Body() dto: SendMessageDto,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.communicationService.sendMessage(conversationId, user.sub, dto, user);
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
