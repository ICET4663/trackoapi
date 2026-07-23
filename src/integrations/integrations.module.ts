import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { IntegrationsController } from './integrations.controller';
import { KycProviderService } from './kyc-provider.service';
import { PaymentProviderService } from './payment-provider.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [IntegrationsController],
  providers: [KycProviderService, PaymentProviderService],
})
export class IntegrationsModule {}
