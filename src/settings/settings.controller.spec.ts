import type { RequestUserService } from '../common/request-user.service';
import { SettingsController } from './settings.controller';
import type { SettingsService } from './settings.service';
import type { ShipmentsService } from '../shipments/shipments.service';

describe('SettingsController payout authorization', () => {
  it('reserves payout decisions for an authenticated admin', async () => {
    const settings = {
      reviewPayoutRequest: jest.fn().mockResolvedValue({ id: 'payout-1', status: 'APPROVED' }),
    } as unknown as SettingsService;
    const requestUser = {
      requireRole: jest.fn().mockResolvedValue({ sub: 'admin-1', role: 'ADMIN' }),
    } as unknown as RequestUserService;
    const controller = new SettingsController(settings, requestUser);

    await controller.reviewPayoutRequest('payout-1', { decision: 'APPROVED' }, 'Bearer token');

    expect((requestUser as unknown as { requireRole: jest.Mock }).requireRole)
      .toHaveBeenCalledWith('Bearer token', ['ADMIN']);
    expect((settings as unknown as { reviewPayoutRequest: jest.Mock }).reviewPayoutRequest)
      .toHaveBeenCalledWith('payout-1', 'admin-1', { decision: 'APPROVED' });
  });
});

describe('SettingsController owner fleet assignment', () => {
  it('requires a truck-owner session and passes the authenticated owner id to the service', async () => {
    const settings = {
      assignDriverToOwnedVehicle: jest.fn().mockResolvedValue({ id: 'vehicle-1', assignedDriverId: 'driver-1' }),
    } as unknown as SettingsService;
    const requestUser = {
      requireRole: jest.fn().mockResolvedValue({ sub: 'owner-1', role: 'TRUCK_OWNER' }),
    } as unknown as RequestUserService;
    const controller = new SettingsController(settings, requestUser);

    await controller.assignDriverToOwnedVehicle({ vehicleId: 'vehicle-1', driverId: 'driver-1' }, 'Bearer owner-token');

    expect((requestUser as unknown as { requireRole: jest.Mock }).requireRole)
      .toHaveBeenCalledWith('Bearer owner-token', ['TRUCK_OWNER']);
    expect((settings as unknown as { assignDriverToOwnedVehicle: jest.Mock }).assignDriverToOwnedVehicle)
      .toHaveBeenCalledWith('vehicle-1', 'driver-1', 'owner-1');
  });
});

describe('SettingsController owner settlements', () => {
  it('requires a truck-owner session for earnings and withdrawal requests', async () => {
    const settings = {
      ownerEarnings: jest.fn().mockResolvedValue({ availableBalance: 0 }),
      requestOwnerWithdrawal: jest.fn().mockResolvedValue({ id: 'payout-1' }),
    } as unknown as SettingsService;
    const requestUser = {
      requireRole: jest.fn().mockResolvedValue({ sub: 'owner-1', role: 'TRUCK_OWNER' }),
    } as unknown as RequestUserService;
    const controller = new SettingsController(settings, requestUser);

    await controller.ownerEarnings('Bearer owner-token');
    await controller.requestOwnerWithdrawal({ amountKobo: 100_000 }, 'Bearer owner-token');

    expect((requestUser as unknown as { requireRole: jest.Mock }).requireRole)
      .toHaveBeenCalledWith('Bearer owner-token', ['TRUCK_OWNER']);
    expect((settings as unknown as { ownerEarnings: jest.Mock }).ownerEarnings).toHaveBeenCalledWith('owner-1');
    expect((settings as unknown as { requestOwnerWithdrawal: jest.Mock }).requestOwnerWithdrawal)
      .toHaveBeenCalledWith('owner-1', { amountKobo: 100_000 });
  });
});

describe('SettingsController owner fleet reporting', () => {
  it('passes the authenticated owner id into load and expense operations', async () => {
    const settings = {
      ownerLoadDetail: jest.fn().mockResolvedValue({ id: 'shipment-1' }),
      ownerFleetAnalytics: jest.fn().mockResolvedValue({ month: '2026-09' }),
      createVehicleExpense: jest.fn().mockResolvedValue({ id: 'expense-1' }),
    } as unknown as SettingsService;
    const requestUser = { requireRole: jest.fn().mockResolvedValue({ sub: 'owner-1', role: 'TRUCK_OWNER' }) } as unknown as RequestUserService;
    const controller = new SettingsController(settings, requestUser);

    await controller.ownerLoadDetail('shipment-1', 'Bearer owner-token');
    await controller.ownerFleetAnalytics('2026-09', 'Bearer owner-token');
    await controller.createVehicleExpense('vehicle-1', { category: 'FUEL', amountKobo: 50_000 }, 'Bearer owner-token');

    expect((settings as unknown as { ownerLoadDetail: jest.Mock }).ownerLoadDetail).toHaveBeenCalledWith('owner-1', 'shipment-1');
    expect((settings as unknown as { ownerFleetAnalytics: jest.Mock }).ownerFleetAnalytics).toHaveBeenCalledWith('owner-1', '2026-09');
    expect((settings as unknown as { createVehicleExpense: jest.Mock }).createVehicleExpense)
      .toHaveBeenCalledWith('vehicle-1', 'owner-1', { category: 'FUEL', amountKobo: 50_000 });
  });
});

describe('SettingsController driver coming online', () => {
  function build(saved: Record<string, unknown>) {
    const settings = {
      updateSafetySetting: jest.fn().mockResolvedValue(saved),
      updateDriverAvailabilityLocation: jest.fn().mockResolvedValue(saved),
    } as unknown as SettingsService;
    const requestUser = {
      fromAuthorizationHeader: jest.fn().mockResolvedValue({ sub: 'driver-1', role: 'DRIVER' }),
    } as unknown as RequestUserService;
    const matchWaitingShipmentsSoon = jest.fn().mockResolvedValue({ waiting: 1, offered: 1 });
    const shipments = { matchWaitingShipmentsSoon } as unknown as ShipmentsService;
    return { controller: new SettingsController(settings, requestUser, shipments), matchWaitingShipmentsSoon };
  }

  it('offers waiting shipments when a driver switches availability on', async () => {
    const { controller, matchWaitingShipmentsSoon } = build({ availableForAssignments: true });

    await controller.updateSafetySettings({ key: 'availableForAssignments', value: true }, 'Bearer token');

    expect(matchWaitingShipmentsSoon).toHaveBeenCalledTimes(1);
  });

  it('does not match when a driver goes offline or changes another setting', async () => {
    const offline = build({ availableForAssignments: false });
    await offline.controller.updateSafetySettings({ key: 'availableForAssignments', value: false }, 'Bearer token');
    expect(offline.matchWaitingShipmentsSoon).not.toHaveBeenCalled();

    const other = build({ availableForAssignments: true });
    await other.controller.updateSafetySettings({ key: 'nightDrivingCheckIns', value: true }, 'Bearer token');
    expect(other.matchWaitingShipmentsSoon).not.toHaveBeenCalled();
  });

  it('offers waiting shipments when an online driver reports a fresh position', async () => {
    const { controller, matchWaitingShipmentsSoon } = build({ availableForAssignments: true, lastKnownLatitude: 6.5, lastKnownLongitude: 3.3 });

    await controller.updateDriverAvailabilityLocation({ latitude: 6.5, longitude: 3.3 }, 'Bearer token');

    expect(matchWaitingShipmentsSoon).toHaveBeenCalledTimes(1);
  });

  it('never fails the driver request when matching fails', async () => {
    const { controller, matchWaitingShipmentsSoon } = build({ availableForAssignments: true });
    matchWaitingShipmentsSoon.mockRejectedValue(new Error('db busy'));

    await expect(controller.updateDriverAvailabilityLocation({ latitude: 6.5, longitude: 3.3 }, 'Bearer token'))
      .resolves.toMatchObject({ availableForAssignments: true });
  });
});
