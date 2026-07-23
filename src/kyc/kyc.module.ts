import { Module } from '@nestjs/common';
import { RequestUserModule } from '../common/request-user.module';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';

@Module({
  imports: [RequestUserModule],
  controllers: [KycController],
  providers: [KycService],
})
export class KycModule {}
