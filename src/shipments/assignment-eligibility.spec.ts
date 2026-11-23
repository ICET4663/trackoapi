import { ShipmentsService } from './shipments.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MapsProviderService } from '../integrations/maps-provider.service';

// 23 November 2026: drivers may ASK for an unpaid load on the job board. The shared eligibility
// check then skips only the payment and approval rules; every driver and truck rule still applies,
// and without the option (dispatch offers, the customer choosing) payment is still required.
describe('ShipmentsService.checkAssignmentEligibility before payment', () => {
  const truck = { id: 'truck-1', capacityKg: 5000, capacityM3: 30, documents: [] };

  function build({ driver = {}, escrow = 'PENDING', online = true } = {} as {
    driver?: Record<string, unknown>;
    escrow?: string;
    online?: boolean;
  }) {
    const prisma = {
      shipment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'shp-1', status: 'PENDING_PAYMENT', adminApproved: false, cargoWeightKg: 1000, cargoVolumeM3: null,
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'driver-1', role: 'DRIVER', isActive: true, verificationStatus: 'VERIFIED', driverVehicles: [truck], ...driver,
        }),
      },
      driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRawUnsafe: jest.fn((sql: string) => Promise.resolve(
        sql.includes('from "Escrow"') ? [{ status: escrow }] : [{ availableForAssignments: online }],
      )),
    } as unknown as PrismaService;
    const service = new ShipmentsService(prisma, {} as NotificationsService, {} as MapsProviderService);
    jest.spyOn(service, 'isVehicleAssignmentReady').mockReturnValue(true);
    return service;
  }

  it('still needs payment and approval without the option', async () => {
    await expect(build().checkAssignmentEligibility('shp-1', 'driver-1')).rejects.toThrow('approved by an admin');
  });

  it('lets a verified, online driver with a fitting truck ask before payment', async () => {
    await expect(build().checkAssignmentEligibility('shp-1', 'driver-1', undefined, { beforePayment: true }))
      .resolves.toMatchObject({ vehicle: { id: 'truck-1' } });
  });

  it('keeps every driver rule before payment', async () => {
    await expect(build({ driver: { verificationStatus: 'PENDING' } })
      .checkAssignmentEligibility('shp-1', 'driver-1', undefined, { beforePayment: true })).rejects.toThrow('KYC-approved');
    await expect(build({ online: false })
      .checkAssignmentEligibility('shp-1', 'driver-1', undefined, { beforePayment: true })).rejects.toThrow('offline');
    await expect(build({ driver: { driverVehicles: [{ ...truck, capacityKg: 500 }] } })
      .checkAssignmentEligibility('shp-1', 'driver-1', undefined, { beforePayment: true })).rejects.toThrow('no active truck available');
  });
});
