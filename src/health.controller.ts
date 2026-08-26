import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators/public.decorator';
import { DeploymentConfigService } from './config/deployment-config.service';

@Controller('health')
export class HealthController {
  constructor(private readonly deploymentConfig: DeploymentConfigService) {}

  @Get()
  @Public()
  check() {
    const readiness = this.deploymentConfig.summary();
    return {
      ok: true,
      service: 'tracko-api',
      deployable: readiness.deployable,
      required: readiness.required,
      integrations: readiness.integrations,
      timestamp: new Date().toISOString(),
    };
  }
}
