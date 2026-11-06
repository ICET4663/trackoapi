import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { RequestUserService } from '../common/request-user.service';
import type { PaymentReconciliationService } from '../integrations/payment-reconciliation.service';
import { OperationsController } from './operations.controller';
import type { OperationsService } from './operations.service';

describe('OperationsController payment reconciliation routes', () => {
  function build(role: string = 'ADMIN') {
    const run = jest.fn().mockResolvedValue({ id: 'recon_1' });
    const latest = jest.fn().mockResolvedValue(null);
    const requireRole = jest.fn(async (_header: string | undefined, roles: string[]) => {
      if (!roles.includes(role)) throw new ForbiddenException();
      return { sub: 'admin-1', role };
    });
    const controller = new OperationsController(
      {} as OperationsService,
      { requireRole } as unknown as RequestUserService,
      { run, latest } as unknown as PaymentReconciliationService,
    );
    return { controller, run, latest, requireRole };
  }

  it('turns YYYY-MM-DD dates into a whole-day UTC window', async () => {
    const { controller, run } = build();

    await controller.runReconciliation({ from: '2026-09-01', to: '2026-11-06' }, 'Bearer x');

    expect(run).toHaveBeenCalledWith({
      trigger: 'manual',
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-11-06T23:59:59.999Z'),
      actorId: 'admin-1',
    });
  });

  it('leaves the window to the service default when no dates are sent', async () => {
    const { controller, run } = build();

    await controller.runReconciliation({}, 'Bearer x');
    await controller.runReconciliation(undefined, 'Bearer x');

    expect(run).toHaveBeenNthCalledWith(1, { trigger: 'manual', from: undefined, to: undefined, actorId: 'admin-1' });
    expect(run).toHaveBeenNthCalledWith(2, { trigger: 'manual', from: undefined, to: undefined, actorId: 'admin-1' });
  });

  it('refuses dates in any other format', async () => {
    const { controller, run } = build();

    for (const from of ['6 Nov', '2026-9-1', 'dddd-dd-dd', '2026-11-06T00:00']) {
      await expect(controller.runReconciliation({ from }, 'Bearer x')).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('is for admins only, reading and running', async () => {
    const { controller, run, latest } = build('DISPATCHER');

    await expect(controller.runReconciliation({}, 'Bearer x')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.latestReconciliation('Bearer x')).rejects.toBeInstanceOf(ForbiddenException);
    expect(run).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
  });
});
