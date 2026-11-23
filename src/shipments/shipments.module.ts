import { Module } from '@nestjs/common';
import { RequestUserModule } from '../common/request-user.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TrackingModule } from '../tracking/tracking.module';
import { CronController } from './cron.controller';
import { DispatchSweepService } from './dispatch-sweep.service';
import { JobBoardController } from './job-board.controller';
import { JobBoardService } from './job-board.service';
import { ShipmentsController } from './shipments.controller';
import { ShipmentsService } from './shipments.service';

@Module({
  imports: [PrismaModule, RequestUserModule, NotificationsModule, IntegrationsModule, TrackingModule],
  controllers: [ShipmentsController, CronController, JobBoardController],
  providers: [ShipmentsService, DispatchSweepService, JobBoardService],
  exports: [ShipmentsService, DispatchSweepService],
})
export class ShipmentsModule {}
