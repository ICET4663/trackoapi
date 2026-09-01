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
    const service = new PortalService({ user: { findUnique } } as unknown as PrismaService);

    const result = await service.owner('owner-1');

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'owner-1' } }));
    expect(result.owner.id).toBe('owner-1');
  });
});
