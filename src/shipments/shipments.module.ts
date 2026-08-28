import { Module } from '@nestjs/common';
import { RequestUserModule } from '../common/request-user.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CronController } from './cron.controller';
import { ShipmentsController } from './shipments.controller';
import { ShipmentsService } from './shipments.service';

@Module({
  imports: [PrismaModule, RequestUserModule, NotificationsModule, IntegrationsModule],
  controllers: [ShipmentsController, CronController],
  providers: [ShipmentsService],
  exports: [ShipmentsService],
})
export class ShipmentsModule {}
