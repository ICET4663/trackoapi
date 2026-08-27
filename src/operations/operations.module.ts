import { Module } from '@nestjs/common';
import { RequestUserModule } from '../common/request-user.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';

@Module({
  imports: [PrismaModule, RequestUserModule, NotificationsModule, ShipmentsModule],
  controllers: [OperationsController],
  providers: [OperationsService],
})
export class OperationsModule {}
