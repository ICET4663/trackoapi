import { Controller, Get, Headers, Param, Post } from '@nestjs/common';
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
  async list(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.requireRole(authorization, ['DRIVER']);
    return this.jobBoard.listForDriver(user.sub);
  }

  @Post(':shipmentId/request')
  async request(@Param('shipmentId') shipmentId: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.requireRole(authorization, ['DRIVER']);
    return this.jobBoard.request(user.sub, shipmentId);
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
