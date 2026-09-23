import { PortalService } from './portal.service';
import type { PrismaService } from '../prisma/prisma.service';

// customer()/driver()/owner() used to return a single hardcoded "preview" identity
// (id: 'preview-driver'/'preview-owner', a fake TRK-1024 shipment, a fake N0 balance)
// whenever userId was falsy - dead in production since the global JwtAuthGuard already
// rejects any request without a valid token before the controller ever calls in here,
// but the same landmine class as previewProfile()/previewNotification() elsewhere in
// this codebase: a future soft-auth route change would have silently served fake
// dashboard data instead of failing loudly. userId is required now.
describe('PortalService always queries with the real authenticated userId', () => {
  it('customer() looks up the real user by id, not a preview fallback', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      profile: { fullName: 'Ada Lovelace' },
      customerShipments: [],
    });
    const service = new PortalService({ user: { findUnique } } as unknown as PrismaService);

    const result = await service.customer('cust-1');

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'cust-1' } }));
    expect(result.greetingName).toBe('Ada');
  });

  it('driver() looks up the real user by id, not a preview fallback', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      profile: { fullName: 'Musa Ibrahim' },
      driverAssignments: [],
    });
    const service = new PortalService({ user: { findUnique } } as unknown as PrismaService);

    const result = await service.driver('driver-1');

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'driver-1' } }));
    expect(result.driver.id).toBe('driver-1');
    expect(result.driver.name).toBe('Musa Ibrahim');
  });

  it('owner() looks up the real user by id, not a preview fallback', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      profile: { fullName: 'Fleet Co' },
      vehicles: [],
    });
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new PortalService({ user: { findUnique, findMany } } as unknown as PrismaService);

    const result = await service.owner('owner-1');

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'owner-1' } }));
    expect(result.owner.id).toBe('owner-1');
  });

  it('owner() returns real verified drivers and active loads for the owner fleet', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      profile: { fullName: 'Fleet Co' },
      vehicles: [{
        id: 'vehicle-1', plateNumber: 'LAG-1', type: 'Flatbed', capacityKg: 30000, capacityM3: 55,
        registrationState: 'Lagos', assignedDriverId: 'driver-1',
        assignedDriver: { email: 'driver@tracko.ng', profile: { fullName: 'Driver One' } },
        documents: [
          { type: 'REGISTRATION', state: 'VERIFIED', expires: null },
          { type: 'INSURANCE', state: 'VERIFIED', expires: null },
          { type: 'ROADWORTHINESS', state: 'VERIFIED', expires: null },
        ],
        assignments: [{
          id: 'assignment-1', driverId: 'driver-1', status: 'ACCEPTED',
          driver: { email: 'driver@tracko.ng', profile: { fullName: 'Driver One' } },
          shipment: {
            id: 'shipment-1', reference: 'TRK-1', status: 'IN_TRANSIT', pickupLabel: 'Lagos',
            destinationLabel: 'Abuja', quotedPriceKobo: 5000000,
          },
        }],
      }],
    });
    const findMany = jest.fn().mockResolvedValue([{
      id: 'driver-1', email: 'driver@tracko.ng', phone: '+2341', updatedAt: new Date(),
      profile: { fullName: 'Driver One', city: 'Ikeja', state: 'Lagos' },
      driverVehicles: [{ id: 'vehicle-1', plateNumber: 'LAG-1', type: 'Flatbed', isActive: true }],
      driverAssignments: [{
        status: 'ACCEPTED', vehicle: { id: 'vehicle-1' },
        shipment: { id: 'shipment-1', reference: 'TRK-1', status: 'IN_TRANSIT', pickupLabel: 'Lagos', destinationLabel: 'Abuja' },
      }],
      driverReviews: [],
    }]);
    const service = new PortalService({ user: { findUnique, findMany } } as unknown as PrismaService);

    const result = await service.owner('owner-1');

    expect(result.metrics).toMatchObject({ registeredTrucks: 1, assignedTrucks: 1, driverPool: 1, documentsDue: 0 });
    expect(result.seekingDrivers[0]).toMatchObject({
      id: 'driver-1', assignedTruck: 'LAG-1', activeShipmentReference: 'TRK-1', canReceiveTruck: false,
    });
    expect(result.activeLoads[0]).toMatchObject({ reference: 'TRK-1', truck: 'LAG-1', driver: 'Driver One' });
  });
});
