import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequestUserService } from '../common/request-user.service';
import { DataCollection, DataService } from './data.service';

@Controller('data')
export class DataController {
  constructor(
    private readonly dataService: DataService,
    private readonly requestUser: RequestUserService,
  ) {}

  @Get(':collection')
  async list(
    @Param('collection') collection: DataCollection,
    @Headers('authorization') authorization?: string,
    @Query('role') role?: UserRole,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, role ?? 'CUSTOMER');
    return this.dataService.list(collection, user.sub);
  }

  @Get(':collection/:id')
  async item(
    @Param('collection') collection: DataCollection,
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Query('role') role?: UserRole,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, role ?? 'CUSTOMER');
    return this.dataService.item(collection, id, user.sub);
  }

  @Post(':collection')
  async create(
    @Param('collection') collection: DataCollection,
    @Body() body: Record<string, unknown>,
    @Headers('authorization') authorization?: string,
    @Query('role') role?: UserRole,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, role ?? 'CUSTOMER');
    return this.dataService.create(collection, body, user.sub);
  }
}
