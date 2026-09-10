import type { RequestUserService } from '../common/request-user.service';
import { TelemetryController } from './telemetry.controller';
import type { TelemetryService } from './telemetry.service';

describe('TelemetryController', () => {
  let telemetry: { recordClientError: jest.Mock; recentClientErrors: jest.Mock };
  let requestUser: { optionalFromAuthorizationHeader: jest.Mock; requireRole: jest.Mock };
  let controller: TelemetryController;

  beforeEach(() => {
    telemetry = {
      recordClientError: jest.fn().mockResolvedValue({ received: true }),
      recentClientErrors: jest.fn().mockResolvedValue([]),
    };
    requestUser = {
      optionalFromAuthorizationHeader: jest.fn().mockResolvedValue(null),
      requireRole: jest.fn().mockResolvedValue({ sub: 'admin-1', role: 'ADMIN' }),
    };
    controller = new TelemetryController(
      telemetry as unknown as TelemetryService,
      requestUser as unknown as RequestUserService,
    );
  });

  it('accepts an anonymous crash report', async () => {
    await controller.reportClientError({ message: 'boom' });
    expect(telemetry.recordClientError).toHaveBeenCalledWith({ message: 'boom' }, undefined);
  });

  it('attributes the report to the user when a valid token rides along', async () => {
    requestUser.optionalFromAuthorizationHeader.mockResolvedValue({ sub: 'user-7', role: 'CUSTOMER' });
    await controller.reportClientError({ message: 'boom' }, 'Bearer good');
    expect(telemetry.recordClientError).toHaveBeenCalledWith({ message: 'boom' }, 'user-7');
  });

  it('tolerates a missing body', async () => {
    await controller.reportClientError(undefined as never);
    expect(telemetry.recordClientError).toHaveBeenCalledWith({}, undefined);
  });

  it('requires an admin to list recent client errors', async () => {
    await controller.listClientErrors('20', 'Bearer admin');
    expect(requestUser.requireRole).toHaveBeenCalledWith('Bearer admin', ['ADMIN']);
    expect(telemetry.recentClientErrors).toHaveBeenCalledWith(20);
  });

  it('defaults the list limit when the query param is not a number', async () => {
    await controller.listClientErrors('abc', 'Bearer admin');
    expect(telemetry.recentClientErrors).toHaveBeenCalledWith(50);
  });
});
