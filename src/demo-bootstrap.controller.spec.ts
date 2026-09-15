import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { DemoBootstrapController } from './demo-bootstrap.controller';
import { PrismaService } from './prisma/prisma.service';

jest.mock('bcryptjs', () => ({ hash: jest.fn() }));

describe('DemoBootstrapController', () => {
  const userUpsert = jest.fn();
  const bankAccountUpsert = jest.fn();
  const vehicleUpsert = jest.fn();
  const executeRawUnsafe = jest.fn();
  const prisma = {
    user: { upsert: userUpsert },
    bankAccount: { upsert: bankAccountUpsert },
    vehicle: { upsert: vehicleUpsert },
    $executeRawUnsafe: executeRawUnsafe,
  } as unknown as PrismaService;
  const config = { get: jest.fn().mockReturnValue('bootstrap-secret') } as unknown as ConfigService;
  const controller = new DemoBootstrapController(config, prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');
    userUpsert.mockImplementation(({ create }: { create: { email: string; role: string; profile: { create: { fullName: string } } } }) => ({
      id: `user-${create.role.toLowerCase()}`,
      email: create.email,
      role: create.role,
      profile: create.profile.create,
    }));
    bankAccountUpsert.mockResolvedValue({ id: 'bank-demo' });
    vehicleUpsert.mockResolvedValue({ id: 'vehicle-demo', plateNumber: 'TRK-DRV-01' });
    executeRawUnsafe.mockResolvedValue(1);
  });

  it('creates assignment-ready demo fixtures and canonical portal links', async () => {
    const result = await controller.bootstrapStaff('bootstrap-secret', { password: 'password123' });

    expect(result.ok).toBe(true);
    expect(result.users).toHaveLength(4);
    expect(vehicleUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ capacityKg: 30000, capacityM3: 45 }),
      create: expect.objectContaining({ capacityKg: 30000, capacityM3: 45 }),
    }));
    expect(executeRawUnsafe).toHaveBeenCalledTimes(3);
    expect(executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining(`'VERIFIED'::"DriverDocumentState"`),
      expect.any(String),
      'vehicle-demo',
      expect.stringMatching(/REGISTRATION|INSURANCE|ROADWORTHINESS/),
      expect.any(String),
      expect.stringMatching(/^DEMO-/),
      expect.any(Date),
      expect.stringContaining('Verified fixture'),
    );
    expect(result.links.admin).toBe('https://www.trako.com.ng/admin');
  });

  it('rejects an invalid bootstrap secret', async () => {
    await expect(controller.bootstrapStaff('wrong-secret', {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(userUpsert).not.toHaveBeenCalled();
  });
});
