import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { RequestUserService } from '../common/request-user.service';
import { ShipmentEscalationsService } from './shipment-escalations.service';

@Controller('operations')
export class ShipmentEscalationsController {
  constructor(private readonly escalations: ShipmentEscalationsService, private readonly requestUser: RequestUserService) {}

  @Get('escalations')
  async queue(@Query('status') status: string | undefined, @Headers('authorization') authorization?: string) {
    const actor = await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.escalations.queue(status, actor);
  }

  @Post('escalations/:id/resolve')
  async resolve(@Param('id') id: string, @Body() body: { note?: unknown }, @Headers('authorization') authorization?: string) {
    const actor = await this.requestUser.requireRole(authorization, ['ADMIN']);
    return this.escalations.resolve(id, body?.note, actor);
  }

  @Get('shipments/:id/escalations')
  async listForShipment(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const actor = await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.escalations.listForShipment(id, actor);
  }

  @Post('shipments/:id/escalations')
  async raise(@Param('id') id: string, @Body() body: { reason?: unknown }, @Headers('authorization') authorization?: string) {
    const actor = await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.escalations.raise(id, body?.reason, actor);
  }
}
