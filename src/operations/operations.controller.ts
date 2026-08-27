import { Body, Controller, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { ShipmentStatus } from '@prisma/client';
import { RequestUserService } from '../common/request-user.service';
import { OperationsService } from './operations.service';

@Controller('operations')
export class OperationsController {
  constructor(
    private readonly operations: OperationsService,
    private readonly requestUser: RequestUserService,
  ) {}

  @Get('dashboard')
  async dashboard(@Headers('authorization') authorization?: string) {
    await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.operations.dashboard();
  }

  @Get('assignment-queue')
  async assignmentQueue(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DISPATCHER');
    return this.operations.assignmentQueue(user);
  }

  @Get('workflow-readiness')
  async workflowReadiness(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DISPATCHER');
    return this.operations.workflowReadiness(user);
  }

  @Get('escrow-ledger')
  async escrowLedger(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'ADMIN');
    return this.operations.escrowLedger(user);
  }

  @Post('shipments/:id/progress')
  async progressShipment(
    @Param('id') id: string,
    @Body() body: { status?: ShipmentStatus; note?: string; location?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DRIVER');
    return this.operations.progressTrip(id, body, user);
  }

  @Post('disputes')
  async createDispute(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.operations.createDispute(body, user);
  }

  @Patch('disputes/:id/resolve')
  async resolveDispute(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DISPATCHER');
    return this.operations.resolveDispute(id, body, user);
  }

  @Post('support/tickets')
  async createSupportTicket(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.operations.createSupportTicket(body, user);
  }
}
