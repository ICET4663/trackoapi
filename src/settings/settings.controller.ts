import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
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

  @Post('account/deletion-request')
  async requestAccountDeletion(@Body() body: { reason?: string }, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.settingsService.requestAccountDeletion(user.sub, body);
  }

  @Get('admin/deletion-requests')
  async pendingAccountDeletionRequests(@Headers('authorization') authorization?: string) {
    await this.requestUser.requireRole(authorization, ['ADMIN']);
    return this.settingsService.pendingAccountDeletionRequests();
  }

  @Post('admin/deletion-requests/:userId/review')
  async reviewAccountDeletionRequest(
    @Param('userId') userId: string,
    @Body() body: { decision?: string; note?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const reviewer = await this.requestUser.requireRole(authorization, ['ADMIN']);
    return this.settingsService.reviewAccountDeletionRequest(userId, reviewer.sub, body);
  }

  @Get('admin/driver-documents')
  async pendingDriverDocuments(@Headers('authorization') authorization?: string) {
    await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.settingsService.pendingDriverDocuments();
  }

  @Post('admin/driver-documents/:documentId/review')
  async reviewDriverDocument(
    @Param('documentId') documentId: string,
    @Body() body: { decision?: string; note?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const reviewer = await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.settingsService.reviewDriverDocument(documentId, reviewer.sub, body);
  }

  @Get('owner/vehicles/:vehicleId/documents')
  async vehicleDocuments(@Param('vehicleId') vehicleId: string, @Headers('authorization') authorization?: string) {
    const owner = await this.requestUser.fromAuthorizationHeader(authorization, 'TRUCK_OWNER');
    return this.settingsService.vehicleDocuments(vehicleId, owner.sub);
  }

  @Post('owner/vehicles/:vehicleId/documents/:type/upload-request')
  async uploadVehicleDocument(
    @Param('vehicleId') vehicleId: string,
    @Param('type') type: string,
    @Body() body: { fileUrl?: string; url?: string; number?: string; expires?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const owner = await this.requestUser.fromAuthorizationHeader(authorization, 'TRUCK_OWNER');
    return this.settingsService.uploadVehicleDocument(vehicleId, owner.sub, type, body);
  }

  @Get('owner/loads/:shipmentId')
  async ownerLoadDetail(@Param('shipmentId') shipmentId: string, @Headers('authorization') authorization?: string) {
    const owner = await this.requestUser.requireRole(authorization, ['TRUCK_OWNER']);
    return this.settingsService.ownerLoadDetail(owner.sub, shipmentId);
  }

  @Get('owner/settlements/:shipmentId/receipt')
  async ownerSettlementReceipt(@Param('shipmentId') shipmentId: string, @Headers('authorization') authorization?: string) {
    const owner = await this.requestUser.requireRole(authorization, ['TRUCK_OWNER']);
    return this.settingsService.ownerSettlementReceipt(owner.sub, shipmentId);
  }

  @Get('owner/vehicle-income')
  async ownerVehicleIncome(@Headers('authorization') authorization?: string) {
    const owner = await this.requestUser.requireRole(authorization, ['TRUCK_OWNER']);
    return this.settingsService.ownerVehicleIncome(owner.sub);
  }

  @Get('owner/vehicles/:vehicleId/expenses')
  async vehicleExpenses(@Param('vehicleId') vehicleId: string, @Headers('authorization') authorization?: string) {
    const owner = await this.requestUser.requireRole(authorization, ['TRUCK_OWNER']);
    return this.settingsService.vehicleExpenses(vehicleId, owner.sub);
  }

  @Post('owner/vehicles/:vehicleId/expenses')
  async createVehicleExpense(
    @Param('vehicleId') vehicleId: string,
    @Body() body: { category?: string; amountKobo?: number; amount?: number; description?: string; serviceDate?: string; odometerKm?: number; receiptUrl?: string; nextServiceDate?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const owner = await this.requestUser.requireRole(authorization, ['TRUCK_OWNER']);
    return this.settingsService.createVehicleExpense(vehicleId, owner.sub, body);
  }

  @Delete('owner/vehicles/:vehicleId/expenses/:expenseId')
  async deleteVehicleExpense(
    @Param('vehicleId') vehicleId: string,
    @Param('expenseId') expenseId: string,
    @Headers('authorization') authorization?: string,
  ) {
    const owner = await this.requestUser.requireRole(authorization, ['TRUCK_OWNER']);
    return this.settingsService.deleteVehicleExpense(vehicleId, expenseId, owner.sub);
  }

  @Get('admin/vehicle-documents')
  async pendingVehicleDocuments(@Headers('authorization') authorization?: string) {
    await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.settingsService.pendingVehicleDocuments();
  }

  @Post('admin/vehicle-documents/:documentId/review')
  async reviewVehicleDocument(
    @Param('documentId') documentId: string,
    @Body() body: { decision?: string; note?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const reviewer = await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.settingsService.reviewVehicleDocument(documentId, reviewer.sub, body);
  }

  @Get('admin/fleet-assignments')
  async fleetAssignments(@Headers('authorization') authorization?: string) {
    await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.settingsService.fleetAssignments();
  }

  @Post('admin/fleet-assignments')
  async assignDriverToVehicle(
    @Body() body: { vehicleId?: string; driverId?: string },
    @Headers('authorization') authorization?: string,
  ) {
    await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    if (!body?.vehicleId || !body?.driverId) throw new BadRequestException('A truck and a driver must both be selected.');
    return this.settingsService.assignDriverToVehicle(body.vehicleId, body.driverId);
  }

  @Post('owner/fleet-assignments')
  async assignDriverToOwnedVehicle(
    @Body() body: { vehicleId?: string; driverId?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const owner = await this.requestUser.requireRole(authorization, ['TRUCK_OWNER']);
    if (!body?.vehicleId || !body?.driverId) throw new BadRequestException('A truck and a driver must both be selected.');
    return this.settingsService.assignDriverToOwnedVehicle(body.vehicleId, body.driverId, owner.sub);
  }

  @Delete('admin/fleet-assignments/:vehicleId')
  async unassignDriverFromVehicle(
    @Param('vehicleId') vehicleId: string,
    @Headers('authorization') authorization?: string,
  ) {
    await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.settingsService.unassignDriverFromVehicle(vehicleId);
  }

  @Delete('owner/fleet-assignments/:vehicleId')
  async unassignDriverFromOwnedVehicle(
    @Param('vehicleId') vehicleId: string,
    @Headers('authorization') authorization?: string,
  ) {
    const owner = await this.requestUser.requireRole(authorization, ['TRUCK_OWNER']);
    return this.settingsService.unassignDriverFromOwnedVehicle(vehicleId, owner.sub);
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

  // Drives which language incoming message translations target for this user (see
  // CommunicationService.translateForRecipient) - separate from the app's own UI
  // language, which is purely on-device and never sent to the backend.
  @Patch('settings/language')
  async updateLanguagePreference(
    @Body() body: { language?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.settingsService.updatePreferredLanguage(user.sub, body.language);
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
  async sendEmergencyAlert(
    @Body() body: { role?: UserRole; message?: string; shipmentId?: string; latitude?: number; longitude?: number },
    @Headers('authorization') authorization?: string,
  ) {
    const role = body.role ?? 'CUSTOMER';
    const user = await this.requestUser.fromAuthorizationHeader(authorization, role);
    return this.settingsService.sendEmergencyAlert(user.sub, user.role, body);
  }

  @Get('support/tickets')
  async supportTickets(@Headers('authorization') authorization?: string) {
    await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.settingsService.supportTickets();
  }

  @Post('support/tickets/:id/resolve')
  async resolveSupportTicket(
    @Param('id') id: string,
    @Body() body: { resolution?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.requireRole(authorization, ['ADMIN', 'DISPATCHER']);
    return this.settingsService.resolveSupportTicket(id, user.sub, body);
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
    return this.settingsService.setDefaultPaymentMethod(id, user.sub);
  }

  @Delete('customer/payment-methods/:id')
  async removePaymentMethod(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorizati™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İØYš]™\ˆØİ[Y[Îˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆJNÂ‚ˆÛÛœİQ’YH™]ÈX\
›İÜË›X\

›İÊHOˆÜ›İËšY›İ×JJNÂˆ™]\›ˆ\Ëœ™\]Z\™Yš]™\‘Øİ[Y[Ë›X\

È\K]HJHOˆÂˆÛÛœİ›İÈHQ’Y™Ù]
\Ë™š]™\‘Øİ[Y[’Y
\Ù\’Y\JJNÂˆYˆ
\›İÊH™]\›ˆÈYˆ\K]KY]Nˆ	Õ\ØY™\]Z\™Y	Ëİ]Nˆ	ÛZ\ÜÚ[™ÉÈ\ÈÛÛœİNÂˆ™]\›ˆÂˆYˆ\Kˆ]Nˆ›İË]KˆY]Nˆ›İË›Y]Kˆİ]Nˆ›İËœİ]Kˆ\ÜİYYˆ›İËš\ÜİYYËÒTÓÔİš[™ÏËŠ
Kˆ^\™\Îˆ›İË™^\™\ÏËÒTÓÔİš[™ÏËŠ
Kˆ[X™\ˆ›İË›[X™\‹ˆš[U\›ˆ›İË™š[U\›ˆ™]šY]Ó›İNˆ›İËœ™]šY]Ó›İKˆNÂˆJNÂˆB‚ˆ\Ş[˜Èš]™\‘Øİ[Y[
Yˆİš[™Ë\Ù\’Yˆİš[™ÊHÂˆÛÛœİØİ[Y[ÈH]ØZ]\Ë™š]™\‘Øİ[Y[Ê\Ù\’Y
NÂˆÛÛœİØİ[Y[HØİ[Y[Ë™š[™

ØÊHOˆØËšYOOHY
NÂˆYˆ
YØİ[Y[
H›İÈ™]È›İ›İ[™^Ù\[ÛŠ	ÑØİ[Y[›İ›İ[™‰ÊNÂˆ™]\›ˆØİ[Y[ÂˆB‚ˆ\Ş[˜È\ØYš]™\‘Øİ[Y[
ˆ\Ù\’Yˆİš[™ËˆYˆİš[™Ëˆ[œ]ˆÈš[U\›Îˆİš[™ÎÈ\›Îˆİš[™ÎÈ[X™\Îˆİš[™ÎÈ^\™\ÏÎˆİš[™ÎÈY]OÎˆİš[™ÈKˆ
HÂˆÛÛœİš[U\›Hİš[™Ê[œ]™š[U\›ÏÈ[œ]\›ÏÈ	ÉÊKš[J
NÂˆYˆ
Yš[U\›
H›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	ÑØİ[Y[š[HT“\È™\]Z\™Y‰ÊNÂ‚ˆÛÛœİ^\™\ÈH[œ]™^\™\ÈÈ™]È]J[œ]™^\™\ÊHˆ[ÂˆÛÛœİ^\™\Õ˜[YHH^\™\È	‰ˆS[X™\‹š\Ó˜SŠ^\™\Ë™Ù][YJ
JHÈ^\™\Èˆ[ÂˆÛÛœİ]HHYˆœÜ]
ÖËW×KÊBˆ™š[\Š›ÛÛX[ŠBˆ›X\

\
HOˆ\˜Ú\]

KÕ\\Ø\ÙJ
H
È\œÛXÙJJJBˆš›Ú[Š	È	ÊH	Ñš]™\ˆØİ[Y[	ÎÂ‚ˆHÂˆ]ØZ]\Ëœš\ÛXK‰]Y\T˜]Õ[œØY™Jˆ[œÙ\[È‘š]™\‘Øİ[Y[ˆ
šY‹\Ù\’Y‹]H‹›Y]H‹œİ]H‹™^\™\È‹›[X™\ˆ‹™š[U\›‹\]Y]ŠBˆ˜[Y\È
	K	‹	Ë		ÔS‘S‘×Ô‘U’QUÉÎˆ‘š]™\‘Øİ[Y[İ]H‹	K	‹	Ëİ\œ™[İ[Y\İ[\
BˆÛˆÛÛ™›Xİ
šYŠHÈ\]BˆÙ]›Y]HˆH^ÛYYˆ›Y]H‹ˆœİ]HˆH	ÔS‘S‘×Ô‘U’QUÉÎˆ‘š]™\‘Øİ[Y[İ]H‹ˆ™^\™\ÈˆH^ÛYYˆ™^\™\È‹ˆ›[X™\ˆˆH^ÛYYˆ›[X™\ˆ‹ˆ™š[U\›ˆH^ÛYYˆ™š[U\›‹ˆœ™]šY]Ó›İHˆH[ˆœ™]šY]ÙY]ˆH[ˆœ™]šY]ÙYRYˆH[ˆ\]Y]ˆHİ\œ™[İ[Y\İ[\ˆ\Ë™š]™\‘Øİ[Y[’Y
\Ù\’YY
Kˆ\Ù\’Yˆ]Kˆ[œ]›Y]HÏÈ	Õ\ØYYH[™[™È™]šY]ÉËˆ^\™\Õ˜[YKˆ[œ]›[X™\ˆÏÈ[ˆš[U\›ˆ
NÂ‚ˆ]ØZ]\Ëœš\ÛXK˜]Y]ÙË˜Ü™X]JÂˆ]NˆÂˆXİÜ’Yˆ\Ù\’YˆXİ[Ûˆ	Ñ’U‘T—ÑĞÕSQS•ÕTĞQQ	Ëˆ[]Nˆ	Ñš]™\‘Øİ[Y[	Ëˆ[]RYˆ\Ë™š]™\‘Øİ[Y[’Y
\Ù\’YY
KˆY]Y]NˆÈš[U\›[X™\ˆ[œ]›[X™\ˆÏÈ[^\™\Îˆ[œ]™^\™\ÈÏÈ[KˆKˆJK˜Ø]Ú


HOˆ[
NÂ‚ˆ]ØZ]\Ë››İYšXØ][ÛœË˜Ü™X]JÂˆ›ÛNˆ	ĞQRS‰Ëˆ]Nˆ	Ñš]™\ˆØİ[Y[\ØYY	Ëˆ›ÙNˆ	İ]_HØ\È\ØYY[™™YYÈ™]šY]Ë˜ˆÛ™Nˆ	ÕĞT“’S‘ÉËˆ[]Nˆ	Ñš]™\‘Øİ[Y[	Ëˆ[]RYˆ\Ë™š]™\‘Øİ[Y[’Y
\Ù\’YY
KˆXİ[Û•\›ˆ	ËØYZ[‹Ùš]™\‹YØİ[Y[ÉËˆJNÂ‚ˆ™]\›ˆÂˆ\ØYYˆYKˆY\ÜØYÙNˆ	Ñš]™\ˆØİ[Y[\ØYY›Üˆ™]šY]Ë‰ËˆØİ[Y[ˆÈY]KY]Nˆ[œ]›Y]HÏÈ	Õ\ØYYH[™[™È™]šY]ÉËİ]Nˆ	Ü[™[™×Ü™]šY]ÉËš[U\›KˆNÂˆHØ]Ú
\œ›ÜŠHÂˆËÈH[œÙ\TÈH\ØYHHš]™\ˆÚÈ™[Y]™\ÈZ\ˆXÙ[œÙHİÈØ\ÈØ]™YˆËÈÚ[ˆ]™]™\ˆ\œÚ\İY\È›È™X[Øİ[Y[Ûˆš[KÚ[[KˆØ[YBˆËÈ˜ZÙK\İXØÙ\ÜË[Û‹Y˜Z[\™H]\›ˆ\ÈÙ\ÜÚ[Ûˆ\È™\X]YHš^Y[Ù]Ú\™K‚ˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İØ]™H\ÈØİ[Y[ˆX\ÙHHYØZ[ˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆBˆB‚ˆËÈHYZ[‹Y˜XÚ[™ÈÛİ[\œ\È\ØYš]™\‘Øİ[Y[

HX›İ™HH™]š[İ\ÛH›İ[™ÂˆËÈ[]Ú\™H]™\ˆ™XYS‘S‘×Ô‘U’QUÈØİ[Y[È˜XÚÈİ]ÜˆÙ]HØİ[Y[È‘T’Q’QQˆËÈÛÈHš]™\‰ÜÈ\ØYYXÙ[œÙKÚ[œİ\˜[˜ÙHÛİ[™]™\ˆXİX[H\ÜÈ™]šY]ÎÈHœİ]H‚ˆËÈÚİÛˆØ\È[Ø^\ÈHÜ›Û™È\™ÛÙY˜[YH™YØ\™\ÜÈÙˆÚ][ˆYZ[ˆY
›İ[™ËˆËÈÚ[˜ÙH\™HØ\È›ÈYZ[ˆXİ[ÛˆÈZÙJK‚ˆ\Ş[˜È[™[™Ñš]™\‘Øİ[Y[Ê
HÂˆHÂˆÛÛœİ›İÜÈH]ØZ]\Ëœš\ÛXK‰]Y\T˜]Õ[œØY™OˆÈYˆİš[™ÎÈ\Ù\’Yˆİš[™ÎÈ]Nˆİš[™ÎÈY]Nˆİš[™ÎÈ[X™\ˆİš[™È[È^\™\Îˆ]H[Èš[U\›ˆİš[™È[ÈÜ™X]Y]ˆ]NÈ[XZ[ˆİš[™ÎÈÛ™Nˆİš[™ÎÈ[˜[YNˆİš[™È[V×BˆŠˆÙ[XİˆšY‹ˆ\Ù\’Y‹ˆ]H‹ˆ›Y]H‹ˆ›[X™\ˆ‹ˆ™^\™\È‹ˆ™š[U\›‹ˆ˜Ü™X]Y]‹ˆKˆ™[XZ[‹KˆœÛ™H‹ˆ™[˜[YH‚ˆœ›ÛH‘š]™\‘Øİ[Y[ˆˆ›Ú[ˆ•\Ù\ˆˆHÛˆKˆšYˆHˆ\Ù\’Y‚ˆY›Ú[ˆ”›Ùš[HˆÛˆˆ\Ù\’YˆHKˆšY‚ˆÚ\™Hˆœİ]HˆH	ÔS‘S‘×Ô‘U’QUÉÎˆ‘š]™\‘Øİ[Y[İ]H‚ˆÜ™\ˆHˆ˜Ü™X]Y]ˆ\ØÂˆ[Z]Lˆ
NÂˆ™]\›ˆ›İÜË›X\

›İÊHOˆ
ÂˆYˆ›İËšYˆ\Ù\’Yˆ›İË\Ù\’Yˆ]Nˆ›İË]KˆY]Nˆ›İË›Y]Kˆ[X™\ˆ›İË›[X™\‹ˆ^\™\Îˆ›İË™^\™\ÏËÒTÓÔİš[™Ê
HÏÈ[ˆš[U\›ˆ›İË™š[U\›ˆİX›Z]Y]ˆ›İË˜Ü™X]Y]ÒTÓÔİš[™Ê
Kˆ[XZ[ˆ›İË™[XZ[ˆÛ™Nˆ›İËœÛ™Kˆ[˜[YNˆ›İË™[˜[YHÏÈ›İË™[XZ[ˆJJNÂˆHØ]Ú
\œ›ÜŠHÂˆËÈ\È\ÙYÈ]™H›È\œ›Üˆ[™[™È][HH™X[˜Z[\™Hİ\™˜XÙYÛ›H\ÂˆËÈ™\İ”ÉÜÈÙ[™\šXË]Z[Yœ™YH’[\›˜[Ù\™\ˆ\œ›Üˆ‹‚ˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İØY[™[™Èš]™\ˆØİ[Y[ËˆX\ÙHHYØZ[ˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆBˆB‚ˆ\Ş[˜È™]šY]Ñš]™\‘Øİ[Y[
Øİ[Y[Yˆİš[™Ë™]šY]Ù\’Yˆİš[™Ë[œ]ˆÈXÚ\Ú[ÛÎˆİš[™ÎÈ›İOÎˆİš[™ÈJHÂˆÛÛœİXÚ\Ú[ÛˆHİš[™Ê[œ]™XÚ\Ú[ÛˆÏÈ	ÉÊKÕ\\Ø\ÙJ
NÂˆYˆ
XÚ\Ú[ÛˆOOH	ĞT“Õ‘IÈ	‰ˆXÚ\Ú[ÛˆOOH	Ô‘R‘PÕ	ÊHÂˆ›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	Õ\ÙHT“Õ‘HÜˆ‘R‘PÕ\ÈHØİ[Y[XÚ\Ú[Û‹‰ÊNÂˆBˆÛÛœİ™^İ]HHXÚ\Ú[ÛˆOOH	ĞT“Õ‘IÈÈ	Õ‘T’Q’QQ	Èˆ	Ô‘R‘PÕQ	ÎÂ‚ˆ]\]YÂˆHÂˆÛÛœİ›İÜÈH]ØZ]\Ëœš\ÛXK‰]Y\T˜]Õ[œØY™OˆÈYˆİš[™ÎÈ\Ù\’Yˆİš[™ÎÈ]Nˆİš[™ÎÈİ]Nˆİš[™ÈV×BˆŠˆ\]H‘š]™\‘Øİ[Y[‚ˆÙ]œİ]HˆH	Nˆ‘š]™\‘Øİ[Y[İ]H‹ˆš\ÜİYYˆHØ\ÙHÚ[ˆ	HH	Õ‘T’Q’QQ	È[ˆİ\œ™[İ[Y\İ[\[ÙHš\ÜİYYˆ[™ˆœ™]šY]Ó›İHˆH	‹ˆœ™]šY]ÙY]ˆHİ\œ™[İ[Y\İ[\ˆœ™]šY]ÙYRYˆH	Ëˆ\]Y]ˆHİ\œ™[İ[Y\İ[\ˆÚ\™HšYˆH	[™œİ]HˆH	ÔS‘S‘×Ô‘U’QUÉÎˆ‘š]™\‘Øİ[Y[İ]H‚ˆ™]\›š[™ÈšY‹\Ù\’Y‹]H‹İÙ\Šœİ]H^
H\Èœİ]H˜ˆ™^İ]Kˆ[œ]››İHÏÈ[ˆ™]šY]Ù\’YˆØİ[Y[Yˆ
NÂˆ\]YH›İÜÖÌNÂˆHØ]Ú
\œ›ÜŠHÂˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İ™XÛÜ™\ÈXÚ\Ú[Û‹ˆX\ÙHHYØZ[ˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆBˆYˆ
]\]Y
H›İÈ™]È›İ›İ[™^Ù\[ÛŠ	Ó›È[™[™ÈØİ[Y[›İ[™›Üˆ\ÈXÚ\Ú[ÛˆH]X^H]™H[™XYH™Y[ˆ™]šY]ÙY‰ÊNÂ‚ˆ]ØZ]\Ëœš\ÛXK˜]Y]ÙË˜Ü™X]JÂˆ]NˆÂˆXİÜ’Yˆ™]šY]Ù\’YˆXİ[ÛˆXÚ\Ú[ÛˆOOH	ĞT“Õ‘IÈÈ	Ñ’U‘T—ÑĞÕSQS•ĞT“Õ‘Q	Èˆ	Ñ’U‘T—ÑĞÕSQS•Ô‘R‘PÕQ	Ëˆ[]Nˆ	Ñš]™\‘Øİ[Y[	Ëˆ[]RYˆØİ[Y[YˆY]Y]NˆÈ›İNˆ[œ]››İHÏÈ[KˆKˆJK˜Ø]Ú


HOˆ[
NÂ‚ˆ]ØZ]\Ë››İYšXØ][ÛœË˜Ü™X]JÂˆ\Ù\’Yˆ\]Y\Ù\’Yˆ]NˆXÚ\Ú[ÛˆOOH	ĞT“Õ‘IÈÈ	İ\]Y]_H™\šYšYYˆ	İ\]Y]_H™YYÈ][[Û˜ˆ›ÙNˆXÚ\Ú[ÛˆOOH	ĞT“Õ‘IÂˆÈ[İ\ˆ	İ\]Y]KÓİÙ\Ø\ÙJ
_H\È™Y[ˆ™\šYšYY˜ˆˆ[œ]››İBˆÈ[İ\ˆ	İ\]Y]KÓİÙ\Ø\ÙJ
_HØ\È›İ\›İ™Yˆ	Ú[œ]››İ_Xˆˆ[İ\ˆ	İ\]Y]KÓİÙ\Ø\ÙJ
_HØ\È›İ\›İ™YˆX\ÙH\ØYHÛX\™\ˆÛÜK˜ˆÛ™NˆXÚ\Ú[ÛˆOOH	ĞT“Õ‘IÈÈ	ÔÕPĞÑTÔÉÈˆ	ÑS‘ÑT‰Ëˆ[]Nˆ	Ñš]™\‘Øİ[Y[	Ëˆ[]RYˆØİ[Y[YˆXİ[Û•\›ˆ	ËÙš]™\‹ÙØİ[Y[ÉËˆJNÂ‚ˆ™]\›ˆÈYˆ\]YšYİ]Nˆ\]Yœİ]KXÚ\Ú[ÛˆNÂˆB‚ˆš]˜]H™XYÛ›H™\]Z\™Y™ZXÛQØİ[Y[ÈHÂˆÈ\Nˆ	Ô‘QÒTÕUSÓ‰Ë]Nˆ	Õ™ZXÛH™YÚ\İ˜][Û‰ÈKˆÈ\Nˆ	ÒS”ÕTSÑIË]Nˆ	Ò[œİ\˜[˜ÙHÙ\YšXØ]IÈKˆÈ\Nˆ	Ô“ĞQÓÔ•S‘TÔÉË]Nˆ	Ô›ØYÛÜ[™\ÜÈÙ\YšXØ]IÈKˆH\ÈÛÛœİÂ‚ˆ\Ş[˜È™ZXÛQØİ[Y[Ê™ZXÛRYˆİš[™ËİÛ™\’Yˆİš[™ÊHÂˆ]ØZ]\Ë˜\ÜÙ\™ZXÛSİÛ™\Š™ZXÛRYİÛ™\’Y
NÂˆÛÛœİ›İÜÈH]ØZ]\Ëœš\ÛXK‰]Y\T˜]Õ[œØY™O\œ˜^OÂˆYˆİš[™ÎÈ\Nˆİš[™ÎÈ]Nˆİš[™ÎÈİ]Nˆİš[™ÎÈ[X™\ˆİš[™È[Âˆ^\™\Îˆ]H[Èš[U\›ˆİš[™È[È™]šY]Ó›İNˆİš[™È[ÂˆOŠˆÙ[XİšY‹\H‹]H‹İÙ\Šœİ]H^
H\Èœİ]H‹›[X™\ˆ‹™^\™\È‹™š[U\›‹œ™]šY]Ó›İH‚ˆœ›ÛH•™ZXÛQØİ[Y[ˆÚ\™H™ZXÛRYˆH	HÜ™\ˆH˜Ü™X]Y]ˆ\ØØˆ™ZXÛRYˆ
K˜Ø]Ú


HOˆ×JNÂˆÛÛœİU\HH™]ÈX\
›İÜË›X\

›İÊHOˆÜ›İË\K›İ×JJNÂˆ™]\›ˆ\Ëœ™\]Z\™Y™ZXÛQØİ[Y[Ë›X\

™\]Z\™Y
HOˆÂˆÛÛœİ›İÈHU\K™Ù]
™\]Z\™Y\JNÂˆ™]\›ˆ›İÈÈÈ‹‹œ›İË^\™\Îˆ›İË™^\™\ÏËÒTÓÔİš[™Ê
HÏÈ[HˆÂˆYˆ	İ™ZXÛRYKIÜ™\]Z\™Y\KÓİÙ\Ø\ÙJ
_Xˆ™ZXÛRYˆ\Nˆ™\]Z\™Y\Kˆ]Nˆ™\]Z\™Y]Kˆİ]Nˆ	ÛZ\ÜÚ[™ÉËˆ[X™\ˆ[ˆ^\™\Îˆ[ˆš[U\›ˆ[ˆ™]šY]Ó›İNˆ[ˆNÂˆJNÂˆB‚ˆ\Ş[˜È\ØY™ZXÛQØİ[Y[
ˆ™ZXÛRYˆİš[™ËˆİÛ™\’Yˆİš[™Ëˆ\R[œ]ˆİš[™Ëˆ[œ]ˆÈš[U\›Îˆİš[™ÎÈ\›Îˆİš[™ÎÈ[X™\Îˆİš[™ÎÈ^\™\ÏÎˆİš[™ÈKˆ
HÂˆÛÛœİ™ZXÛHH]ØZ]\Ë˜\ÜÙ\™ZXÛSİÛ™\Š™ZXÛRYİÛ™\’Y
NÂˆÛÛœİ\HH\R[œ]š[J
KÕ\\Ø\ÙJ
NÂˆÛÛœİ™\]Z\™YH\Ëœ™\]Z\™Y™ZXÛQØİ[Y[Ë™š[™

][JHOˆ][K\HOOH\JNÂˆYˆ
\™\]Z\™Y
H›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	Õ[œİ\ÜY™ZXÛHØİ[Y[\K‰ÊNÂˆÛÛœİš[U\›Hİš[™Ê[œ]™š[U\›ÏÈ[œ]\›ÏÈ	ÉÊKš[J
NÂˆYˆ
Yš[U\›
H›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	ÑØİ[Y[š[HT“\È™\]Z\™Y‰ÊNÂˆÛÛœİ^\™\ÈH[œ]™^\™\ÈÈ™]È]J[œ]™^\™\ÊHˆ[ÂˆÛÛœİ^\™\Õ˜[YHH^\™\È	‰ˆS[X™\‹š\Ó˜SŠ^\™\Ë™Ù][YJ
JHÈ^\™\Èˆ[ÂˆÛÛœİYH	İ™ZXÛRYKIİ\KÓİÙ\Ø\ÙJ
_XÂ‚ˆÛÛœİ›İÜÈH]ØZ]\Ëœš\ÛXK‰]Y\T˜]Õ[œØY™O\œ˜^OÈYˆİš[™ÎÈİ]Nˆİš[™ÈOŠˆ[œÙ\[È•™ZXÛQØİ[Y[ˆ
šY‹™ZXÛRY‹\H‹]H‹œİ]H‹›[X™\ˆ‹™^\™\È‹™š[U\›‹\]Y]ŠBˆ˜[Y\È
	K	‹	Ë		ÔS‘S‘×Ô‘U’QUÉÎˆ‘š]™\‘Øİ[Y[İ]H‹	K	‹	Ëİ\œ™[İ[Y\İ[\
BˆÛˆÛÛ™›Xİ
™ZXÛRY‹\HŠHÈ\]HÙ]ˆœİ]HˆH	ÔS‘S‘×Ô‘U’QUÉÎˆ‘š]™\‘Øİ[Y[İ]H‹›[X™\ˆˆH^ÛYYˆ›[X™\ˆ‹ˆ™^\™\ÈˆH^ÛYYˆ™^\™\È‹™š[U\›ˆH^ÛYYˆ™š[U\›‹œ™]šY]Ó›İHˆH[ˆœ™]šY]ÙY]ˆH[œ™]šY]ÙYRYˆH[\]Y]ˆHİ\œ™[İ[Y\İ[\ˆ™]\›š[™ÈšY‹İÙ\Šœİ]H^
H\Èœİ]H˜ˆY™ZXÛRY\K™\]Z\™Y]K[œ]›[X™\ˆÏÈ[^\™\Õ˜[YKš[U\›ˆ
K˜Ø]Ú

\œ›ÜŠHOˆÂˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İØ]™H\È™ZXÛHØİ[Y[ˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆJNÂ‚ˆ]ØZ]\Ë››İYšXØ][ÛœË˜Ü™X]JÂˆ›ÛNˆ	ĞQRS‰Ë]Nˆ	Õ™ZXÛHØİ[Y[\ØYY	Ëˆ›ÙNˆ	Ü™\]Z\™Y]_H›Üˆ	İ™ZXÛKœ]S[X™\ŸH™YYÈ™]šY]Ë˜Û™Nˆ	ÕĞT“’S‘ÉËˆ[]Nˆ	Õ™ZXÛQØİ[Y[	Ë[]RYˆ›İÜÖÌOËšYÏÈYXİ[Û•\›ˆ	ËØYZ[‹İ™ZXÛKYØİ[Y[ÉËˆJK˜Ø]Ú


HOˆ[
NÂˆ™]\›ˆÈ\ØYYˆYKY\ÜØYÙNˆ	Õ™ZXÛHØİ[Y[\ØYY›Üˆ™]šY]Ë‰ËØİ[Y[ˆ›İÜÖÌHNÂˆB‚ˆ\Ş[˜È[™[™Õ™ZXÛQØİ[Y[Ê
HÂˆHÂˆÛÛœİ›İÜÈH]ØZ]\Ëœš\ÛXK‰]Y\T˜]Õ[œØY™O\œ˜^OÂˆYˆİš[™ÎÈ™ZXÛRYˆİš[™ÎÈ\Nˆİš[™ÎÈ]Nˆİš[™ÎÈ[X™\ˆİš[™È[Âˆ^\™\Îˆ]H[Èš[U\›ˆİš[™È[ÈÜ™X]Y]ˆ]NÈ]S[X™\ˆİš[™ÎÂˆİÛ™\’Yˆİš[™ÎÈİÛ™\‘[XZ[ˆİš[™ÎÈİÛ™\“˜[YNˆİš[™È[ÂˆOŠˆÙ[XİˆšY‹ˆ™ZXÛRY‹ˆ\H‹ˆ]H‹ˆ›[X™\ˆ‹ˆ™^\™\È‹ˆ™š[U\›‹ˆ˜Ü™X]Y]‹ˆ‹ˆœ]S[X™\ˆ‹‹ˆ›İÛ™\’Y‹Kˆ™[XZ[ˆ\È›İÛ™\‘[XZ[‹ˆ™[˜[YHˆ\È›İÛ™\“˜[YH‚ˆœ›ÛH•™ZXÛQØİ[Y[ˆ›Ú[ˆ•™ZXÛHˆˆÛˆ‹ˆšYˆHˆ™ZXÛRY‚ˆ›Ú[ˆ•\Ù\ˆˆHÛˆKˆšYˆH‹ˆ›İÛ™\’YˆY›Ú[ˆ”›Ùš[HˆÛˆˆ\Ù\’YˆHKˆšY‚ˆÚ\™Hˆœİ]HˆH	ÔS‘S‘×Ô‘U’QUÉÎˆ‘š]™\‘Øİ[Y[İ]H‚ˆÜ™\ˆHˆ˜Ü™X]Y]ˆ\ØÈ[Z]Lˆ
NÂˆ™]\›ˆ›İÜË›X\

›İÊHOˆ
Âˆ‹‹œ›İËˆİÛ™\“˜[YNˆ›İË›İÛ™\“˜[YHÏÈ›İË›İÛ™\‘[XZ[ˆ^\™\Îˆ›İË™^\™\ÏËÒTÓÔİš[™Ê
HÏÈ[ˆİX›Z]Y]ˆ›İË˜Ü™X]Y]ÒTÓÔİš[™Ê
KˆJJNÂˆHØ]Ú
\œ›ÜŠHÂˆËÈ\È\ÙYÈ]™H›È\œ›Üˆ[™[™È][HH™X[˜Z[\™H
K™ËˆBˆËÈ”S‘S‘×Ô‘U’QUÈˆ[[H˜[YHÜˆH™]šY]ÈÛÛ[[ˆZ\ÜÚ[™ÈÛˆ›ÙXİ[Û‹›İ™X[ˆËÈØÚ[XKYšYYÜÈ›İ[™]™JHİ\™˜XÙYÛ›H\È™\İ”ÉÜÈÙ[™\šXË]Z[Yœ™YBˆËÈ’[\›˜[Ù\™\ˆ\œ›Üˆ‹Ú]š[™È›ÈÛYHÚ]XİX[Hœ›ÚÙK‚ˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İØY[™[™È™ZXÛHØİ[Y[ËˆX\ÙHHYØZ[ˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆBˆB‚ˆ\Ş[˜È™]šY]Õ™ZXÛQØİ[Y[
Øİ[Y[Yˆİš[™Ë™]šY]Ù\’Yˆİš[™Ë[œ]ˆÈXÚ\Ú[ÛÎˆİš[™ÎÈ›İOÎˆİš[™ÈJHÂˆÛÛœİXÚ\Ú[ÛˆHİš[™Ê[œ]™XÚ\Ú[ÛˆÏÈ	ÉÊKÕ\\Ø\ÙJ
NÂˆYˆ
VÉĞT“Õ‘IË	Ô‘R‘PÕ	×Kš[˜ÛY\ÊXÚ\Ú[ÛŠJH›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	Õ\ÙHT“Õ‘HÜˆ‘R‘PÕ\ÈHØİ[Y[XÚ\Ú[Û‹‰ÊNÂˆYˆ
XÚ\Ú[ÛˆOOH	Ô‘R‘PÕ	È	‰ˆTİš[™Ê[œ]››İHÏÈ	ÉÊKš[J
JH›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	ĞH™]šY]Ù\ˆ›İH\È™\]Z\™YÚ[ˆ™Z™Xİ[™ÈHØİ[Y[‰ÊNÂˆÛÛœİİ]HHXÚ\Ú[ÛˆOOH	ĞT“Õ‘IÈÈ	Õ‘T’Q’QQ	Èˆ	Ô‘R‘PÕQ	ÎÂˆÛÛœİ›İÜÈH]ØZ]\Ëœš\ÛXK‰]Y\T˜]Õ[œØY™O\œ˜^OÈYˆİš[™ÎÈ™ZXÛRYˆİš[™ÎÈ]Nˆİš[™ÎÈİÛ™\’Yˆİš[™ÎÈ]S[X™\ˆİš[™ÎÈİ]Nˆİš[™ÈOŠˆ\]H•™ZXÛQØİ[Y[ˆÙ]œİ]HˆH	Nˆ‘š]™\‘Øİ[Y[İ]H‹œ™]šY]Ó›İHˆH	‹ˆœ™]šY]ÙY]ˆHİ\œ™[İ[Y\İ[\œ™]šY]ÙYRYˆH	Ë\]Y]ˆHİ\œ™[İ[Y\İ[\ˆœ›ÛH•™ZXÛHˆˆÚ\™HˆšYˆH	[™ˆ™ZXÛRYˆH‹ˆšY‚ˆ[™ˆœİ]HˆH	ÔS‘S‘×Ô‘U’QUÉÎˆ‘š]™\‘Øİ[Y[İ]H‚ˆ™]\›š[™ÈˆšY‹ˆ™ZXÛRY‹ˆ]H‹‹ˆ›İÛ™\’Y‹‹ˆœ]S[X™\ˆ‹İÙ\Šˆœİ]H^
H\Èœİ]H˜ˆİ]K[œ]››İHÏÈ[™]šY]Ù\’YØİ[Y[Yˆ
K˜Ø]Ú

\œ›ÜŠHOˆÂˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İ™XÛÜ™\È™ZXÛHØİ[Y[XÚ\Ú[Ûˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆJNÂˆÛÛœİ\]YH›İÜÖÌNÂˆYˆ
]\]Y
H›İÈ™]È›İ›İ[™^Ù\[ÛŠ	Ó›È[™[™È™ZXÛHØİ[Y[›İ[™È]X^H[™XYH]™H™Y[ˆ™]šY]ÙY‰ÊNÂˆ]ØZ]\Ë››İYšXØ][ÛœË˜Ü™X]JÂˆ\Ù\’Yˆ\]Y›İÛ™\’Yˆ]NˆXÚ\Ú[ÛˆOOH	ĞT“Õ‘IÈÈ	İ\]Y]_H™\šYšYYˆ	İ\]Y]_H™YYÈ][[Û˜ˆ›ÙNˆXÚ\Ú[ÛˆOOH	ĞT“Õ‘IÂˆÈ	İ\]Y]_H›Üˆ	İ\]Yœ]S[X™\ŸH\È™\šYšYY˜ˆˆ	İ\]Y]_H›Üˆ	İ\]Yœ]S[X™\ŸHØ\È™Z™XİYˆ	Ú[œ]››İ_XˆÛ™NˆXÚ\Ú[ÛˆOOH	ĞT“Õ‘IÈÈ	ÔÕPĞÑTÔÉÈˆ	ÑS‘ÑT‰Ëˆ[]Nˆ	Õ™ZXÛQØİ[Y[	Ë[]RYˆ\]YšYXİ[Û•\›ˆÛİÛ™\‹İ™ZXÛKYØİ[Y[ËÉİ\]Y™ZXÛRYXˆJK˜Ø]Ú


HOˆ[
NÂˆ™]\›ˆÈYˆ\]YšY™ZXÛRYˆ\]Y™ZXÛRYİ]Nˆ\]Yœİ]KXÚ\Ú[ÛˆNÂˆB‚ˆš]˜]H\Ş[˜È\ÜÙ\™ZXÛSİÛ™\Š™ZXÛRYˆİš[™ËİÛ™\’Yˆİš[™ÊHÂˆÛÛœİ™ZXÛHH]ØZ]\Ëœš\ÛXK™ZXÛK™š[™š\œİ
ÈÚ\™NˆÈYˆ™ZXÛRYİÛ™\’YKÙ[XİˆÈYˆYK]S[X™\ˆYHHJNÂˆYˆ
]™ZXÛJH›İÈ™]È›İ›İ[™^Ù\[ÛŠ	ÕXÚÈ›İ›İ[™›Üˆ\ÈİÛ™\ˆXØÛİ[‰ÊNÂˆ™]\›ˆ™ZXÛNÂˆB‚ˆš]˜]H\Ş[˜È[œİ\™U™ZXÛQ^[œÙSYÙ\Š
HÂˆ]ØZ]\Ëœš\ÛXK‰^Xİ]T˜]Õ[œØY™JˆÜ™X]HX›HYˆ›İ^\İÈ•™ZXÛQ^[œÙHˆ
ˆšYˆ^š[X\HÙ^Kˆ™ZXÛRYˆ^›İ[™Y™\™[˜Ù\È•™ZXÛHŠšYŠHÛˆ[]HØ\ØØYKˆ›İÛ™\’Yˆ^›İ[™Y™\™[˜Ù\È•\Ù\ˆŠšYŠHÛˆ[]HØ\ØØYKˆ˜Ø]YÛÜHˆ^›İ[ˆ˜[[İ[ÛØ›Èˆ[YÙ\ˆ›İ[ˆ™\ØÜš\[Ûˆˆ^ˆœÙ\šXÙQ]Hˆ[Y\İ[\
ÊH›İ[ˆ›ÙÛY]\’ÛHˆ[YÙ\‹ˆœ™XÙZ\\›ˆ^ˆ›™^Ù\šXÙQ]Hˆ[Y\İ[\
ÊKˆ˜Ü™X]Y]ˆ[Y\İ[\
ÊH›İ[Y˜][İ\œ™[İ[Y\İ[\ˆ\]Y]ˆ[Y\İ[\
ÊH›İ[Y˜][İ\œ™[İ[Y\İ[\ˆ
Xˆ
NÂˆ]ØZ]\Ëœš\ÛXK‰^Xİ]T˜]Õ[œØY™J	ØÜ™X]H[™^Yˆ›İ^\İÈ•™ZXÛQ^[œÙWİ™ZXÛRYÜÙ\šXÙQ]WÚYˆÛˆ•™ZXÛQ^[œÙHŠ™ZXÛRY‹œÙ\šXÙQ]HŠIÊNÂˆ]ØZ]\Ëœš\ÛXK‰^Xİ]T˜]Õ[œØY™J	ØÜ™X]H[™^Yˆ›İ^\İÈ•™ZXÛQ^[œÙWÛİÛ™\’YÚYˆÛˆ•™ZXÛQ^[œÙHŠ›İÛ™\’YŠIÊNÂˆB‚ˆ\Ş[˜ÈİÛ™\•™ZXÛR[˜ÛÛYJİÛ™\’Yˆİš[™ÊHÂˆ]ØZ]\Ë™[œİ\™U™ZXÛQ^[œÙSYÙ\Š
NÂˆÛÛœİš]™\”Ú\™T\˜Ù[H]ØZ]\Ë™š]™\”Ù][Y[Ú\™T\˜Ù[

NÂˆÛÛœİ›İÜÈH]ØZ]\Ëœš\ÛXK‰]Y\T˜]Õ[œØY™O\œ˜^OÂˆ™ZXÛRYˆİš[™ÎÈ]S[X™\ˆİš[™ÎÈ\Nˆİš[™ÎÈ™[X\ÙY[˜ÛÛYNˆšYÚ[[X™\Âˆ[™[™Ò[˜ÛÛYNˆšYÚ[[X™\ÈÛÛ\]YØYÎˆšYÚ[[X™\Èİ[^[œÙ\ÎˆšYÚ[[X™\Âˆ™^Ù\šXÙQ]Nˆ]H[ÂˆOŠˆÙ[Xİ‹ˆšYˆ\È™ZXÛRY‹‹ˆœ]S[X™\ˆ‹‹ˆ\H‹ˆÛØ[\ØÙJ
Ù[Xİİ[J›İ[™
Kˆ˜[[İ[›[Y\šXÈ
ˆ
LH	›[Y\šXÊHÈL
JBˆœ›ÛH‘š]™\\ÜÚYÛ›Y[ˆH›Ú[ˆ‘\ØÜ›İÈˆHÛˆKˆœÚ\Y[YˆHKˆœÚ\Y[Y‚ˆÚ\™HKˆ™ZXÛRYˆH‹ˆšYˆ[™Kˆœİ]\ÈˆH	ĞPĞÑTQ	Îˆ\ÜÚYÛ›Y[İ]\È‚ˆ[™Kˆ™š]™\’Yˆˆ‹ˆ›İÛ™\’Yˆ[™Kˆœİ]\ÈˆH	Ô‘SPTÑQ	Îˆ‘\ØÜ›İÔİ]\ÈŠK
H\Èœ™[X\ÙY[˜ÛÛYH‹ˆÛØ[\ØÙJ
Ù[Xİİ[J›İ[™
Kˆ˜[[İ[›[Y\šXÈ
ˆ
LH	›[Y\šXÊHÈL
JBˆœ›ÛH‘š]™\\ÜÚYÛ›Y[ˆH›Ú[ˆ‘\ØÜ›İÈˆHÛˆKˆœÚ\Y[YˆHKˆœÚ\Y[Y‚ˆÚ\™HKˆ™ZXÛRYˆH‹ˆšYˆ[™Kˆœİ]\ÈˆH	ĞPĞÑTQ	Îˆ\ÜÚYÛ›Y[İ]\È‚ˆ[™Kˆ™š]™\’Yˆˆ‹ˆ›İÛ™\’Yˆ[™Kˆœİ]\Èˆ[ˆ
	Ñ•S‘Q	Îˆ‘\ØÜ›İÔİ]\È‹	ÒS	Îˆ‘\ØÜ›İÔİ]\È‹	Ô‘SPTÑWÔ‘PQIÎˆ‘\ØÜ›İÔİ]\ÈŠJK
H\Èœ[™[™Ò[˜ÛÛYH‹ˆ
Ù[XİÛİ[

ŠHœ›ÛH‘š]™\\ÜÚYÛ›Y[ˆH›Ú[ˆ”Ú\Y[ˆÈÛˆËˆšYˆHKˆœÚ\Y[Y‚ˆÚ\™HKˆ™ZXÛRYˆH‹ˆšYˆ[™Kˆœİ]\ÈˆH	ĞPĞÑTQ	Îˆ\ÜÚYÛ›Y[İ]\Èˆ[™Ëˆœİ]\ÈˆH	ĞÓÓTUQ	Îˆ”Ú\Y[İ]\ÈŠH\È˜ÛÛ\]YØYÈ‹ˆÛØ[\ØÙJ
Ù[Xİİ[Jˆ˜[[İ[ÛØ›ÈŠHœ›ÛH•™ZXÛQ^[œÙHˆÚ\™Hˆ™ZXÛRYˆH‹ˆšYŠK
H\Èİ[^[œÙ\È‹ˆ
Ù[XİZ[Šˆ›™^Ù\šXÙQ]HŠHœ›ÛH•™ZXÛQ^[œÙHˆÚ\™Hˆ™ZXÛRYˆH‹ˆšYˆ[™ˆ›™^Ù\šXÙQ]HˆHİ\œ™[İ[Y\İ[\
H\È›™^Ù\šXÙQ]H‚ˆœ›ÛH•™ZXÛHˆˆÚ\™H‹ˆ›İÛ™\’YˆH	HÜ™\ˆH‹ˆ˜Ü™X]Y]ˆ\ØØˆİÛ™\’Yš]™\”Ú\™T\˜Ù[ˆ
NÂˆ™]\›ˆ›İÜË›X\

›İÊHOˆÂˆÛÛœİ™[X\ÙY[˜ÛÛYHH[X™\Š›İËœ™[X\ÙY[˜ÛÛYHÏÈ
NÂˆÛÛœİİ[^[œÙ\ÈH[X™\Š›İËİ[^[œÙ\ÈÏÈ
NÂˆ™]\›ˆÂˆ™ZXÛRYˆ›İË™ZXÛRYˆ]S[X™\ˆ›İËœ]S[X™\‹ˆ\Nˆ›İË\Kˆ™[X\ÙY[˜ÛÛYKˆ™[X\ÙY[˜ÛÛYSX™[ˆ\Ë™›Ü›X][Û™^J™[X\ÙY[˜ÛÛYJKˆ[™[™Ò[˜ÛÛYNˆ[X™\Š›İËœ[™[™Ò[˜ÛÛYHÏÈ
Kˆ[™[™Ò[˜ÛÛYSX™[ˆ\Ë™›Ü›X][Û™^J[X™\Š›İËœ[™[™Ò[˜ÛÛYHÏÈ
JKˆİ[^[œÙ\Ëˆİ[^[œÙ\ÓX™[ˆ\Ë™›Ü›X][Û™^Jİ[^[œÙ\ÊKˆ™][˜ÛÛYNˆ™[X\ÙY[˜ÛÛYHHİ[^[œÙ\Ëˆ™][˜ÛÛYSX™[ˆ\Ë™›Ü›X][Û™^J™[X\ÙY[˜ÛÛYHHİ[^[œÙ\ÊKˆÛÛ\]YØYÎˆ[X™\Š›İË˜ÛÛ\]YØYÈÏÈ
Kˆ™^Ù\šXÙQ]Nˆ›İË›™^Ù\šXÙQ]OËÒTÓÔİš[™Ê
HÏÈ[ˆNÂˆJNÂˆB‚ˆ\Ş[˜È™ZXÛQ^[œÙ\Ê™ZXÛRYˆİš[™ËİÛ™\’Yˆİš[™ÊHÂˆ]ØZ]\Ë˜\ÜÙ\™ZXÛSİÛ™\Š™ZXÛRYİÛ™\’Y
NÂˆ]ØZ]\Ë™[œİ\™U™ZXÛQ^[œÙSYÙ\Š
NÂˆÛÛœİ›İÜÈH]ØZ]\Ëœš\ÛXK‰]Y\T˜]Õ[œØY™O\œ˜^OÂˆYˆİš[™ÎÈ™ZXÛRYˆİš[™ÎÈØ]YÛÜNˆİš[™ÎÈ[[İ[ÛØ›Îˆ[X™\È\ØÜš\[Ûˆİš[™È[ÂˆÙ\šXÙQ]Nˆ]NÈÙÛY]\’ÛNˆ[X™\ˆ[È™XÙZ\\›ˆİš[™È[È™^Ù\šXÙQ]Nˆ]H[ÈÜ™X]Y]ˆ]NÂˆOŠˆÙ[XİšY‹™ZXÛRY‹˜Ø]YÛÜH‹˜[[İ[ÛØ›È‹™\ØÜš\[Ûˆ‹œÙ\šXÙQ]H‹›ÙÛY]\’ÛH‹œ™XÙZ\\›‹›™^Ù\šXÙQ]H‹˜Ü™X]Y]‚ˆœ›ÛH•™ZXÛQ^[œÙHˆÚ\™H™ZXÛRYˆH	H[™›İÛ™\’YˆH	ˆÜ™\ˆHœÙ\šXÙQ]Hˆ\ØË˜Ü™X]Y]ˆ\ØØˆ™ZXÛRYİÛ™\’Yˆ
NÂˆ™]\›ˆ›İÜË›X\

›İÊHOˆ
Âˆ‹‹œ›İËˆ[[İ[X™[ˆ\Ë™›Ü›X][Û™^J›İË˜[[İ[ÛØ›ÊKˆÙ\šXÙQ]Nˆ›İËœÙ\šXÙQ]KÒTÓÔİš[™Ê
Kˆ™^Ù\šXÙQ]Nˆ›İË›™^Ù\šXÙQ]OËÒTÓÔİš[™Ê
HÏÈ[ˆÜ™X]Y]ˆ›İË˜Ü™X]Y]ÒTÓÔİš[™Ê
KˆJJNÂˆB‚ˆ\Ş[˜ÈÜ™X]U™ZXÛQ^[œÙJ™ZXÛRYˆİš[™ËİÛ™\’Yˆİš[™Ë[œ]ˆ™ZXÛQ^[œÙR[œ]
HÂˆÛÛœİ™ZXÛHH]ØZ]\Ë˜\ÜÙ\™ZXÛSİÛ™\Š™ZXÛRYİÛ™\’Y
NÂˆ]ØZ]\Ë™[œİ\™U™ZXÛQ^[œÙSYÙ\Š
NÂˆÛÛœİØ]YÛÜHHİš[™Ê[œ]˜Ø]YÛÜHÏÈ	ÉÊKš[J
KÕ\\Ø\ÙJ
NÂˆÛÛœİ[İÙYØ]YÛÜšY\ÈHÉÑ•QS	Ë	ÔÑT•’PÑIË	Ô‘TRT‰Ë	ÕT‘TÉË	ÒS”ÕTSÑIË	ÕÓ	Ë	ÓÕT‰×NÂˆYˆ
X[İÙYØ]YÛÜšY\Ëš[˜ÛY\ÊØ]YÛÜJJH›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ\ÙHÛ™HÙˆ	Ø[İÙYØ]YÛÜšY\Ëš›Ú[Š	Ë	Ê_K˜
NÂˆÛÛœİ[[İ[ÛØ›ÈH[X™\Š[œ]˜[[İ[ÛØ›ÈÏÈ[œ]˜[[İ[ÏÈ
NÂˆYˆ
S[X™\‹š\Ñš[š]J[[İ[ÛØ›ÊH[[İ[ÛØ›ÈH
H›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	Ñ[\ˆH˜[Y^[œÙH[[İ[‰ÊNÂˆÛÛœİÙ\šXÙQ]HH[œ]œÙ\šXÙQ]HÈ™]È]J[œ]œÙ\šXÙQ]JHˆ™]È]J
NÂˆYˆ
[X™\‹š\Ó˜SŠÙ\šXÙQ]K™Ù][YJ
JJH›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	Ñ[\ˆH˜[Y^[œÙH]K‰ÊNÂˆÛÛœİ™^Ù\šXÙQ]HH[œ]›™^Ù\šXÙQ]HÈ™]È]J[œ]›™^Ù\šXÙQ]JHˆ[ÂˆYˆ
™^Ù\šXÙQ]H	‰ˆ[X™\‹š\Ó˜SŠ™^Ù\šXÙQ]K™Ù][YJ
JJH›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	Ñ[\ˆH˜[Y™^Ù\šXÙH]K‰ÊNÂˆÛÛœİÙÛY]\’ÛHH[œ]›ÙÛY]\’ÛHOOH[™Yš[™YÈ[ˆX]›X^
X]œ›İ[™
[X™\Š[œ]›ÙÛY]\’ÛJJJNÂˆÛÛœİYH^[œÙWÉÜ˜[™ÛUURQ

Kœ™\XÙJËKÙË	ÉÊ_XÂˆÛÛœİ›İÜÈH]ØZ]\Ëœš\ÛXK‰]Y\T˜]Õ[œØY™O\œ˜^OÈYˆİš[™ÎÈØ]YÛÜNˆİš[™ÎÈ[[İ[ÛØ›Îˆ[X™\ÈÙ\šXÙQ]Nˆ]HOŠˆ[œÙ\[È•™ZXÛQ^[œÙHˆ
šY‹™ZXÛRY‹›İÛ™\’Y‹˜Ø]YÛÜH‹˜[[İ[ÛØ›È‹™\ØÜš\[Ûˆ‹œÙ\šXÙQ]H‹›ÙÛY]\’ÛH‹œ™XÙZ\\›‹›™^Ù\šXÙQ]HŠBˆ˜[Y\È
	K	‹	Ë		K	‹	Ë		K	L
Bˆ™]\›š[™ÈšY‹˜Ø]YÛÜH‹˜[[İ[ÛØ›È‹œÙ\šXÙQ]H˜ˆY™ZXÛRYİÛ™\’YØ]YÛÜKX]œ›İ[™
[[İ[ÛØ›ÊK[œ]™\ØÜš\[ÛËš[J
H[Ù\šXÙQ]Kˆ[X™\‹š\Ñš[š]JÙÛY]\’ÛJHÈÙÛY]\’ÛHˆ[[œ]œ™XÙZ\\›Ëš[J
H[™^Ù\šXÙQ]Kˆ
NÂˆ]ØZ]\Ëœš\ÛXK˜]Y]ÙË˜Ü™X]JÂˆ]NˆÈXİÜ’YˆİÛ™\’YXİ[Ûˆ	Õ‘RPÓWÑVS”ÑWÔ‘PÓÔ‘Q	Ë[]Nˆ	Õ™ZXÛIË[]RYˆ™ZXÛRYY]Y]Nˆ\ËÒœÛÛŠÈ^[œÙRYˆYØ]YÛÜK[[İ[ÛØ›ÎˆX]œ›İ[™
[[İ[ÛØ›ÊHJHKˆJK˜Ø]Ú


HOˆ[
NÂˆ™]\›ˆÈ‹‹œ›İÜÖÌK]S[X™\ˆ™ZXÛKœ]S[X™\‹[[İ[X™[ˆ\Ë™›Ü›X][Û™^J[[İ[ÛØ›ÊKÙ\šXÙQ]Nˆ›İÜÖÌOËœÙ\šXÙQ]KÒTÓÔİš[™Ê
HNÂˆB‚ˆ\Ş[˜È[]U™ZXÛQ^[œÙJ™ZXÛRYˆİš[™Ë^[œÙRYˆİš[™ËİÛ™\’Yˆİš[™ÊHÂˆ]ØZ]\Ë˜\ÜÙ\™ZXÛSİÛ™\Š™ZXÛRYİÛ™\’Y
NÂˆ]ØZ]\Ë™[œİ\™U™ZXÛQ^[œÙSYÙ\Š
NÂˆÛÛœİ[]YH]ØZ]\Ëœš\ÛXK‰^Xİ]T˜]Õ[œØY™Jˆ	Ù[]Hœ›ÛH•™ZXÛQ^[œÙHˆÚ\™HšYˆH	H[™™ZXÛRYˆH	ˆ[™›İÛ™\’YˆH	ÉËˆ^[œÙRY™ZXÛRYİÛ™\’Yˆ
NÂˆYˆ
Y[]Y
H›İÈ™]È›İ›İ[™^Ù\[ÛŠ	Ñ^[œÙH™XÛÜ™›İ›İ[™‰ÊNÂˆ™]\›ˆÈYˆ^[œÙRY[]YˆYHNÂˆB‚ˆš]˜]H\Õ™ZXÛQØİ[Y[Ô™XYJØİ[Y[Îˆ\œ˜^OÈ\Nˆİš[™ÎÈİ]Nˆİš[™ÎÈ^\™\Îˆ]Hİš[™È[OŠHÂˆÛÛœİ›İÈH]K››İÊ
NÂˆ™]\›ˆ\Ëœ™\]Z\™Y™ZXÛQØİ[Y[Ë™]™\J
™\]Z\™Y
HOˆØİ[Y[ËœÛÛYJ
Øİ[Y[
HO‚ˆØİ[Y[\HOOH™\]Z\™Y\Bˆ	‰ˆØİ[Y[œİ]HOOH	Õ‘T’Q’QQ	Âˆ	‰ˆ
YØİ[Y[™^\™\È™]È]JØİ[Y[™^\™\ÊK™Ù][YJ
Hˆ›İÊKˆ
JNÂˆB‚ˆËÈÚ]İ]\Ë›È™X[
›Û‹\ÙYY
Hš]™\ˆÛİ[]™\ˆ™HX]ÚYÈHÚ\Y[ˆ›İˆËÈX[X[\Ü]Ú
Ú\Y[ËœÙ\šXÙKÉÜÈÙ™™\\ÜÚYÛ›Y[

JH[™]]ÛX]XÈ™\İ[X]ÚˆËÈÛ›H]™\ˆÛÛœÚY\ˆHš]™\‰ÜÈš]™\•™ZXÛ\Ø™[][Û‹[™›İ[™È[ÙH[ˆH\ˆËÈ]™\ˆÜ›İH™ZXÛK˜\ÜÚYÛ™Yš]™\’YHH™YÚ\İ\™YXÚÈ[™H™\šYšYYš]™\ˆÛİ[ˆËÈ^\İÚYHHÚYH›Ü™]™\ˆÚ]›ÈØ^HÈ[šÈ[K‚ˆ\Ş[˜È›Y]\ÜÚYÛ›Y[Ê
HÂˆHÂˆÛÛœİİ™ZXÛ\Ëš]™\œ×HH]ØZ]›ÛZ\ÙK˜[
Âˆ\Ëœš\ÛXK™ZXÛK™š[™X[JÂˆÚ\™NˆÈ\ĞXİ]™NˆYHKˆ[˜ÛYNˆÂˆİÛ™\ˆÈ[˜ÛYNˆÈ›Ùš[NˆYHHKˆ\ÜÚYÛ™Yš]™\ˆÈ[˜ÛYNˆÈ›Ùš[NˆYHHKˆØİ[Y[ÎˆÈÙ[XİˆÈ\NˆYKİ]NˆYK^\™\ÎˆYHHKˆKˆÜ™\NˆÈÜ™X]Y]ˆ	Ù\ØÉÈKˆZÙNˆŒˆJKˆ\Ëœš\ÛXK\Ù\‹™š[™X[JÂˆÚ\™NˆÈ›ÛNˆ	Ñ’U‘T‰Ë\ĞXİ]™NˆYK™\šYšXØ][Û”İ]\Îˆ	Õ‘T’Q’QQ	ÈKˆ[˜ÛYNˆÂˆ›Ùš[NˆYKˆš]™\•™ZXÛ\ÎˆÈÚ\™NˆÈ\ĞXİ]™NˆYHKÙ[XİˆÈYˆYK]S[X™\ˆYHHKˆKˆÜ™\NˆÈÜ™X]Y]ˆ	Ù\ØÉÈKˆZÙNˆŒˆJKˆJNÂˆ™]\›ˆÂˆ™ZXÛ\Îˆ™ZXÛ\Ë›X\

™ZXÛJHOˆ
ÂˆYˆ™ZXÛKšYˆ]S[X™\ˆ™ZXÛKœ]S[X™\‹ˆ\Nˆ™ZXÛK\KˆØ\XÚ]RÙÎˆ™ZXÛK˜Ø\XÚ]RÙËˆØ\XÚ]SLÎˆ™ZXÛK˜Ø\XÚ]SLËˆİÛ™\’Yˆ™ZXÛK›İÛ™\’YˆİÛ™\“˜[YNˆ™ZXÛK›İÛ™\‹œ›Ùš[OË™[˜[YHÏÈ™ZXÛK›İÛ™\‹™[XZ[ˆØİ[Y[Ô™XYNˆ\Ëš\Õ™ZXÛQØİ[Y[Ô™XYJ™ZXÛK™Øİ[Y[ÊKˆ\ÜÚYÛ™Yš]™\’Yˆ™ZXÛK˜\ÜÚYÛ™Yš]™\’Yˆ\ÜÚYÛ™Yš]™\“˜[YNˆ™ZXÛK˜\ÜÚYÛ™Yš]™\‚ˆÈ
™ZXÛK˜\ÜÚYÛ™Yš]™\‹œ›Ùš[OË™[˜[YHÏÈ™ZXÛK˜\ÜÚYÛ™Yš]™\‹™[XZ[
Bˆˆ[ˆJJKˆš]™\œÎˆš]™\œË›X\

š]™\ŠHOˆ
ÂˆYˆš]™\‹šYˆ[˜[YNˆš]™\‹œ›Ùš[OË™[˜[YHÏÈš]™\‹™[XZ[ˆ[XZ[ˆš]™\‹™[XZ[ˆÛ™Nˆš]™\‹œÛ™Kˆ\ÜÚYÛ™Y™ZXÛRYˆš]™\‹™š]™\•™ZXÛ\ÖÌOËšYÏÈ[ˆ\ÜÚYÛ™Y™ZXÛT]Nˆš]™\‹™š]™\•™ZXÛ\ÖÌOËœ]S[X™\ˆÏÈ[ˆJJKˆNÂˆHØ]Ú
\œ›ÜŠHÂˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İØY›Y]\ÜÚYÛ›Y[ËˆX\ÙHHYØZ[ˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆBˆB‚ˆ\Ş[˜È\ÜÚYÛ‘š]™\•Õ™ZXÛJ™ZXÛRYˆİš[™Ëš]™\’Yˆİš[™ÊHÂˆ™]\›ˆ\Ë˜\ÜÚYÛ‘š]™\•Õ™ZXÛR[\›˜[
™ZXÛRYš]™\’Y	Õ˜ZÛÈÜ\˜][ÛœÉÊNÂˆB‚ˆ\Ş[˜È\ÜÚYÛ‘š]™\•ÓİÛ™Y™ZXÛJ™ZXÛRYˆİš[™Ëš]™\’Yˆİš[™ËİÛ™\’Yˆİš[™ÊHÂˆÛÛœİ™ZXÛHH]ØZ]\Ëœš\ÛXK™ZXÛK™š[™[š\]YJÈÚ\™NˆÈYˆ™ZXÛRYKÙ[XİˆÈİÛ™\’YˆYHHJNÂˆYˆ
]™ZXÛJH›İÈ™]È›İ›İ[™^Ù\[ÛŠ	ÕXÚÈ›İ›İ[™‰ÊNÂˆYˆ
™ZXÛK›İÛ™\’YOOHİÛ™\’Y
H›İÈ™]È›Ü˜šY[‘^Ù\[ÛŠ	Ö[İHØ[ˆÛ›H\ÜÚYÛˆš]™\œÈÈXÚÜÈ]™[Û™ÈÈ[İ\ˆ›Y]‰ÊNÂˆ™]\›ˆ\Ë˜\ÜÚYÛ‘š]™\•Õ™ZXÛR[\›˜[
™ZXÛRYš]™\’Y	ÕHXÚÈİÛ™\‰ÊNÂˆB‚ˆš]˜]H\Ş[˜È\ÜÚYÛ‘š]™\•Õ™ZXÛR[\›˜[
™ZXÛRYˆİš[™Ëš]™\’Yˆİš[™Ë\ÜÚYÛ™YNˆİš[™ÊHÂˆÛÛœİ™ZXÛHH]ØZ]\Ëœš\ÛXK™ZXÛK™š[™[š\]YJÂˆÚ\™NˆÈYˆ™ZXÛRYKˆ[˜ÛYNˆÈØİ[Y[ÎˆÈÙ[XİˆÈ\NˆYKİ]NˆYK^\™\ÎˆYHHHKˆJNÂˆYˆ
]™ZXÛJH›İÈ™]È›İ›İ[™^Ù\[ÛŠ	ÕXÚÈ›İ›İ[™‰ÊNÂˆYˆ
]\Ëš\Õ™ZXÛQØİ[Y[Ô™XYJ™ZXÛK™Øİ[Y[ÊJHÂˆ›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	Õ\ÈXÚÈØ[››İ™H\ÜÚYÛ™Y[[™YÚ\İ˜][Û‹[œİ\˜[˜ÙK[™›ØYÛÜ[™\ÜÈØİ[Y[È\™H™\šYšYY[™İ\œ™[‰ÊNÂˆBˆÛÛœİš]™\ˆH]ØZ]\Ëœš\ÛXK\Ù\‹™š[™[š\]YJÈÚ\™NˆÈYˆš]™\’YHJNÂˆYˆ
Yš]™\ˆš]™\‹œ›ÛHOOH	Ñ’U‘T‰ÈYš]™\‹š\ĞXİ]™Hš]™\‹™\šYšXØ][Û”İ]\ÈOOH	Õ‘T’Q’QQ	ÊHÂˆ›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	ÓÛ›HÖPË]™\šYšYYXİ]™Hš]™\œÈØ[ˆ™H\ÜÚYÛ™YÈHXÚË‰ÊNÂˆB‚ˆÛÛœİ]™P\ÜÚYÛ›Y[H]ØZ]\Ëœš\ÛXK™š]™\\ÜÚYÛ›Y[™š[™š\œİ
ÂˆÚ\™NˆÂˆš]™\’Yˆİ]\ÎˆÈ[ˆÉÓÑ‘‘T‘Q	Ë	ĞPĞÑTQ	×HKˆÚ\Y[ˆÈİ]\ÎˆÈ›İ[ˆÉÑSU‘T‘Q	Ë	ĞÓÓTUQ	Ë	ĞĞSÑSQ	×HHKˆKˆÙ[XİˆÈ™ZXÛRYˆYKÚ\Y[ˆÈÙ[XİˆÈ™Y™\™[˜ÙNˆYHHHKˆÜ™\NˆÈÙ™™\™Y]ˆ	Ù\ØÉÈKˆJNÂˆYˆ
]™P\ÜÚYÛ›Y[	‰ˆ]™P\ÜÚYÛ›Y[™ZXÛRYOOH™ZXÛRY
HÂˆ›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠˆ\Èš]™\ˆ\ÈÛÛ[Z]YÈ	Û]™P\ÜÚYÛ›Y[œÚ\Y[œ™Y™\™[˜Ù_KˆÛÛ\]HÜˆÚ]˜]È]ØY™Y›Ü™HÚ[™Ú[™ÈXÚÜË˜ˆ
NÂˆB‚ˆËÈHš]™\ˆš]™\ÈÛ™HXÚÈ]H[YHHÛX\ˆ[Hİ\ˆ™ZXÛH^HÙ\™HÛˆ™Y›Ü™BˆËÈ[šÚ[™ÈH™]ÈÛ™KÛÈX]Ú[™ÈÙÚXÈ™]™\ˆ\ÈÈ™X\ÛÛˆX›İ]Hš]™\ˆš]š[™È‚ˆËÈ[Ü™H[ˆÛ™HXİ]™H\ÜÚYÛ›Y[Ûİ\˜ÙK‚ˆÛÛœİË\]YHH]ØZ]\Ëœš\ÛXK‰˜[œØXİ[ÛŠÂˆ\Ëœš\ÛXK™ZXÛK\]SX[JÂˆÚ\™NˆÈ\ÜÚYÛ™Yš]™\’Yˆš]™\’YYˆÈ›İˆ™ZXÛRYHKˆ]NˆÈ\ÜÚYÛ™Yš]™\’Yˆ[KˆJKˆ\Ëœš\ÛXK™ZXÛK\]JÈÚ\™NˆÈYˆ™ZXÛRYK]NˆÈ\ÜÚYÛ™Yš]™\’Yˆš]™\’YHJKˆJK˜Ø]Ú

\œ›ÜŠHOˆÂˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İ\ÜÚYÛˆ\Èš]™\ˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆJNÂ‚ˆ]ØZ]›ÛZ\ÙK˜[
Âˆ\Ë››İYšXØ][ÛœË˜Ü™X]JÂˆ\Ù\’Yˆš]™\’Y›ÛNˆ	Ñ’U‘T‰Ë]Nˆ	ÕXÚÈ\ÜÚYÛ™Y	Ëˆ›ÙNˆ[İIİ™H™Y[ˆ\ÜÚYÛ™YÈš]™H	İ\]Yœ]S[X™\ŸKˆ[İHØ[ˆ›İÈ™XÙZ]™HÚ\Y[Ù™™\œË˜ˆÛ™Nˆ	ÔÕPĞÑTÔÉË[]Nˆ	Õ™ZXÛIË[]RYˆ\]YšYXİ[Û•\›ˆ	ËÙš]™\‹Ú›ØœÉËˆJKˆ\Ë››İYšXØ][ÛœË˜Ü™X]JÂˆ\Ù\’Yˆ™ZXÛK›İÛ™\’Y]Nˆ	Ñš]™\ˆ\ÜÚYÛ™YÈ[İ\ˆXÚÉËˆ›ÙNˆ	Ø\ÜÚYÛ™Y_H\ÜÚYÛ™YHš]™\ˆÈ	İ\]Yœ]S[X™\ŸK˜ˆÛ™Nˆ	ÒS‘“ÉË[]Nˆ	Õ™ZXÛIË[]RYˆ\]YšYXİ[Û•\›ˆÛİÛ™\‹İ™ZXÛKYØİ[Y[ËÉİ\]YšYXˆJKˆJNÂ‚ˆ™]\›ˆÈYˆ\]YšY]S[X™\ˆ\]Yœ]S[X™\‹\ÜÚYÛ™Yš]™\’Yˆ\]Y˜\ÜÚYÛ™Yš]™\’YNÂˆB‚ˆ\Ş[˜È[˜\ÜÚYÛ‘š]™\‘œ›ÛU™ZXÛJ™ZXÛRYˆİš[™ÊHÂˆÛÛœİ™ZXÛHH]ØZ]\Ëœš\ÛXK™ZXÛK™š[™[š\]YJÈÚ\™NˆÈYˆ™ZXÛRYHJNÂˆYˆ
]™ZXÛJH›İÈ™]È›İ›İ[™^Ù\[ÛŠ	ÕXÚÈ›İ›İ[™‰ÊNÂˆYˆ
]™ZXÛK˜\ÜÚYÛ™Yš]™\’Y
H™]\›ˆÈYˆ™ZXÛKšY]S[X™\ˆ™ZXÛKœ]S[X™\‹\ÜÚYÛ™Yš]™\’Yˆ[NÂ‚ˆÛÛœİ™]š[İ\Ñš]™\’YH™ZXÛK˜\ÜÚYÛ™Yš]™\’YÂˆÛÛœİ\]YH]ØZ]\Ëœš\ÛXK™ZXÛK\]JÈÚ\™NˆÈYˆ™ZXÛRYK]NˆÈ\ÜÚYÛ™Yš]™\’Yˆ[HJK˜Ø]Ú

\œ›ÜŠHOˆÂˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İ[˜\ÜÚYÛˆ\Èš]™\ˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆJNÂ‚ˆ]ØZ]\Ë››İYšXØ][ÛœË˜Ü™X]JÂˆ\Ù\’Yˆ™]š[İ\Ñš]™\’Y›ÛNˆ	Ñ’U‘T‰Ë]Nˆ	ÕXÚÈ[˜\ÜÚYÛ™Y	Ëˆ›ÙNˆ[İH\™H›ÈÛ™Ù\ˆ\ÜÚYÛ™YÈ	İ\]Yœ]S[X™\ŸK˜ˆÛ™Nˆ	ÕĞT“’S‘ÉË[]Nˆ	Õ™ZXÛIË[]RYˆ\]YšYˆJNÂ‚ˆ™]\›ˆÈYˆ\]YšY]S[X™\ˆ\]Yœ]S[X™\‹\ÜÚYÛ™Yš]™\’Yˆ[NÂˆB‚ˆ\Ş[˜È[˜\ÜÚYÛ‘š]™\‘œ›ÛSİÛ™Y™ZXÛJ™ZXÛRYˆİš[™ËİÛ™\’Yˆİš[™ÊHÂˆÛÛœİ™ZXÛHH]ØZ]\Ëœš\ÛXK™ZXÛK™š[™[š\]YJÈÚ\™NˆÈYˆ™ZXÛRYKÙ[XİˆÈİÛ™\’YˆYHHJNÂˆYˆ
]™ZXÛJH›İÈ™]È›İ›İ[™^Ù\[ÛŠ	ÕXÚÈ›İ›İ[™‰ÊNÂˆYˆ
™ZXÛK›İÛ™\’YOOHİÛ™\’Y
H›İÈ™]È›Ü˜šY[‘^Ù\[ÛŠ	Ö[İHØ[ˆÛ›H[˜\ÜÚYÛˆš]™\œÈœ›ÛHXÚÜÈ]™[Û™ÈÈ[İ\ˆ›Y]‰ÊNÂˆ™]\›ˆ\Ë[˜\ÜÚYÛ‘š]™\‘œ›ÛU™ZXÛJ™ZXÛRY
NÂˆB‚ˆËÈH™X[™XY˜Z[\™H\ÙYÈ™H[™\İ[™İZ\ÚX›Hœ›ÛH››È›İÈY]ˆ
H›Ü›X[İ]BˆËÈ™Y›Ü™HHš]™\ˆ\È]™\ˆİXÚYHØY™]HÙÙÛJHH›İ™[˜XÚÈÈHØ[YH˜ZÙBˆËÈY˜][Ë[˜ÛY[™ÈH˜XœšXØ]Y[Y\™Ù[˜ŞPÛÛXİÛ™H[X™\ˆ]Ø\È™]™\‚ˆËÈXİX[HZ\œËˆH™XY˜Z[\™H›İÈ›İÜÎÈ››È›İÈY]ˆİ[™]\›œÈ™X[ÛÛ[[‚ˆËÈY˜][È›ÜˆH›ÛÛX[œÈ
X]Ú\ÈØY™]TÙ][™ÜÉÈXİX[ØÚ[XHY˜][ÈH\ÂˆËÈ\Û‰İ˜ZÚ[™È]K]	ÜÈÚ]Hœ™\Ú›İÈÛİ[Ù[Z[™[HÛÛZ[ŠK][ˆÛ™\İˆËÈ[›Üˆ[Y\™Ù[˜ŞPÛÛXİ[œİXYÙˆ[™[[™ÈÛ™K‚ˆ\Ş[˜ÈØY™]TÙ][™ÜÊ\Ù\’Yˆİš[™ÊHÂˆHÂˆÛÛœİ›İÜÈH]ØZ]\Ëœš\ÛXK‰]Y\T˜]Õ[œØY™OˆÈ]˜Z[X›Q›Ü\ÜÚYÛ›Y[Îˆ›ÛÛX[ÈÚ\™S]™Uš\ØØ][Ûˆ›ÛÛX[ÈšYÚš]š[™ĞÚXÚÒ[œÎˆ›ÛÛX[È[Y\™Ù[˜ŞPÛÛXİˆİš[™È[V×BˆŠˆ	ÜÙ[Xİ˜]˜Z[X›Q›Ü\ÜÚYÛ›Y[È‹œÚ\™S]™Uš\ØØ][Ûˆ‹›šYÚš]š[™ĞÚXÚÒ[œÈ‹™[Y\™Ù[˜ŞPÛÛXİˆœ›ÛH”ØY™]TÙ][™ÜÈˆÚ\™H\Ù\’YˆH	H[Z]IËˆ\Ù\’Yˆ
NÂˆYˆ
›İÜÖÌJH™]\›ˆ›İÜÖÌNÂˆHØ]Ú
\œ›ÜŠHÂˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İØYØY™]HÙ][™ÜÎˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆB‚ˆ™]\›ˆÂˆ]˜Z[X›Q›Ü\ÜÚYÛ›Y[ÎˆYKˆÚ\™S]™Uš\ØØ][ÛˆYKˆšYÚš]š[™ĞÚXÚÒ[œÎˆYKˆ[Y\™Ù[˜ŞPÛÛXİˆ[ˆNÂˆB‚ˆ\Ş[˜È\]TØY™]TÙ][™Ê[œ]ˆÈÙ^OÎˆİš[™ÎÈ˜[YOÎˆ›ÛÛX[ˆİš[™ÈK\Ù\’Yˆİš[™ÊHÂˆËÈ\È™]™\ˆXİX[HÜ›İHÈH]X˜\ÙHH]\İXÚÙY˜XÚÂˆËÈÈ‹‹˜İ\œ™[Ù][™ÜËÚÙ^WNˆ˜[YHH\ÈYˆ]YØ]™YÛÈHš]™\‰ÜÈØY™]BˆËÈÙÙÛ\È
]™HØØ][ÛˆÚ\š[™ËšYÚYš]š[™ÈÚXÚËZ[œË[Y\™Ù[˜ŞHÛÛXİ
H™\Ù]ˆËÈH[ÛY[^H™[ØYYH\›ÈX]\ˆİÈX[H[Y\È^HÚ[™ÙY[K‚ˆÛÛœİÙ^HHİš[™Ê[œ]šÙ^HÏÈ	ÜÚ\™S]™Uš\ØØ][Û‰ÊNÂˆÛÛœİ˜[YÙ^\ÈHÉØ]˜Z[X›Q›Ü\ÜÚYÛ›Y[ÉË	ÜÚ\™S]™Uš\ØØ][Û‰Ë	ÛšYÚš]š[™ĞÚXÚÒ[œÉË	Ù[Y\™Ù[˜ŞPÛÛXİ	×NÂˆYˆ
]˜[YÙ^\Ëš[˜ÛY\ÊÙ^JJHÂˆ›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ[šÛ›İÛˆØY™]HÙ][™Îˆ	ÚÙ^_X
NÂˆB‚ˆÛÛœİİ\œ™[H
]ØZ]\ËœØY™]TÙ][™ÜÊ\Ù\’Y
JH\ÈÂˆ]˜Z[X›Q›Ü\ÜÚYÛ›Y[Îˆ›ÛÛX[ÂˆÚ\™S]™Uš\ØØ][Ûˆ›ÛÛX[ÂˆšYÚš]š[™ĞÚXÚÒ[œÎˆ›ÛÛX[Âˆ[Y\™Ù[˜ŞPÛÛXİˆİš[™È[ÂˆNÂˆÛÛœİ™^HÈ‹‹˜İ\œ™[ÚÙ^WNˆ[œ]˜[YHNÂ‚ˆHÂˆ]ØZ]\Ëœš\ÛXK‰^Xİ]T˜]Õ[œØY™Jˆ[œÙ\[È”ØY™]TÙ][™ÜÈˆ
šY‹\Ù\’Y‹˜]˜Z[X›Q›Ü\ÜÚYÛ›Y[È‹œÚ\™S]™Uš\ØØ][Ûˆ‹›šYÚš]š[™ĞÚXÚÒ[œÈ‹™[Y\™Ù[˜ŞPÛÛXİ‹\]Y]ŠBˆ˜[Y\È
	K	‹	Ë		K	‹İ\œ™[İ[Y\İ[\
BˆÛˆÛÛ™›Xİ
\Ù\’YŠHÈ\]HÙ]ˆ˜]˜Z[X›Q›Ü\ÜÚYÛ›Y[ÈˆH^ÛYYˆ˜]˜Z[X›Q›Ü\ÜÚYÛ›Y[È‹ˆœÚ\™S]™Uš\ØØ][ÛˆˆH^ÛYYˆœÚ\™S]™Uš\ØØ][Ûˆ‹ˆ›šYÚš]š[™ĞÚXÚÒ[œÈˆH^ÛYYˆ›šYÚš]š[™ĞÚXÚÒ[œÈ‹ˆ™[Y\™Ù[˜ŞPÛÛXİˆH^ÛYYˆ™[Y\™Ù[˜ŞPÛÛXİ‹ˆ\]Y]ˆHİ\œ™[İ[Y\İ[\ˆØY™]WÉÜ˜[™ÛUURQ

Kœ™\XÙJËKÙË	ÉÊ_Xˆ\Ù\’Yˆ›ÛÛX[Š™^˜]˜Z[X›Q›Ü\ÜÚYÛ›Y[ÊKˆ›ÛÛX[Š™^œÚ\™S]™Uš\ØØ][ÛŠKˆ›ÛÛX[Š™^›šYÚš]š[™ĞÚXÚÒ[œÊKˆ™^™[Y\™Ù[˜ŞPÛÛXİÈİš[™Ê™^™[Y\™Ù[˜ŞPÛÛXİ
Hˆ[ˆ
NÂˆHØ]Ú
\œ›ÜŠHÂˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İØ]™H\ÈØY™]HÙ][™ËˆX\ÙHHYØZ[ˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆB‚ˆ™]\›ˆ™^ÂˆB‚ˆ\Ş[˜È\]Qš]™\]˜Z[Xš[]SØØ][ÛŠˆ\Ù\’Yˆİš[™Ëˆ[œ]ˆÈ]]YOÎˆ[X™\ÈÛ™Ú]YOÎˆ[X™\ˆKˆ
HÂˆÛÛœİ]]YHH[X™\Š[œ]›]]YJNÂˆÛÛœİÛ™Ú]YHH[X™\Š[œ]›Û™Ú]YJNÂˆYˆ
S[X™\‹š\Ñš[š]J]]YJH]]YHNL]]YHˆL
HÂˆ›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	ĞH˜[Y]]YH\È™\]Z\™Y‰ÊNÂˆBˆYˆ
S[X™\‹š\Ñš[š]JÛ™Ú]YJHÛ™Ú]YHLNÛ™Ú]YHˆN
HÂˆ›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	ĞH˜[YÛ™Ú]YH\È™\]Z\™Y‰ÊNÂˆB‚ˆHÂˆÛÛœİ›İÜÈH]ØZ]\Ëœš\ÛXK‰]Y\T˜]Õ[œØY™O\œ˜^OÂˆ]˜Z[X›Q›Ü\ÜÚYÛ›Y[Îˆ›ÛÛX[Âˆ\İÛ›İÛ“]]YNˆ[X™\Âˆ\İÛ›İÛ“Û™Ú]YNˆ[X™\ÂˆØØ][Û•\]Y]ˆ]NÂˆOŠˆ[œÙ\[È”ØY™]TÙ][™ÜÈˆ
šY‹\Ù\’Y‹›\İÛ›İÛ“]]YH‹›\İÛ›İÛ“Û™Ú]YH‹›ØØ][Û•\]Y]‹\]Y]ŠBˆ˜[Y\È
	K	‹	Ë	İ\œ™[İ[Y\İ[\İ\œ™[İ[Y\İ[\
BˆÛˆÛÛ™›Xİ
\Ù\’YŠHÈ\]HÙ]ˆ›\İÛ›İÛ“]]YHˆH^ÛYYˆ›\İÛ›İÛ“]]YH‹ˆ›\İÛ›İÛ“Û™Ú]YHˆH^ÛYYˆ›\İÛ›İÛ“Û™Ú]YH‹ˆ›ØØ][Û•\]Y]ˆHİ\œ™[İ[Y\İ[\ˆ\]Y]ˆHİ\œ™[İ[Y\İ[\ˆ™]\›š[™È˜]˜Z[X›Q›Ü\ÜÚYÛ›Y[È‹›\İÛ›İÛ“]]YH‹›\İÛ›İÛ“Û™Ú]YH‹›ØØ][Û•\]Y]˜ˆØY™]WÉÜ˜[™ÛUURQ

Kœ™\XÙJËKÙË	ÉÊ_Xˆ\Ù\’Yˆ]]YKˆÛ™Ú]YKˆ
NÂˆ™]\›ˆ›İÜÖÌNÂˆHØ]Ú
\œ›ÜŠHÂˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İ\]Hš]™\ˆØØ][Ûˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆBˆB‚ˆËÈ\]T]›Ü›TÙ][™Ê
H\ÙYÈ\İXÚÈÈ‹‹™Y˜][Ë˜[YNˆ›ÙK˜[YHXİ˜ZYÚˆËÈ˜XÚÈÈHØ[\ˆÚ]›È]X˜\ÙHÜš]H][H[ˆYZ[ˆÙÙÛ[™ÈK™ËˆXZ[[˜[˜ÙBˆËÈ[ÙHØ]È]œØ]™H‹]H™\H™^ØY™]™\YÈ\È\™ÛÙYY˜][ˆ\ÙBˆËÈ\™H›İÈ™X[\œÚ\İY]Y][ÙÙÙY›İÜËˆ›İNˆ\œÚ\İ[™ÈH˜[YH\ÈHÚÛHÙ‚ˆËÈ\Èš^HXİX[H[™›Ü˜Ú[™ÈÚ]XXÚ›YÈYX[œÈ
›ØÚÚ[™ÈÚYÛ\ËÚİÚ[™ÈBˆËÈXZ[[˜[˜ÙH˜[›™\‹™\]Z\š[™ÈİY™ˆ‘KÚÚ\[™ÈX[X[ÖPÈ™]šY]ÊH\ÈÙ\\˜]KˆËÈ\™Ù\ˆÛÜšÈ›İ[™È[ˆHÛÙX˜\ÙHİ\œ™[H™XYÈ\ÙH›YÜÈÈXİÛ‹‚ˆš]˜]H™XYÛ›H]›Ü›TÙ][™ĞØ][ÙÎˆÂˆÙ^Nˆİš[™ÎÂˆ]Nˆİš[™ÎÂˆ\ØÜš\[Ûˆİš[™ÎÂˆX™[ˆİš[™ÎÂˆY˜][˜[YNˆİš[™ÎÂˆ[\ˆİš[™ÎÂˆ\Nˆ	Û[X™\‰È	İ^	È	Ø›ÛÛX[‰ÎÂˆZ[Îˆ[X™\ÂˆX^Îˆ[X™\Âˆ][[[™OÎˆ›ÛÛX[ÂˆV×HHÂˆÈÙ^Nˆ	Ù™YIË]Nˆ	Ô]›Ü›H™YIË\ØÜš\[Ûˆ	ÑY˜][]›Ü›HÛÛ[Z\ÜÚ[Ûˆ\YYÈ™]ÈÚ\Y[Ë‰ËX™[ˆ	Ñ™YH
	JIËY˜][˜[YNˆ	ÍËIË[\ˆ	Ğ\Y\ÈÈ™]ÛHÜ™X]YÚ\Y[ÈÛ›NÈÚ\Y[È[™XYH[ˆ›ÙÜ™\ÜÈÙY\Z\ˆÜšYÚ[˜[˜]K‰Ë\Nˆ	Û[X™\‰ÈKˆÈÙ^Nˆ	ÜšXÚ[™ÔÙ\šXÙQ™YT\˜Ù[	Ë]Nˆ	Ô][İHÙ\šXÙH™YIË\ØÜš\[Ûˆ	ÔÙ\šXÙH[™\ØÜ›İÈ™YH[˜ÛYY[ˆ™]Èİ\İÛY\ˆ][İ\Ë‰ËX™[ˆ	ÔÙ\šXÙH™YH
	JIËY˜][˜[YNˆ	ÌËIË[\ˆ	Ğ[İÙY˜[™ÙNˆLŒ	Kˆ^\İ[™ÈÚ\Y[][İ\È™[XZ[ˆ[˜Ú[™ÙY‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆŒKˆÈÙ^Nˆ	ÜšXÚ[™ÑY[İ\˜Ú\™ÙT\˜Ù[	Ë]Nˆ	ÑY[İ\˜Ú\™ÙIË\ØÜš\[Ûˆ	ÑY[Y\İY[\YYÈH\İ[˜ÙKX˜\ÙY[™KZ][Ú\™ÙK‰ËX™[ˆ	ÑY[İ\˜Ú\™ÙH
	JIËY˜][˜[YNˆ	Ì	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆML	KˆÙ]ÈÚ[ˆ›Èİ\˜Ú\™ÙH\È™\]Z\™Y‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆLKˆÈÙ^Nˆ	ÜšXÚ[™ÕÛ[İØ[˜ÙS™Û‰Ë]Nˆ	ÕÛ[İØ[˜ÙIË\ØÜš\[Ûˆ	Ñ›]Û[™›İ]H[İØ[˜ÙH[˜ÛYY[ˆ]™\H™]È][İK‰ËX™[ˆ	Ğ[İØ[˜ÙH
‘ÓŠIËY˜][˜[YNˆ	Ì	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆML\ˆÚ\Y[‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆLKˆÈÙ^Nˆ	ÜšXÚ[™Ñ[X[™İ\™ÙT\˜Ù[	Ë]Nˆ	Ñ[X[™Y\İY[	Ë\ØÜš\[Ûˆ	Õ[\Ü˜\H™]ÛÜšÈ[X[™Y\İY[\YYÈ™]È][İ\Ë‰ËX™[ˆ	Ñ[X[™Y\İY[
	JIËY˜][˜[YNˆ	Ì	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆML	KˆÙY\]\š[™È›Ü›X[[X[™‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆLKˆÈÙ^Nˆ	ÜšXÚ[™Ô][İU˜[Y]SZ[]\ÉË]Nˆ	Ô][İH˜[Y]IË\ØÜš\[Ûˆ	ÒİÈÛ™ÈHİ\İÛY\ˆ][İH™[XZ[œÈ˜[Y™Y›Ü™H]]\İ™H™XØ[İ[]Y‰ËX™[ˆ	Õ˜[Y]H
Z[]\ÊIËY˜][˜[YNˆ	ÌÌ	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆKLZ[]\Ë‰Ë\Nˆ	Û[X™\‰ËZ[ˆKX^ˆKˆÈÙ^Nˆ	Ùš]™\“Ù™™\•˜[Y]SZ[]\ÉË]Nˆ	Ñš]™\ˆÙ™™\ˆ˜[Y]IË\ØÜš\[Ûˆ	ÒİÈÛ™ÈHš]™\ˆ\ÈÈXØÙ\ÜˆXÛ[™HHÚ\Y[Ù™™\‹‰ËX™[ˆ	Õ˜[Y]H
Z[]\ÊIËY˜][˜[YNˆ	ÌMIË[\ˆ	Ğ[İÙY˜[™ÙNˆKLLŒZ[]\Ëˆ^\™YÙ™™\œÈ™]\›ˆÈ\Ü]Ú›Üˆ™X\ÜÚYÛ›Y[‰Ë\Nˆ	Û[X™\‰ËZ[ˆKX^ˆLŒKˆÈÙ^Nˆ	ÜšXÚ[™Ñ›]™Y˜\ÙQ˜\™S™Û‰Ë]Nˆ	Ñ›]™Y˜\ÙH˜\™IË\ØÜš\[Ûˆ	Ôİ\[™ÈÚ\™ÙH›ÜˆH›]™YÚ\Y[‰ËX™[ˆ	Ğ˜\ÙH˜\™H
‘ÓŠIËY˜][˜[YNˆ	ÍML	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆL‹‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆŒKˆÈÙ^Nˆ	ÜšXÚ[™Ñ›]™Y\’ÛT˜]S™Û‰Ë]Nˆ	Ñ›]™YÚ[ÛY]™H˜]IË\ØÜš\[Ûˆ	Ñ\İ[˜ÙH˜]H›Üˆ›]™YÚ\Y[Ë‰ËX™[ˆ	Ô˜]H\ˆÛH
‘ÓŠIËY˜][˜[YNˆ	ÍÌŒ	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆLLL\ˆÛK‰Ë\Nˆ	Û[X™\‰ËZ[ˆLX^ˆLKˆÈÙ^Nˆ	ÜšXÚ[™Ñ›]™YZ[š[][Q˜\™S™Û‰Ë]Nˆ	Ñ›]™YZ[š[][H˜\™IË\ØÜš\[Ûˆ	ÓİÙ\İ\›Z]Y][İH›ÜˆH›]™YÚ\Y[‰ËX™[ˆ	ÓZ[š[][H˜\™H
‘ÓŠIËY˜][˜[YNˆ	ÎML	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆL‹‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆŒKˆÈÙ^Nˆ	ÜšXÚ[™Ğ›Ş˜\ÙQ˜\™S™Û‰Ë]Nˆ	Ğ›ŞXÚÈ˜\ÙH˜\™IË\ØÜš\[Ûˆ	Ôİ\[™ÈÚ\™ÙH›ÜˆH›ŞXÚÈÚ\Y[‰ËX™[ˆ	Ğ˜\ÙH˜\™H
‘ÓŠIËY˜][˜[YNˆ	ÍL	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆL‹‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆŒKˆÈÙ^Nˆ	ÜšXÚ[™Ğ›Ş\’ÛT˜]S™Û‰Ë]Nˆ	Ğ›ŞXÚÈÚ[ÛY]™H˜]IË\ØÜš\[Ûˆ	Ñ\İ[˜ÙH˜]H›Üˆ›ŞXÚÈÚ\Y[Ë‰ËX™[ˆ	Ô˜]H\ˆÛH
‘ÓŠIËY˜][˜[YNˆ	Í	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆLLL\ˆÛK‰Ë\Nˆ	Û[X™\‰ËZ[ˆLX^ˆLKˆÈÙ^Nˆ	ÜšXÚ[™Ğ›ŞZ[š[][Q˜\™S™Û‰Ë]Nˆ	Ğ›ŞXÚÈZ[š[][H˜\™IË\ØÜš\[Ûˆ	ÓİÙ\İ\›Z]Y][İH›ÜˆH›ŞXÚÈÚ\Y[‰ËX™[ˆ	ÓZ[š[][H˜\™H
‘ÓŠIËY˜][˜[YNˆ	ÎL	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆL‹‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆŒKˆÈÙ^Nˆ	ÜšXÚ[™Õ\\˜\ÙQ˜\™S™Û‰Ë]Nˆ	Õ\\ˆ˜\ÙH˜\™IË\ØÜš\[Ûˆ	Ôİ\[™ÈÚ\™ÙH›ÜˆH\\ˆÚ\Y[‰ËX™[ˆ	Ğ˜\ÙH˜\™H
‘ÓŠIËY˜][˜[YNˆ	ÍŒ	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆL‹‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆŒKˆÈÙ^Nˆ	ÜšXÚ[™Õ\\”\’ÛT˜]S™Û‰Ë]Nˆ	Õ\\ˆÚ[ÛY]™H˜]IË\ØÜš\[Ûˆ	Ñ\İ[˜ÙH˜]H›Üˆ\\ˆÚ\Y[Ë‰ËX™[ˆ	Ô˜]H\ˆÛH
‘ÓŠIËY˜][˜[YNˆ	ÍÍŒ	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆLLL\ˆÛK‰Ë\Nˆ	Û[X™\‰ËZ[ˆLX^ˆLKˆÈÙ^Nˆ	ÜšXÚ[™Õ\\“Z[š[][Q˜\™S™Û‰Ë]Nˆ	Õ\\ˆZ[š[][H˜\™IË\ØÜš\[Ûˆ	ÓİÙ\İ\›Z]Y][İH›ÜˆH\\ˆÚ\Y[‰ËX™[ˆ	ÓZ[š[][H˜\™H
‘ÓŠIËY˜][˜[YNˆ	ÌL	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆL‹‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆŒKˆÈÙ^Nˆ	ÜšXÚ[™Õ[šÙ\˜\ÙQ˜\™S™Û‰Ë]Nˆ	Õ[šÙ\ˆ˜\ÙH˜\™IË\ØÜš\[Ûˆ	Ôİ\[™ÈÚ\™ÙH›ÜˆH[šÙ\ˆÚ\Y[‰ËX™[ˆ	Ğ˜\ÙH˜\™H
‘ÓŠIËY˜][˜[YNˆ	ÍÌ	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆL‹‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆŒKˆÈÙ^Nˆ	ÜšXÚ[™Õ[šÙ\”\’ÛT˜]S™Û‰Ë]Nˆ	Õ[šÙ\ˆÚ[ÛY]™H˜]IË\ØÜš\[Ûˆ	Ñ\İ[˜ÙH˜]H›Üˆ[šÙ\ˆÚ\Y[Ë‰ËX™[ˆ	Ô˜]H\ˆÛH
‘ÓŠIËY˜][˜[YNˆ	ÎŒ	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆLLL\ˆÛK‰Ë\Nˆ	Û[X™\‰ËZ[ˆLX^ˆLKˆÈÙ^Nˆ	ÜšXÚ[™Õ[šÙ\“Z[š[][Q˜\™S™Û‰Ë]Nˆ	Õ[šÙ\ˆZ[š[][H˜\™IË\ØÜš\[Ûˆ	ÓİÙ\İ\›Z]Y][İH›ÜˆH[šÙ\ˆÚ\Y[‰ËX™[ˆ	ÓZ[š[][H˜\™H
‘ÓŠIËY˜][˜[YNˆ	ÌLML	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆL‹‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆŒKˆÈÙ^Nˆ	ÜšXÚ[™Ôİ[™\™˜\ÙQ˜\™S™Û‰Ë]Nˆ	Ôİ[™\™XÚÈ˜\ÙH˜\™IË\ØÜš\[Ûˆ	Ôİ\[™ÈÚ\™ÙH›ÜˆHİ[™\™XÚÈÚ\Y[‰ËX™[ˆ	Ğ˜\ÙH˜\™H
‘ÓŠIËY˜][˜[YNˆ	ÍL	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆL‹‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆŒKˆÈÙ^Nˆ	ÜšXÚ[™Ôİ[™\™\’ÛT˜]S™Û‰Ë]Nˆ	Ôİ[™\™XÚÈÚ[ÛY]™H˜]IË\ØÜš\[Ûˆ	Ñ\İ[˜ÙH˜]H›Üˆİ[™\™XÚÈÚ\Y[Ë‰ËX™[ˆ	Ô˜]H\ˆÛH
‘ÓŠIËY˜][˜[YNˆ	ÍÌ	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆLLL\ˆÛK‰Ë\Nˆ	Û[X™\‰ËZ[ˆLX^ˆLKˆÈÙ^Nˆ	ÜšXÚ[™Ôİ[™\™Z[š[][Q˜\™S™Û‰Ë]Nˆ	Ôİ[™\™XÚÈZ[š[][H˜\™IË\ØÜš\[Ûˆ	ÓİÙ\İ\›Z]Y][İH›ÜˆHİ[™\™XÚÈÚ\Y[‰ËX™[ˆ	ÓZ[š[][H˜\™H
‘ÓŠIËY˜][˜[YNˆ	ÎL	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆ‘ÓˆL‹‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆŒKˆÈÙ^Nˆ	Ü^[İ]	Ë]Nˆ	Ô^[İ]ØÚY[IË\ØÜš\[Ûˆ	ÒİÈÙ[ˆš]™\ˆ^[İ]™\]Y\İÈ\™H™]šY]ÙY›Üˆ™[X\ÙK‰ËX™[ˆ	ÔØÚY[IËY˜][˜[YNˆ	İÙYZÛIË[\ˆ	ĞXØÙ\Y˜[Y\ÎˆZ[KÙYZÛKš]ÙYZÛK[ÛK‰Ë\Nˆ	İ^	ÈKˆÈÙ^Nˆ	Ùš]™\“İÛ™\”Ú\™T\˜Ù[	Ë]Nˆ	Ñš]™\ˆÙ][Y[Ú\™IË\ØÜš\[Ûˆ	Ô\˜Ù[YÙHÙˆ™[X\ÙY˜[œÜÜ[˜ÛÛYHZYÈHš]™\ˆÚ[ˆHÙ\\˜]HXÚÈİÛ™\ˆİ\Y\ÈH™ZXÛK‰ËX™[ˆ	Ñš]™\ˆÚ\™H
	JIËY˜][˜[YNˆ	ÍÌ	Ë[\ˆ	Ğ[İÙY˜[™ÙNˆLL	KˆHXÚÈİÛ™\ˆ™XÙZ]™\ÈH™[XZ[™\‹ˆš]™\œÈ\Ú[™ÈZ\ˆİÛˆXÚÈ™XÙZ]™HL	K‰Ë\Nˆ	Û[X™\‰ËZ[ˆX^ˆLKˆÈÙ^Nˆ	Ù\ØÜ›İÉË]Nˆ	Ñ\ØÜ›İÈ™[X\ÙHÚ[™İÉË\ØÜš\[Ûˆ	Ò[[™Y^\ÈY\ˆ[]™\HÛÛ™š\›X][Ûˆ™Y›Ü™H\ØÜ›İÈ]]Ë\™[X\Ù\ÈYˆ[™\Ü]Y‰ËX™[ˆ	Ñ^\ÉËY˜][˜[YNˆ	ÌÉË[\ˆ	Ô™XÛÜ™Y›Üˆ™Y™\™[˜ÙHH\™H\È›ÈØÚY[Y›ØˆY]È]]Ë\™[X\ÙHY\ˆ\ÈX[H^\Ëˆİ\İÛY\œÈØ[ˆÛÛ™š\›H[]™\HX[X[HÈ™[X\ÙH[™È›İË[™Ü\˜][ÛœÈØ[ˆ™[X\ÙKÜ™Y[™œ›ÛHH\Ü]H]Y]YH][H[YK‰Ë\Nˆ	Û[X™\‰ÈKˆÈÙ^Nˆ	ÛX[X[š]™\•™\šYšXØ][Û‰Ë]Nˆ	ÓX[X[š]™\ˆ™\šYšXØ][Û‰Ë\ØÜš\[Ûˆ	Ô™\]Z\™H[ˆYZ[ˆÈX[X[H™]šY]È]™\Hš]™\ˆÖPÈİX›Z\ÜÚ[Û‹‰ËX™[ˆ	ÓX[X[š]™\ˆ™\šYšXØ][Û‰ËY˜][˜[YNˆ	İYIË[\ˆ	Ô™XÛÜ™Y›Üˆ™Y™\™[˜ÙHHÖPÈ™]šY]È\Èİ\œ™[H[Ø^\ÈX[X[™YØ\™\ÜÈÙˆ\È›YË‰Ë\Nˆ	Ø›ÛÛX[‰ÈKˆÈÙ^Nˆ	ÜİY™Œ™˜IË]Nˆ	Ô™\]Z\™HİY™ˆ‘IË\ØÜš\[Ûˆ	Ô™\]Z\™HÛËY˜XİÜˆ]][XØ][Ûˆ›ÜˆYZ[ˆ[™\Ü]Ú\ˆXØÛİ[Ë‰ËX™[ˆ	Ô™\]Z\™HİY™ˆ‘IËY˜][˜[YNˆ	Ù˜[ÙIË[\ˆ	Ô™XÛÜ™Y›Üˆ™Y™\™[˜ÙHHÙÚ[ˆÙ\È›İY][™›Ü˜ÙH‘H™YØ\™\ÜÈÙˆ\È›YË‰Ë\Nˆ	Ø›ÛÛX[‰ÈKˆÈÙ^Nˆ	Ü]\ÙT™YÚ\İ˜][ÛœÉË]Nˆ	Ô]\ÙH™]È™YÚ\İ˜][ÛœÉË\ØÜš\[Ûˆ	Õ[\Ü˜\š[HİÜ™]Èİ\İÛY\‹š]™\‹[™XÚÈİÛ™\ˆÚYÛ‹]\Ë‰ËX™[ˆ	Ô]\ÙH™]È™YÚ\İ˜][ÛœÉËY˜][˜[YNˆ	Ù˜[ÙIË[\ˆ	Ğ›ØÚÜÈ›İHÕ™\]Y\İ[™XØÛİ[Ü™X][Ûˆİ\È›Üˆ™]ÈÚYÛ‹]\ÈÚ[HÛ‹ˆ^\İ[™ÈXØÛİ[ÈØ[ˆİ[ÙÈ[‹‰Ë\Nˆ	Ø›ÛÛX[‰ÈKˆÈÙ^Nˆ	ÛXZ[[˜[˜ÙS[ÙIË]Nˆ	ÓXZ[[˜[˜ÙH[ÙIË\ØÜš\[Ûˆ	Ğ›ØÚÈ™]ÈÚ\Y[Ü™X][Ûˆ™]ÛÜšË]ÚYHÚ[HÛ‹‰ËX™[ˆ	ÓXZ[[˜[˜ÙH[ÙIËY˜][˜[YNˆ	Ù˜[ÙIË[\ˆ	Ğ›ØÚÜÈ™]ÈÚ\Y[Ü™X][ÛˆÚ]HÛX\ˆY\ÜØYÙHÚ[HÛ‹ˆ^\İ[™ÈÚ\Y[Ë˜XÚÚ[™ËY\ÜØYÚ[™Ë[™ÙÚ[ˆ\™H[˜Y™™XİYH\ÈÙ\È›İZÙHHÚÛH\İÛ‹‰Ë\Nˆ	Ø›ÛÛX[‰ÈKˆÈÙ^Nˆ	Üİ\Üİ\œÉË]Nˆ	Ôİ\Üİ\œÉË\ØÜš\[Ûˆ	Ñ\Ü^YYÈİ\İÛY\œÈÛˆH[	ˆİ\ÜØÜ™Y[‹‰ËX™[ˆ	Òİ\œÉËY˜][˜[YNˆ	ÌÍÉË[\ˆ	Ñœ™YH^K™Ëˆ“[Û‹TØ][KNHĞU‹‰Ë\Nˆ	İ^	ÈKˆ‹‹““ÕQ’PĞUSÓ—ÕSTUTË›X\

[\]JHOˆ
ÂˆÙ^Nˆ[\]KšÙ^Kˆ]Nˆ[\]K]Kˆ\ØÜš\[Ûˆ[\]K™\ØÜš\[Û‹ˆX™[ˆ	ÓY\ÜØYÙIËˆY˜][˜[YNˆ[\]K™Y˜][›ÙKˆ[\ˆ[\]KœXÙZÛ\œË›[™İˆÈXÙZÛ\œÈ[İHØ[ˆ\ÙNˆ	İ[\]KœXÙZÛ\œË›X\

˜[YJHOˆÉÛ˜[Y__X
Kš›Ú[Š	Ë	Ê_KˆX]™H›[šÈÈ\ÙHHY˜][Y\ÜØYÙK˜ˆˆ	ÔZ[ˆ^ˆX]™H›[šÈÈ\ÙHHY˜][Y\ÜØYÙK‰Ëˆ\Nˆ	İ^	È\ÈÛÛœİˆ][[[™NˆYKˆJJKˆNÂ‚ˆËÈYZ[‹XÜ™X]YXØÛİ[È
İY™ˆÜˆİ\Ú\ÙJKˆ[YØ]\ÈÈ]]Ù\šXÙKÚXÚˆËÈİÛœÈ\ÜİÛÜ™\Ú[™È[™HÙ]^[İ\‹\\ÜİÛÜ™[XZ[‚ˆÜ™X]U\Ù\PYZ[ŠXİÜ’Yˆİš[™Ë[œ]ˆÈ[˜[YOÎˆİš[™ÎÈ[XZ[Îˆİš[™ÎÈÛ™OÎˆİš[™ÎÈ›ÛOÎˆİš[™ÈJHÂˆ™]\›ˆ\Ë˜]]˜Ü™X]U\Ù\PYZ[ŠXİÜ’Y[œ]
NÂˆB‚ˆ[]U\Ù\PYZ[ŠXİÜ’Yˆİš[™Ë\Ù\’Yˆİš[™ÊHÂˆ™]\›ˆ\Ë˜]]™[]U\Ù\PYZ[ŠXİÜ’Y\Ù\’Y
NÂˆB‚ˆ\Ş[˜È]›Ü›TÙ][™ÜÊ
HÂˆÛÛœİ›İÜÈH]ØZ]\Ëœš\ÛXKœ]›Ü›TÙ][™Ë™š[™X[J
K˜Ø]Ú


HOˆ×JNÂˆÛÛœİİ™\œšY\ĞRÙ^HH™]ÈX\
›İÜË›X\

›İÊHOˆÜ›İËšÙ^K›İË˜[YWJJNÂˆ™]\›ˆ\Ëœ]›Ü›TÙ][™ĞØ][ÙË›X\

Yš[š][ÛŠHOˆ\ËÔ]›Ü›TÙ][™ÊYš[š][Û‹İ™\œšY\ĞRÙ^K™Ù]
Yš[š][Û‹šÙ^JJJNÂˆB‚ˆ\Ş[˜È]›Ü›TÙ][™ÊÙ^Nˆİš[™ÊHÂˆÛÛœİYš[š][ÛˆH\Ëœ]›Ü›TÙ][™ĞØ][ÙË™š[™

[JHOˆ[KšÙ^HOOHÙ^JHÏÈ\Ëœ]›Ü›TÙ][™ĞØ][ÙÖÌNÂˆÛÛœİ›İÈH]ØZ]\Ëœš\ÛXKœ]›Ü›TÙ][™Ë™š[™[š\]YJÈÚ\™NˆÈÙ^NˆYš[š][Û‹šÙ^HHJK˜Ø]Ú


HOˆ[
NÂˆ™]\›ˆ\ËÔ]›Ü›TÙ][™ÊYš[š][Û‹›İÏË˜[YJNÂˆB‚ˆ\Ş[˜È\]T]›Ü›TÙ][™ÊÙ^Nˆİš[™Ë˜[YNˆİš[™ËXİÜ’Yˆİš[™ÊHÂˆÛÛœİYš[š][ÛˆH\Ëœ]›Ü›TÙ][™ĞØ][ÙË™š[™

[JHOˆ[KšÙ^HOOHÙ^JNÂˆYˆ
YYš[š][ÛŠH›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ[šÛ›İÛˆ]›Ü›HÙ][™Îˆ	ÚÙ^_X
NÂˆYˆ
Yš[š][Û‹\HOOH	Ø›ÛÛX[‰È	‰ˆ˜[YHOOH	İYIÈ	‰ˆ˜[YHOOH	Ù˜[ÙIÊHÂˆ›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	ÙYš[š][Û‹]_H]\İ™HYHÜˆ˜[ÙK˜
NÂˆBˆYˆ
Yš[š][Û‹\HOOH	Û[X™\‰È	‰ˆ
]˜[YKš[J
H[X™\‹š\Ó˜SŠ[X™\Š˜[YJJJJHÂˆ›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	ÙYš[š][Û‹]_H]\İ™HH[X™\‹˜
NÂˆBˆYˆ
Yš[š][Û‹\HOOH	Û[X™\‰È	‰ˆYš[š][Û‹›Z[ˆOOH[™Yš[™Y	‰ˆ[X™\Š˜[YJHYš[š][Û‹›Z[ŠHÂˆ›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	ÙYš[š][Û‹]_H]\İ™H]X\İ	ÙYš[š][Û‹›Z[ŸK˜
NÂˆBˆYˆ
Yš[š][Û‹\HOOH	Û[X™\‰È	‰ˆYš[š][Û‹›X^OOH[™Yš[™Y	‰ˆ[X™\Š˜[YJHˆYš[š][Û‹›X^
HÂˆ›İÈ™]È˜Y™\]Y\İ^Ù\[ÛŠ	ÙYš[š][Û‹]_H]\İ›İ^ÙYY	ÙYš[š][Û‹›X^K˜
NÂˆB‚ˆHÂˆ]ØZ]\Ëœš\ÛXKœ]›Ü›TÙ][™Ë\Ù\
ÂˆÚ\™NˆÈÙ^NˆYš[š][Û‹šÙ^HKˆ\]NˆÈ˜[YK\]YRYˆXİÜ’YKˆÜ™X]NˆÈÙ^NˆYš[š][Û‹šÙ^K˜[YK\]YRYˆXİÜ’YKˆJNÂˆHØ]Ú
\œ›ÜŠHÂˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İØ]™H	ÙYš[š][Û‹]KÓİÙ\Ø\ÙJ
_KˆX\ÙHHYØZ[ˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆB‚ˆ]ØZ]\Ëœš\ÛXK˜]Y]ÙË˜Ü™X]JÂˆ]NˆÂˆXİÜ’YˆXİ[Ûˆ	ÔU“Ô“WÔÑUS‘×ÕTUQ	Ëˆ[]Nˆ	Ô]›Ü›TÙ][™ÉËˆ[]RYˆYš[š][Û‹šÙ^KˆY]Y]NˆÈÙ^NˆYš[š][Û‹šÙ^K˜[YHKˆKˆJK˜Ø]Ú


HOˆ[
NÂ‚ˆ™]\›ˆ\ËÔ]›Ü›TÙ][™ÊYš[š][Û‹˜[YJNÂˆB‚ˆš]˜]HÔ]›Ü›TÙ][™ÊYš[š][Ûˆ
\[Ùˆ\Ëœ]›Ü›TÙ][™ĞØ][ÙÊVÛ[X™\—KİÜ™Y˜[YOÎˆİš[™ÊHÂˆÛÛœİ˜[YHHİÜ™Y˜[YHÏÈYš[š][Û‹™Y˜][˜[YNÂˆÛÛœİ\Ü^U˜[YHHYš[š][Û‹\HOOH	Ø›ÛÛX[‰ÈÈ
˜[YHOOH	İYIÈÈ	ÓÛ‰Èˆ	ÓÙ™‰ÊBˆˆYš[š][Û‹\HOOH	Û[X™\‰È	‰ˆ
Yš[š][Û‹šÙ^HOOH	Ù™YIÈYš[š][Û‹šÙ^K™[™ÕÚ]
	Ô\˜Ù[	ÊJHÈ	İ˜[Y_IXˆˆYš[š][Û‹\HOOH	Û[X™\‰È	‰ˆYš[š][Û‹šÙ^K™[™ÕÚ]
	Ó™Û‰ÊHÈ‘Óˆ	Ó[X™\Š˜[YJKÓØØ[Tİš[™Ê	Ù[‹UTÉÊ_XˆˆYš[š][Û‹šÙ^HOOH	ÜšXÚ[™Ô][İU˜[Y]SZ[]\ÉÈÈ	İ˜[Y_HZ[]\ØˆˆYš[š][Û‹šÙ^HOOH	Ü^[İ]	ÈÈ˜[YK˜Ú\]

KÕ\\Ø\ÙJ
H
È˜[YKœÛXÙJJBˆˆYš[š][Û‹›][[[™HÈ
˜[YK›[™İˆˆÈ	İ˜[YKœÛXÙJŠKš[Q[™

_x )˜ˆ˜[YJBˆˆ˜[YNÂˆ™]\›ˆÂˆÙ^NˆYš[š][Û‹šÙ^Kˆ]NˆYš[š][Û‹]Kˆ\ØÜš\[ÛˆYš[š][Û‹™\ØÜš\[Û‹ˆX™[ˆYš[š][Û‹›X™[ˆ˜[YKˆ\Ü^U˜[YKˆ[\ˆYš[š][Û‹š[\‹ˆ\NˆYš[š][Û‹\Kˆ][[[™NˆYš[š][Û‹›][[[™HÏÈ˜[ÙKˆNÂˆB‚ˆ\Ş[˜È]Y]ÙÜÊØ]YÛÜOÎˆİš[™ÊHÂˆHÂˆÛÛœİÙÜÈH]ØZ]\Ëœš\ÛXK˜]Y]ÙË™š[™X[JÂˆÜ™\NˆÈÜ™X]Y]ˆ	Ù\ØÉÈKˆZÙNˆLˆJNÂˆÛÛœİXİÜ’YÈHË‹‹›™]ÈÙ]
ÙÜË›X\

ÙÊHOˆÙË˜XİÜ’Y
K™š[\Š›ÛÛX[ŠH\Èİš[™Ö×JWNÂˆÛÛœİXİÜœÈH]ØZ]\Ëœš\ÛXK\Ù\‹™š[™X[JÂˆÚ\™NˆÈYˆÈ[ˆXİÜ’YÈHKˆ[˜ÛYNˆÈ›Ùš[NˆYHKˆJNÂˆÛÛœİXİÜœĞRYH™]ÈX\
XİÜœË›X\

XİÜŠHOˆØXİÜ‹šYXİÜ—JJNÂˆÛÛœİ™XÛÜ™ÈHÙÜË›X\

ÙÊHOˆÂˆÛÛœİXİÜˆHÙË˜XİÜ’YÈXİÜœĞRY™Ù]
ÙË˜XİÜ’Y
Hˆ[ÂˆÛÛœİ™XÛÜ™Ø]YÛÜHH\Ë˜]Y]Ø]YÛÜJÙË˜Xİ[Û‹ÙË™[]JNÂˆ™]\›ˆÂˆYˆÙËšYˆXİÜˆXİÜËœ›Ùš[OË™[˜[YHÏÈXİÜË™[XZ[ÏÈ	ÔŞ\İ[IËˆXİ[Ûˆ\Ë˜]Y]Xİ[Û“X™[
ÙË˜Xİ[ÛŠKˆ[YNˆ\Ë˜]Y][YJÙË˜Ü™X]Y]
KˆXÛÛˆ\Ë˜]Y]XÛÛŠÙË˜Xİ[Û‹ÙË™[]JKˆÛ™Nˆ\Ë˜]Y]Û™JÙË˜Xİ[ÛŠKˆØ]YÛÜNˆ™XÛÜ™Ø]YÛÜKˆNÂˆJNÂ‚ˆYˆ
Ø]YÛÜH	‰ˆØ]YÛÜHOOH	Ğ[	ÊH™]\›ˆ™XÛÜ™Ë™š[\Š
™XÛÜ™
HOˆ™XÛÜ™˜Ø]YÛÜHOOHØ]YÛÜJNÂˆ™]\›ˆ™XÛÜ™ÎÂˆHØ]Ú
\œ›ÜŠHÂˆËÈ\ÙYÈ˜[˜XÚÈÈÈ\™ÛÙY˜ZÙH]Y][šY\È
”™]šY]È˜XÚÙ[™İ\Y‹ˆËÈ”™]šY]ÙY[[ÈÛÜšÙ›İÈ‹‹‹ŠHÛˆ[H™XY˜Z[\™HH[ˆYZ[ˆ[™\İYØ][™È[‚ˆËÈ[˜ÚY[\š[™ÈHˆXØİ\Ûİ[ÙYH˜XœšXØ]Y]Y]\İÜHÚ]›İ[™ÂˆËÈ\İ[™İZ\Ú[™È]œ›ÛHH™X[˜Z[ÚXÚY™X]ÈH[\™HÚ[Ùˆ[‚ˆËÈ]Y]ÙË‚ˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İØY]Y]ÙÜËˆX\ÙHHYØZ[ˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆBˆB‚ˆ\Ş[˜ÈšXÚ[™Ô™\Ü

HÂˆÛÛœİ\š[Ù[™H™]È]J
NÂˆÛÛœİ\š[Ùİ\H™]È]J\š[Ù[™™Ù][YJ
HHÌ
ˆ
ˆŒ
ˆŒ
ˆL
NÂˆ]ÙÜÎÂˆHÂˆÙÜÈH]ØZ]\Ëœš\ÛXK˜]Y]ÙË™š[™X[JÂˆÚ\™NˆÂˆXİ[Ûˆ	ÔÒTQS•ÔUSÕWĞPĞÑTQ	ËˆÜ™X]Y]ˆÈİNˆ\š[Ùİ\KˆKˆ[˜ÛYNˆÈXİÜˆÈ[˜ÛYNˆÈ›Ùš[NˆYHHHKˆÜ™\NˆÈÜ™X]Y]ˆ	Ù\ØÉÈKˆZÙNˆŒˆJNÂˆHØ]ÚÂˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠ	ĞÛİ[›İØYHšXÚ[™È™\ÜˆX\ÙHHYØZ[‹‰ÊNÂˆB‚ˆÛÛœİ][İ\ÈHÙÜË›X\

ÙÊHOˆÂˆÛÛœİY]Y]HH
ÙË›Y]Y]HÏÈßJH\È™XÛÜ™İš[™Ë[šÛ›İÛÂˆÛÛœİœ™XZÙİÛˆHY]Y]KœšXÚ[™Ğœ™XZÙİÛˆ	‰ˆ\[ÙˆY]Y]KœšXÚ[™Ğœ™XZÙİÛˆOOH	ÛØš™Xİ	ÂˆÈY]Y]KœšXÚ[™Ğœ™XZÙİÛˆ\È™XÛÜ™İš[™Ë[šÛ›İÛ‚ˆˆßNÂˆÛÛœİ[[İ[ÛØ›ÈH\Ëœ™\Ü[X™\ŠY]Y]Kœ][İYšXÙRÛØ›ÊNÂˆÛÛœİ\İ[˜ÙRÛHH\Ëœ™\Ü[X™\ŠY]Y]K™\İ[˜ÙRÛJNÂˆ™]\›ˆÂˆYˆÙËšYˆÚ\Y[YˆÙË™[]RYÏÈ[™Yš[™Yˆİ\İÛY\ˆÙË˜XİÜËœ›Ùš[OË™[˜[YHÏÈÙË˜XİÜË™[XZ[ÏÈ	Ğİ\İÛY\‰ËˆXØÙ\Y]ˆÙË˜Ü™X]Y]ÒTÓÔİš[™Ê
Kˆ[[İ[ÛØ›Ëˆ\İ[˜ÙRÛKˆ˜]T\’ÛRÛØ›Îˆ\İ[˜ÙRÛHˆÈX]œ›İ[™
[[İ[ÛØ›ÈÈ\İ[˜ÙRÛJHˆˆXÚÕ\Nˆİš[™Êœ™XZÙİÛ‹XÚÕ\HÏÈ	ÕXÚÉÊKˆ›İšY\ˆİš[™ÊY]Y]Kœ›İšY\ˆÏÈ	ØÛÛÜ™[˜]IÊKˆšXÚ[™Ó[ÙNˆİš[™ÊY]Y]KœšXÚ[™Ó[ÙHÏÈ	ØÛÛÜ™[˜]WÙ\İ[X]IÊKˆšXÚ[™Õ™\œÚ[Ûˆİš[™ÊY]Y]KœšXÚ[™Õ™\œÚ[ÛˆÏÈ	İ[šÛ›İÛ‰ÊKˆNÂˆJNÂˆÛÛœİİ[][İU˜[YRÛØ›ÈH][İ\Ëœ™YXÙJ
İ[][İJHOˆİ[
È][İK˜[[İ[ÛØ›Ë
NÂˆÛÛœİİ[\İ[˜ÙRÛHH][İ\Ëœ™YXÙJ
İ[][İJHOˆİ[
È][İK™\İ[˜ÙRÛK
NÂˆÛÛœİ]™T›İ]PÛİ[H][İ\Ë™š[\Š
][İJHOˆ][İKœ›İšY\ˆOOH	ÙÛÛÙÛIÈ][İKœšXÚ[™Ó[ÙHOOH	Û]™WÜ›ØYÜ›İ]IÊK›[™İÂ‚ˆ™]\›ˆÂˆ\š[Ùİ\ˆ\š[Ùİ\ÒTÓÔİš[™Ê
Kˆ\š[Ù[™ˆ\š[Ù[™ÒTÓÔİš[™Ê
KˆXØÙ\Y][İPÛİ[ˆ][İ\Ë›[™İˆİ[][İU˜[YRÛØ›Ëˆ]™\˜YÙT][İRÛØ›Îˆ][İ\Ë›[™İÈX]œ›İ[™
İ[][İU˜[YRÛØ›ÈÈ][İ\Ë›[™İ
Hˆˆ]™\˜YÙT˜]T\’ÛRÛØ›Îˆİ[\İ[˜ÙRÛHˆÈX]œ›İ[™
İ[][İU˜[YRÛØ›ÈÈİ[\İ[˜ÙRÛJHˆˆ]™T›İ]T\˜Ù[ˆ][İ\Ë›[™İÈX]œ›İ[™

]™T›İ]PÛİ[È][İ\Ë›[™İ
H
ˆL
Hˆˆ]\İ][İ\Îˆ][İ\ËœÛXÙJŒ
KˆNÂˆB‚ˆ\Ş[˜È]Y]ÙÊYˆİš[™ÊHÂˆHÂˆÛÛœİÙÈH]ØZ]\Ëœš\ÛXK˜]Y]ÙË™š[™[š\]YJÈÚ\™NˆÈYHJNÂˆYˆ
[ÙÊH›İÈ™]È›İ›İ[™^Ù\[ÛŠ	Ğ]Y][H›İ›İ[™‰ÊNÂˆÛÛœİXİÜˆHÙË˜XİÜ’YˆÈ]ØZ]\Ëœš\ÛXK\Ù\‹™š[™[š\]YJÈÚ\™NˆÈYˆÙË˜XİÜ’YK[˜ÛYNˆÈ›Ùš[NˆYHHJBˆˆ[ÂˆÛÛœİY]Y]HH
ÙË›Y]Y]HÏÈßJH\È™XÛÜ™İš[™Ë[šÛ›İÛÂˆ™]\›ˆÂˆYˆÙËšYˆXİÜˆXİÜËœ›Ùš[OË™[˜[YHÏÈXİÜË™[XZ[ÏÈ	ÔŞ\İ[IËˆXİ[Ûˆ\Ë˜]Y]Xİ[Û“X™[
ÙË˜Xİ[ÛŠKˆ[YNˆÙË˜Ü™X]Y]ÓØØ[Tİš[™Ê	Ù[‹UTÉËÈ[Ûˆ	ÜÚÜ	Ë^Nˆ	Û[Y\šXÉËYX\ˆ	Û[Y\šXÉËİ\ˆ	Û[Y\šXÉËZ[]Nˆ	Ì‹YYÚ]	ÈJKˆXÛÛˆ\Ë˜]Y]XÛÛŠÙË˜Xİ[Û‹ÙË™[]JKˆÛ™Nˆ\Ë˜]Y]Û™JÙË˜Xİ[ÛŠKˆØ]YÛÜNˆ\Ë˜]Y]Ø]YÛÜJÙË˜Xİ[Û‹ÙË™[]JKˆ›ÛNˆXİÜËœ›ÛHÏÈ	ÔÖTÕSIËˆ\™Ù]ˆÛÙË™[]KÙË™[]RYK™š[\Š›ÛÛX[ŠKš›Ú[Š	ÈH	ÊHÙË™[]Kˆ\ˆİš[™ÊY]Y]Kš\ÏÈY]Y]KœÛİ\˜ÙHÏÈ	Õ™\˜Ù[Ôİ\X˜\ÙIÊKˆ™\İ[ˆİš[™ÊY]Y]Kœİ]\ÈÏÈY]Y]Kœ™\İ[ÏÈ	Ô™XÛÜ™Y	ÊKˆNÂˆHØ]Ú
\œ›ÜŠHÂˆËÈ\ÙYÈ˜[˜XÚÈÈH˜ZÙH™]šY]È]Y][HÛˆS–H˜Z[\™HH[˜ÛY[™ÈBˆËÈÙ[Z[™[K[Z\ÜÚ[™ÈYÚ[˜ÙHH›İ›İ[™^Ù\[Ûˆ›İÛˆX›İ™HØ\ÈİØ[İÙYBˆËÈ\ÈØ[YHØ]Ú[œİXYÙˆ›ÜYØ][™ËˆH˜[˜XÚÈY‰İ]™[ˆÛÚÈ\BˆËÈ™\]Y\İYY[[Û™È]ÈÈ\™ÛÙY˜ZÙ\ÈÛÜœ™XİNˆ[H™X[Y
ÚXÚ™]™\‚ˆËÈX]Ú\È	Ø]Y]LIËÉØ]Y]L‰ËÉØ]Y]LÉÊHÚ[[H™]\›™YH’T”Õ˜ZÙH[BˆËÈ
”Ş\İ[HH™]šY]È˜XÚÙ[™İ\YŠH\ÈYˆ]Ù\™HH™XÛÜ™HYZ[ˆ\ÚÙYˆËÈ›ÜˆHHÙ\š[İ\È[YÜš]H›Ø›[H›ÜˆH™X]\™H]^\İÈ›ÜˆXØÛİ[Xš[]K‚ˆYˆ
\œ›Üˆ[œİ[˜Ù[Ùˆ›İ›İ[™^Ù\[ÛŠH›İÈ\œ›ÜÂˆ›İÈ™]È[\›˜[Ù\™\‘\œ›Ü‘^Ù\[ÛŠÛİ[›İØY\È]Y][KˆX\ÙHHYØZ[ˆ	İ\Ë™\œ›Ü“Y\ÜØYÙJ\œ›ÜŠ_X
NÂˆBˆB‚ˆš]˜]H]Y]Xİ[Û“X™[
Xİ[Ûˆİš[™ÊHÂˆ™]\›ˆXİ[Û‚ˆÓİÙ\Ø\ÙJ
BˆœÜ]
	×ÉÊBˆ›X\

\
HOˆ\˜Ú\]

KÕ\\Ø\ÙJ
H
È\œÛXÙJJJBˆš›Ú[Š	È	ÊNÂˆB‚ˆš]˜]H]Y]Ø]YÛÜJXİ[Ûˆİš[™Ë[]Nˆİš[™ÊHÂˆYˆ
ÔVSÕUTĞÔ“ÕßVSQS•ÚK\İ
	ØXİ[ÛŸH	Ù[]_X
JH™]\›ˆ	Ñš[˜[˜ÙIÎÂˆYˆ
ĞUUÑÒSŸÕÖPßTÑTŸPĞÓÕS•ÚK\İ
	ØXİ[ÛŸH	Ù[]_X
JH™]\›ˆ	ĞXØÛİ[ÉÎÂˆ™]\›ˆ	ÔŞ\İ[IÎÂˆB‚ˆš]˜]H]Y]XÛÛŠXİ[Ûˆİš[™Ë[]Nˆİš[™ÊHÂˆYˆ
ÔVSÕUTĞÔ“ÕßVSQS•ÚK\İ
	ØXİ[ÛŸH	Ù[]_X
JH™]\›ˆ	Ü^[Y[ÉÎÂˆYˆ
ÒÖPß‘T’Q’PĞUSÓ‹ÚK\İ
	ØXİ[ÛŸH	Ù[]_X
JH™]\›ˆ	İ™\šYšYY]\Ù\‰ÎÂˆYˆ
ĞUUÑÒSŸÕTÑT‹ÚK\İ
	ØXİ[ÛŸH	Ù[]_X
JH™]\›ˆ	ÛX[˜YÙKXXØÛİ[ÉÎÂˆ™]\›ˆ	Ú\İÜIÎÂˆB‚ˆš]˜]H]Y]Û™JXİ[Ûˆİš[™ÊNˆ	ÜİXØÙ\ÜÉÈ	Ù\œ›Ü‰È	İØ\›š[™ÉÈ	Ú[™›ÉÈÂˆYˆ
Ô‘R‘PÕRST”“ÔŸTÔUKÚK\İ
Xİ[ÛŠJH™]\›ˆ	Ù\œ›Ü‰ÎÂˆYˆ
Ô‘TUQTÕS‘S‘ß‘U’QUËÚK\İ
Xİ[ÛŠJH™]\›ˆ	İØ\›š[™ÉÎÂˆYˆ
ĞT“Õ‘_RQ‘SPTÑ_ÕPĞÑTÔßÓÓTUKÚK\İ
Xİ[ÛŠJH™]\›ˆ	ÜİXØÙ\ÜÉÎÂˆ™]\›ˆ	Ú[™›ÉÎÂˆB‚ˆš]˜]H]Y][YJ]Nˆ]JHÂˆÛÛœİZ[]\ÈHX]›X^
KX]œ›İ[™

]K››İÊ
HH]K™Ù][YJ
JHÈŒ
JNÂˆYˆ
Z[]\ÈŒ
H™]\›ˆ	ÛZ[]\ßHZ[ˆYÛØÂˆÛÛœİİ\œÈHX]œ›İ[™
Z[]\ÈÈŒ
NÂˆYˆ
İ\œÈ
H™]\›ˆ	Úİ\œßZYÛØÂˆ™]\›ˆ	ÓX]œ›İ[™
İ\œÈÈ
_YYÛØÂˆB‚ˆš]˜]H™\Ü[X™\Š˜[YNˆ[šÛ›İÛŠHÂˆÛÛœİ[X™\ˆH[X™\Š˜[YJNÂˆ™]\›ˆ[X™\‹š\Ñš[š]J[X™\ŠH	‰ˆ[X™\ˆˆÈ[X™\ˆˆÂˆBŸB