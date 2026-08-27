import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { RequestUserService } from '../common/request-user.service';
import { DataCollection, DataService } from './data.service';

@Controller('data')
export class DataController {
  constructor(
    private readonly dataService: DataService,
    private readonly requestUser: RequestUserService,
  ) {}

  // The `role` query param is a display hint only (which portal UI is asking) - it is
  // never trusted for authorization. Every permission check uses user.role from the
  // verified JWT, via DataService.list()/item() gating the ops-only collections.
  @Get(':collection')
  async list(
    @Param('collection') collection: DataCollection,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.dataService.list(collection, user.sub, user.role);
  }

  @Get(':collection/:id')
  async item(
    @Param('collection') collection: DataCollection,
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.dataService.item(collection, id, user.sub, user.role);
  }

  @Post(':collection')
  async create(
    @Param('collection') collection: DataCollection,
    @Body() body: Record<string, unknown>,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.dataService.create(collection, body, user.sub);
  }
}
