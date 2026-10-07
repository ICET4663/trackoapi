import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { CommunicationService } from './communication.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { TranslationProviderService } from '../integrations/translation-provider.service';
import type { AuthUser } from '../common/types/auth-user';

describe('conversation inbox scope and reliability', () => {
  function setup(findMany = jest.fn().mockResolvedValue([])) {
    const service = new CommunicationService(
      {} as ConfigService,
      { conversation: { findMany } } as unknown as PrismaService,
      {} as NotificationsService,
      {} as TranslationProviderService,
    );
    return { service, findMany };
  }
  const actor = (role: AuthUser['role']) => ({ sub: 'actor-1', role, email: 'actor@test.invalid' } as AuthUser);

  it.each(['CUSTOMER', 'DRIVER', 'TRUCK_OWNER', 'ADMIN', 'DISPATCHER'] as const)
    ('scopes the %s inbox correctly', async role => {
      const { service, findMany } = setup();
      await service.listConversations(actor(role));
      const expectedWhere = role === 'CUSTOMER' ? { customerId: 'actor-1' }
        : role === 'DRIVER' ? { driverId: 'actor-1' }
        : role === 'TRUCK_OWNER' ? {
          shipment: { assignments: { some: { status: { in: ['OFFERED', 'ACCEPTED'] }, vehicle: { ownerId: 'actor-1' } } } },
        } : {};
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere }));
    });

  it('returns an empty inbox only when the database successfully finds no conversations', async () => {
    const { service } = setup();
    await expect(service.listConversations(actor('CUSTOMER'))).resolves.toEqual([]);
  });

  it('does not disguise a database failure as an empty inbox or expose its details', async () => {
    const { service } = setup(jest.fn().mockRejectedValue(new Error('private database details')));
    await expect(service.listConversations(actor('CUSTOMER'))).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(service.listConversations(actor('CUSTOMER'))).rejects.toThrow('Could not load conversations. Please try again.');
  });
});
