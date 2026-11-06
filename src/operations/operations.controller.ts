import { BadRequestException, Body, Controller, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { ShipmentStatus } from '@prisma/client';
import { RequestUserService } from '../common/request-user.service';
import { PaymentReconciliationService } from '../integrations/payment-reconciliation.service';
import { OperationsService } from './operations.service';

@Controller('operations')
export class OperationsController {
  constructor(
    private readonly operations: OperationsService,
    private readonly requestUser: RequestUserService,
    private readonly reconciliation: PaymentReconciliationService,
  ) {}

  // Latest Paystack vs escrow ledger comparison (weekly on Monday, or run by an admin).
  @Get('payment-reconciliation')
  async latestReconciliation(@Headers('authorization') authorization?: string) {
    await this.requestUser.requireRole(authorization, ['ADMIN']);
    return { run: await this.reconciliation.latest() };
  }

  // Read-only on Paystack and the database; dates are YYYY-MM-DD (UTC), default the last 7 days.
  @Post('payment-reconciliation/run')
  async runReconciliation(
    @Body() body: { from?: string; to?: string } | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.requireRole(authorization, ['ADMIN']);
    const day = (value: string | undefined, end: boolean) => {
      if (!value) return undefined;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException('Dates must look like 2026-11-06.');
      return new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
    };
    const to = day(body?.to, true);
    const from = day(body?.from, false);
    return { run: await this.reconciliation.run({ trigger: 'manual', from, to, actorId: user.sub }) };
  }

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

  @Get('alerts')
  async alerts(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DISPATCHER');
    return this.operations.alerts(user);
  }

  @Get('escrow-ledger')
  async escrowLedger(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'ADMIN');
    return this.operations.escrowLedger(user);
  }

  @Get('finance-summary')
  async financeSummary(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'ADMIN');
    return this.operations.financeSummary(user);
  }

  @Get('fraud-signals')
  async fraudSignals(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'ADMIN');
    return this.operations.fraudSignals(user);
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
