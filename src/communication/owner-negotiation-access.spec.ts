import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { CommunicationService } from './communication.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { TranslationProviderService } from '../integrations/translation-provider.service';
import type { AuthUser } from '../common/types/auth-user';

describe('truck owner shipment negotiation access', () => {
  const owner = { sub: 'owner-1', role: 'TRUCK_OWNER', email: 'owner@test.invalid' } as AuthUser;
  function setup(status: string, vehicleOwnerId = owner.sub) {
    const findFirst = jest.fn().mockImplementation(async ({ where }) =>
      where.vehicle.ownerId === vehicleOwnerId && where.status.in.includes(status)
        ? { id: 'assignment-1' } : null);
    const conversation = { id: 'conversation-1', shipmentId: 'shipment-1', customerId: 'customer-1', driverId: 'driver-1' };
    const create = jest.fn().mockResolvedValue({
      id: 'message-1', senderId: owner.sub, kind: 'TEXT', body: 'Can we discuss pickup?',
      createdAt: new Date(), deliveryStatus: 'SENT',
    });
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      conversation: { upsert: jest.fn().mockResolvedValue(conversation), update: jest.fn().mockResolvedValue(conversation) },
      driverAssignment: { findFirst },
      message: { create, findMany },
      user: { findUnique: jest.fn().mockResolvedValue({ preferredLanguage: 'en' }) },
    } as unknown as PrismaService;
    const service = new CommunicationService(
      {} as ConfigService, prisma, {} as NotificationsService,
      { translate: jest.fn().mockResolvedValue(null) } as unknown as TranslationProviderService,
    );
    return { service, findFirst, create, findMany };
  }

  it.each(['OFFERED', 'ACCEPTED'])('allows the linked owner to read and send during %s', async status => {
    const { service, findFirst, create } = setup(status);
    await expect(service.listMessages('conversation-1', owner)).resolves.toMatchObject({ messages: [] });
    await expect(service.sendMessage('conversation-1', owner.sub, { kind: 'TEXT', body: 'Can we discuss pickup?' }, owner))
      .resolves.toMatchObject({ id: 'message-1' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: { shipmentId: 'shipment-1', status: { in: ['OFFERED', 'ACCEPTED'] }, vehicle: { ownerId: owner.sub } },
      select: { id: true },
    });
  });

  it.each(['CANCELLED', 'EXPIRED', 'REJECTED'])('blocks owner access after %s', async status => {
    const { service, create, findMany } = setup(status);
    await expect(service.listMessages('conversation-1', owner)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.sendMessage('conversation-1', owner.sub, { kind: 'TEXT', body: 'Hello' }, owner))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('blocks owners of unrelated vehicles even for an offered assignment', async () => {
    const { service, create } = setup('OFFERED', 'other-owner');
    await expect(service.sendMessage('conversation-1', owner.sub, { kind: 'TEXT', body: 'Hello' }, owner))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });
});
