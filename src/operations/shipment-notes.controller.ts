import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { RequestUserService } from '../common/request-user.service';
import { ShipmentNotesService } from './shipment-notes.service';

@Controller('operations/shipments/:id/notes')
export class ShipmentNotesController {
  constructor(private readonly notes: ShipmentNotesService, private readonly requestUser: RequestUserService) {}

  @Get()
  async list(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const actor = await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.notes.list(id, actor);
  }

  @Post()
  async append(@Param('id') id: string, @Body() body: { body?: unknown }, @Headers('authorization') authorization?: string) {
    const actor = await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.notes.append(id, body?.body, actor);
  }
}

