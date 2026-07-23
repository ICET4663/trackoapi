import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/types/auth-user';
import { PortalService } from './portal.service';

@Controller()
export class PortalController {
  constructor(private readonly portalService: PortalService) {}

  @Get('customer/portal')
  customer(@CurrentUser() user?: AuthUser) {
    return this.portalService.customer(user?.sub);
  }

  @Get('driver/portal')
  driver(@CurrentUser() user?: AuthUser) {
    return this.portalService.driver(user?.sub);
  }

  @Get('owner/portal')
  owner(@CurrentUser() user?: AuthUser) {
    return this.portalService.owner(user?.sub);
  }
}
