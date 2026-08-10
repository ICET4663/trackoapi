import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequestUserService } from '../common/request-user.service';
import { SettingsService } from './settings.service';

@Controller()
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly requestUser: RequestUserService,
  ) {}

  @Get('account/overview')
  async accountOverview(@Query('role') role = 'CUSTOMER', @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, role as UserRole);
    return this.settingsService.accountOverview(role as 'CUSTOMER', user.sub, user.role);
  }

  @Get('account/profile')
  async profile(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.settingsService.profile(user.sub);
  }

  @Patch('account/profile')
  async updateProfile(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.settingsService.updateProfile(user.sub, body);
  }

  @Patch('account/profile/avatar')
  async updateProfilePicture(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.settingsService.updateProfile(user.sub, { avatarUrl: body.avatarDataUrl });
  }

  @Delete('account/profile/avatar')
  async removeProfilePicture(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.settingsService.updateProfile(user.sub, { avatarUrl: null });
  }

  @Get('settings/notification-preferences')
  async notificationPreferences(@Query('role') role = 'CUSTOMER', @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, role as UserRole);
    return this.settingsService.notificationPreferences(user.sub, role as UserRole);
  }

  @Patch('settings/notification-preferences')
  async updateNotificationPreferences(
    @Body() body: { role?: UserRole; key?: never; value?: boolean },
    @Headers('authorization') authorization?: string,
  ) {
    const role = body.role ?? 'CUSTOMER';
    const user = await this.requestUser.fromAuthorizationHeader(authorization, role);
    return this.settingsService.updateNotificationPreference(user.sub, role, body);
  }

  @Get('support')
  supportIndex() {
    return this.settingsService.supportIndex();
  }

  @Get('support/articles/:id')
  supportArticle(@Param('id') id: string) {
    return this.settingsService.supportArticle(id);
  }

  @Post('support/articles/:id/feedback')
  submitSupportFeedback() {
    return { saved: true };
  }

  @Post('support/contact')
  async createSupportContact(@Body() body: { channel?: string; role?: string; topic?: string; message?: string; shipmentId?: string }, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, (body.role as UserRole) ?? 'CUSTOMER');
    return this.settingsService.createSupportContact(user.sub, body);
  }

  @Post('support/emergency-alerts')
  sendEmergencyAlert() {
    return { sent: true };
  }

  @Get('legal-documents')
  legalDocuments() {
    return this.settingsService.legalDocumentSummaries();
  }

  @Get('legal-documents/:id')
  legalDocument(@Param('id') id: string) {
    return this.settingsService.legalDocument(id);
  }

  @Get('customer/addresses')
  async savedAddresses(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.settingsService.savedAddresses(user.sub);
  }

  @Get('customer/addresses/:id')
  async savedAddress(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.settingsService.savedAddress(id, user.sub);
  }

  @Post('customer/addresses')
  async createAddress(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.settingsService.saveAddress(body, undefined, user.sub);
  }

  @Patch('customer/addresses/:id')
  async updateAddress(@Param('id') id: string, @Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.settingsService.saveAddress(body, id, user.sub);
  }

  @Delete('customer/addresses/:id')
  deleteAddress() {
    return { deleted: true };
  }

  @Get('customer/payment-methods')
  async paymentMethods(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.settingsService.paymentMethods(user.sub);
  }

  @Get('customer/payment-methods/:id')
  async paymentMethod(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.settingsService.paymentMethod(id, user.sub);
  }

  @Post('customer/payment-methods/:id/default')
  async setDefaultPaymentMethod(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return { ...(await this.settingsService.paymentMethod(id, user.sub)), isDefault: true };
  }

  @Delete('customer/payment-methods/:id')
  removePaymentMethod() {
    return { deleted: true };
  }

  @Post('customer/payment-methods/setup')
  createPaymentSetup() {
    return { message: 'Payment setup is disabled in preview.' };
  }

  @Get('customer/billing-history')
  async billingHistory(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.settingsService.billingHistory(user.sub);
  }

  @Get('driver/payout-account')
  async bankAccount(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DRIVER');
    return this.settingsService.bankAccount(user.sub);
  }

  @Get('driver/earnings')
  async driverEarnings(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DRIVER');
    return this.settingsService.driverEarnings(user.sub);
  }

  @Post('driver/withdrawals')
  async requestDriverWithdrawal(@Body() body: { amountKobo?: number; amount?: number; note?: string }, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DRIVER');
    return this.settingsService.requestDriverWithdrawal(user.sub, body);
  }

  @Post('driver/payout-account/change-request')
  createBankAccountChange() {
    return { message: 'Payout account changes are disabled in preview.' };
  }

  @Get('driver/documents')
  async driverDocuments(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DRIVER');
    return this.settingsService.driverDocuments(user.sub);
  }

  @Get('driver/documents/:id')
  async driverDocument(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DRIVER');
    return this.settingsService.driverDocument(id, user.sub);
  }

  @Post('driver/documents/:id/upload-request')
  createDocumentUpload() {
    return { message: 'Document upload is disabled in preview.' };
  }

  @Get('driver/safety-settings')
  async safetySettings(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DRIVER');
    return this.settingsService.safetySettings(user.sub);
  }

  @Patch('driver/safety-settings')
  async updateSafetySettings(@Body() body: { key?: string; value?: boolean | string }, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'DRIVER');
    return this.settingsService.updateSafetySetting(body, user.sub);
  }

  @Post('driver/safety-incidents')
  reportSafetyIncident() {
    return { reported: true };
  }

  @Get('admin/platform-settings')
  platformSettings() {
    return this.settingsService.platformSettings();
  }

  @Get('admin/platform-settings/:key')
  platformSetting(@Param('key') key: string) {
    return this.settingsService.platformSetting(key);
  }

  @Patch('admin/platform-settings/:key')
  updatePlatformSetting(@Param('key') key: string, @Body() body: { value?: string }) {
    return { ...this.settingsService.platformSetting(key), value: body.value ?? this.settingsService.platformSetting(key).value };
  }

  @Get('admin/payout-requests')
  async payoutRequests(@Headers('authorization') authorization?: string) {
    await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.settingsService.adminPayoutRequests();
  }

  @Post('admin/payout-requests/:id/review')
  async reviewPayoutRequest(
    @Param('id') id: string,
    @Body() body: { decision?: string; note?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.settingsService.reviewPayoutRequest(id, user.sub, body);
  }

  @Get('admin/audit-logs')
  async auditLogs(@Query('category') category?: string, @Headers('authorization') authorization?: string) {
    await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.settingsService.auditLogs(category);
  }

  @Get('admin/audit-logs/:id')
  async auditLog(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.settingsService.auditLog(id);
  }
}
