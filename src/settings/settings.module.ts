import { Module } from '@nestjs/common';
import { RequestUserModule } from '../common/request-user.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [RequestUserModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
