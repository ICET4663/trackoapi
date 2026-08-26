import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { AuthUser } from '../common/types/auth-user';
import { AuthService } from './auth.service';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { RegisterRequestDto } from './dto/register-request.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register/request')
  @Public()
  requestRegistrationCode(@Body() dto: RegisterRequestDto) {
    return this.authService.requestRegistrationCode(dto);
  }

  @Post('register')
  @Public()
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Public()
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('portals')
  @Public()
  getLoginPortals(@Body() dto: LoginDto) {
    return this.authService.getLoginPortals(dto);
  }

  @Post('password-reset/request')
  @Public()
  requestPasswordReset(@Body() body: { identifier?: string }) {
    return this.authService.requestPasswordReset(body.identifier ?? '');
  }

  @Post('password-reset/confirm')
  @Public()
  confirmPasswordReset(@Body() body: { identifier?: string; code?: string; password?: string }) {
    return this.authService.confirmPasswordReset(body);
  }

  @Post('refresh')
  @Public()
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @Public()
  logout(@Body() dto: RefreshDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  me(@CurrentUser() user: AuthUser) {
    return this.authService.me(user.sub);
  }

  @Delete('account')
  @UseGuards(AuthGuard('jwt'))
  deleteAccount(@CurrentUser() user: AuthUser, @Body() dto: DeleteAccountDto) {
    return this.authService.deleteAccount(user.sub, dto);
  }
}
