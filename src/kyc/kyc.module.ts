import { Module } from '@nestjs/common';
import { RequestUserModule } from '../common/request-user.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';

@Module({
  imports: [RequestUserModule, IntegrationsModule],
  controllers: [KycController],
  providers: [KycService],
})
export class KycModule {}
