import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DeploymentConfigService } from './deployment-config.service';

@Module({
  imports: [ConfigModule],
  providers: [DeploymentConfigService],
  exports: [DeploymentConfigService],
})
export class DeploymentConfigModule {}
