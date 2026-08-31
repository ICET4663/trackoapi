import { Module } from '@nestjs/common';
import { RequestUserModule } from '../common/request-user.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CommunicationController } from './communication.controller';
import { CommunicationService } from './communication.service';

@Module({
  imports: [PrismaModule, NotificationsModule, RequestUserModule, IntegrationsModule],
  controllers: [CommunicationController],
  providers: [CommunicationService],
})
export class CommunicationModule {}
