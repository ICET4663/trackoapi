import { Module } from '@nestjs/common';
import { RequestUserModule } from '../common/request-user.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DataController } from './data.controller';
import { DataService } from './data.service';

@Module({
  imports: [PrismaModule, RequestUserModule],
  controllers: [DataController],
  providers: [DataService],
})
export class DataModule {}
