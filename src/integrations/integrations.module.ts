import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { IntegrationsController } from './integrations.controller';
import { KycProviderService } from './kyc-provider.service';
import { PaymentProviderService } from './payment-provider.service';

@Module({
  imports: [ConfigModule, PrismaModule, NotificationsModule],
  controllers: [IntegrationsController],
  providers: [KycProviderService, PaymentProviderService],
})
export class IntegrationsModule {}
