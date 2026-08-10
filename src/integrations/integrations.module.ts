import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RequestUserModule } from '../common/request-user.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { IntegrationsController } from './integrations.controller';
import { KycProviderService } from './kyc-provider.service';
import { MapsProviderService } from './maps-provider.service';
import { PaymentProviderService } from './payment-provider.service';

@Module({
  imports: [ConfigModule, PrismaModule, NotificationsModule, RequestUserModule],
  controllers: [IntegrationsController],
  providers: [KycProviderService, MapsProviderService, PaymentProviderService],
})
export class IntegrationsModule {}
