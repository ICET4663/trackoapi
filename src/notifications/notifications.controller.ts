import { Body, Controller, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { RequestUserService } from '../common/request-user.service';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly requestUser: RequestUserService,
  ) {}

  @Get()
  async list(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.notifications.list(user.sub, user.role);
  }

  @Get('unread-count')
  async unreadCount(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.notifications.unreadCount(user.sub, user.role);
  }

  @Patch(':id/read')
  async markRead(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.notifications.markRead(id, user.sub, user.role);
  }

  @Post('mark-all-read')
  async markAllRead(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.notifications.markAllRead(user.sub, user.role);
  }

  @Post('push-token')
  async registerPushToken(
    @Body() body: { token?: string; platform?: string; deviceId?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.notifications.registerPushToken(user.sub, body.token ?? 'preview-token', body.platform, body.deviceId);
  }
}
