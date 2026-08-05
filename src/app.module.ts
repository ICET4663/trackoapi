import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { CommunicationModule } from './communication/communication.module';
import { DeploymentConfigModule } from './config/deployment-config.module';
import { DataModule } from './data/data.module';
import { DemoBootstrapController } from './demo-bootstrap.controller';
import { DemoReadinessController } from './demo-readiness.controller';
import { HealthController } from './health.controller';
import { IntegrationsModule } from './integrations/integrations.module';
import { KycModule } from './kyc/kyc.module';
import { LegalModule } from './legal/legal.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OperationsModule } from './operations/operations.module';
import { PortalModule } from './portal/portal.module';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsModule } from './settings/settings.module';
import { ShipmentsModule } from './shipments/shipments.module';
import { TrackingModule } from './tracking/tracking.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DeploymentConfigModule,
    PrismaModule,
    UsersModule,
    AuthModule,
    LegalModule,
    PortalModule,
    SettingsModule,
    KycModule,
    IntegrationsModule,
    DataModule,
    ShipmentsModule,
    NotificationsModule,
    OperationsModule,
    TrackingModule,
    CommunicationModule,
  ],
  controllers: [HealthController, DemoReadinessController, DemoBootstrapController],
})
export class AppModule {}
