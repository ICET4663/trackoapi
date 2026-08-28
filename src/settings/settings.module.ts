import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RequestUserModule } from '../common/request-user.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [RequestUserModule, NotificationsModule, AuthModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
