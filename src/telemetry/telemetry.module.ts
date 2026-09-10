import { Module } from '@nestjs/common';
import { RateLimitService } from '../auth/rate-limit.service';
import { RequestUserModule } from '../common/request-user.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';

@Module({
  imports: [PrismaModule, RequestUserModule],
  controllers: [TelemetryController],
  // RateLimitService is a stateless wrapper over the RateLimitBucket table, so a
  // module-local instance behaves identically to AuthModule's - no need to export it there.
  providers: [TelemetryService, RateLimitService],
})
export class TelemetryModule {}
