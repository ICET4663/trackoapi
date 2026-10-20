import { Module } from '@nestjs/common';
import { RequestUserModule } from '../common/request-user.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { ShipmentEscalationsController } from './shipment-escalations.controller';
import { ShipmentEscalationsService } from './shipment-escalations.service';
import { ShipmentNotesController } from './shipment-notes.controller';
import { ShipmentNotesService } from './shipment-notes.service';

@Module({
  imports: [PrismaModule, RequestUserModule, NotificationsModule, ShipmentsModule],
  controllers: [OperationsController, ShipmentNotesController, ShipmentEscalationsController],
  providers: [OperationsService, ShipmentNotesService, ShipmentEscalationsService],
})
export class OperationsModule {}

