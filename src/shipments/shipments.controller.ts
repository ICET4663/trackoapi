import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequestUserService } from '../common/request-user.service';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto';
import { ShipmentsService } from './shipments.service';

@Controller('shipments')
export class ShipmentsController {
  constructor(
    private readonly shipmentsService: ShipmentsService,
    private readonly requestUser: RequestUserService,
  ) {}

  @Post()
  async create(@Body() dto: CreateShipmentDto, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.shipmentsService.create(user.sub, dto);
  }

  @Get()
  async list(@Headers('authorization') authorization?: string, @Query('role') role?: UserRole) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, role ?? 'CUSTOMER');
    return this.shipmentsService.list(user.sub, user.role);
  }

  @Get('dispatch/available-drivers')
  async availableDrivers(@Headers('authorization') authorization?: string) {
    await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.shipmentsService.availableDrivers();
  }

  @Get('pending-review')
  async pendingReview(@Headers('authorization') authorization?: string) {
    await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.shipmentsService.pendingReview();
  }

  @Post(':id/approve')
  async approveShipment(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.shipmentsService.approveShipment(id, user.sub, user.role);
  }

  @Post('assignments/:assignmentId/accept')
  async acceptAssignment(@Param('assignmentId') assignmentId: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DRIVER');
    return this.shipmentsService.respondToAssignment(assignmentId, user.sub, 'ACCEPT');
  }

  @Post('assignments/:assignmentId/reject')
  async rejectAssignment(@Param('assignmentId') assignmentId: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DRIVER');
    return this.shipmentsService.respondToAssignment(assignmentId, user.sub, 'REJECT');
  }

  @Get(':id')
  async get(@Param('id') id: string, @Headers('authorization') authorization?: string, @Query('role') role?: UserRole) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, role ?? 'CUSTOMER');
    return this.shipmentsService.get(id, user.sub, user.role);
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateShipmentStatusDto,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.shipmentsService.updateStatus(id, user.sub, user.role, dto);
  }

  @Post(':id/timeline')
  async addTimelineEvent(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.shipmentsService.addTimelineEvent(id, user.sub, user.role, body);
  }

  @Get(':id/assignments')
  async listAssignments(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.shipmentsService.listAssignments(id, user.sub, user.role);
  }

  @Post(':id/assignments')
  async offerAssignment(
    @Param('id') id: string,
    @Body() body: { driverId?: string; vehicleId?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DISPATCHER');
    return this.shipmentsService.offerAssignment(id, body, user.role);
  }

  @Get(':id/escrow')
  async getEscrow(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    await this.requestUser.fromAuthorizationHeader(authorization);
    return this.shipmentsService.getEscrow(id);
  }

  @Post(':id/escrow/checks/:check')
  async confirmEscrowCheck(
    @Param('id') id: string,
    @Param('check') check: string,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.shipmentsService.confirmEscrowCheck(id, check, user.role);
  }

  @Post(':id/escrow/release')
  async releaseEscrow(
    @Param('id') id: string,
    @Body() body: { note?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DISPATCHER');
    return this.shipmentsService.releaseEscrow(id, user.role, body.note);
  }

  @Post(':id/escrow/dispute')
  async disputeEscrow(
    @Param('id') id: string,
    @Body() body: { note?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.shipmentsService.disputeEscrow(id, user.role, body.note);
  }

  @Post(':id/escrow/refund')
  async refundEscrow(
    @Param('id') id: string,
    @Body() body: { note?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DISPATCHER');
    return this.shipmentsService.refundEscrow(id, user.role, body.note);
  }

  @Post(':id/review')
  async submitReview(
    @Param('id') id: string,
    @Body() body: { rating?: number; comment?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.requireRole(authorization, ['CUSTOMER']);
    return this.shipmentsService.submitReview(id, user.sub, body);
  }

  @Get(':id/review')
  async getReview(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    await this.requestUser.fromAuthorizationHeader(authorization);
    return this.shipmentsService.getReview(id);
  }
}
