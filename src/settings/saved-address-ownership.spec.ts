import { NotFoundException } from '@nestjs/common';
import { SettingsService } from './settings.service';
import type { PrismaService } from '../prisma/prisma.service';

// Saved addresses: an edit upserted by address id alone (so another customer's address
// could be overwritten), and delete answered { deleted: true } without deleting.
describe('SettingsService saved addresses belong to one customer', () => {
  function buildService(queryRawUnsafe: jest.Mock) {
    const prisma = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService;
    return new SettingsService(prisma, {} as never, {} as never, {} as never);
  }

  it('an edit only updates the caller\'s own row', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([{ id: 'addr-1', label: 'Home' }]);
    const service = buildService(queryRawUnsafe);

    await service.saveAddress({ label: 'Home', line: '1 Allen Avenue' }, 'addr-1', 'cust-1');

    expect(queryRawUnsafe.mock.calls[0][0]).toContain('where "SavedAddress"."userId" = excluded."userId"');
    expect(queryRawUnsafe.mock.calls[0][2]).toBe('cust-1');
  });

  it('editing someone else\'s address is "not found" and changes nothing', async () => {
    // The conflict update is skipped for another user's row, so no row comes back.
    const service = buildService(jest.fn().mockResolvedValue([]));

    await expect(service.saveAddress({ label: 'Mine now' }, 'addr-of-someone-else', 'cust-1'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('delete really deletes, scoped to the caller', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([{ id: 'addr-1' }]);
    const service = buildService(queryRawUnsafe);

    await expect(service.deleteAddress('addr-1', 'cust-1')).resolves.toEqual({ deleted: true });
    expect(queryRawUnsafe).toHaveBeenCalledWith(
      'delete from "SavedAddress" where "id" = $1 and "userId" = $2 returning "id"', 'addr-1', 'cust-1',
    );
  });

  it('deleting an address that is not the caller\'s is "not found"', async () => {
    const service = buildService(jest.fn().mockResolvedValue([]));

    await expect(service.deleteAddress('addr-of-someone-else', 'cust-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
