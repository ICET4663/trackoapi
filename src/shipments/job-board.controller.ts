import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { RequestUserService } from '../common/request-user.service';
import { JobBoardService } from './job-board.service';

// /v1/job-board: drivers browse and ask for loads; the customer (or operations) picks a driver.
@Controller('job-board')
export class JobBoardController {
  constructor(
    private readonly jobBoard: JobBoardService,
    private readonly requestUser: RequestUserService,
  ) {}

  @Get()
  async list(
    @Headers('authorization') authorization?: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
  ) {
    const user = await this.requestUser.requireRole(authorization, ['DRIVER']);
    // Optional: the phone's current position, so "km to pickup" works before any trip GPS exists.
    // Only used to sort this driver's own board; it is not stored (asking for a load stores it).
    const near = lat !== undefined && lng !== undefined && lat !== '' && lng !== ''
      ? { latitude: Number(lat), longitude: Number(lng) }
      : null;
    return this.jobBoard.listForDriver(user.sub, near);
  }

  @Post(':shipmentId/request')
  async request(
    @Param('shipmentId') shipmentId: string,
    @Body() body?: { latitude?: unknown; longitude?: unknown } | null,
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.requireRole(authorization, ['DRIVER']);
    // Optional (24 Nov 2026): the phone's position when asking, so the customer sees how far the
    // driver really is. Older apps send no body and the trip GPS is used as before.
    const near = body && body.latitude != null && body.longitude != null
      ? { latitude: Number(body.latitude), longitude: Number(body.longitude) }
      : null;
    return this.jobBoard.request(user.sub, shipmentId, near);
  }

  @Post(':shipmentId/withdraw')
  async withdraw(@Param('shipmentId') shipmentId: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.requireRole(authorization, ['DRIVER']);
    return this.jobBoard.withdraw(user.sub, shipmentId);
  }

  @Get('shipments/:shipmentId/requests')
  async requests(@Param('shipmentId') shipmentId: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.requireRole(authorization, ['CUSTOMER', 'DISPATCHER', 'ADMIN']);
    return this.jobBoard.listForShipment(shipmentId, user.sub, user.role);
  }

  @Post('requests/:requestId/approve')
  async approve(@Param('requestId') requestId: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.requireRole(authorization, ['CUSTOMER', 'DISPATCHER', 'ADMIN']);
    return this.jobBoard.approve(requestId, user.sub, user.role);
  }

  @Post('requests/:requestId/decline')
  async decline(@Param('requestId') requestId: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.requireRole(authorization, ['CUSTOMER', 'DISPATCHER', 'ADMIN']);
    return this.jobBoard.decline(requestId, user.sub, user.role);
  }
}
