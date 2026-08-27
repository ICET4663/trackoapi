import { NotificationsService } from './notifications.service';
import type { PrismaService } from '../prisma/prisma.service';

// registerPushToken() always stored real device tokens, but nothing ever actually sent to
// them - a closed app never got notified of anything until the user happened to reopen it.
// These tests confirm create() now actually calls Expo's push API with the right
// recipients, and that a push-delivery failure never breaks notification creation itself.
describe('NotificationsService push delivery', () => {
  let queryRawUnsafe: jest.Mock;
  let service: NotificationsService;
  let fetchMock: jest.Mock;

  const notificationRow = {
    id: 'notif-1', userId: 'user-1', role: null, title: 'Hi', body: 'Body', tone: 'INFO',
    entity: null, entityId: null, actionUrl: null, readAt: null, createdAt: new Date(),
  };

  beforeEach(() => {
    queryRawUnsafe = jest.fn();
    const prisma = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService;
    service = new NotificationsService(prisma);
    fetchMock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  it('sends a real push to every token registered for a specific userId', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([notificationRow]) // the insert
      .mockResolvedValueOnce([{ token: 'ExponentPushToken[aaa]' }, { token: 'ExponentPushToken[bbb]' }]); // resolvePushTokens

    await service.create({ userId: 'user-1', title: 'Hi', body: 'Body' });

    expect(fetchMock).toHaveBeenCalledWith('https://exp.host/--/api/v2/push/send', expect.objectContaining({ method: 'POST' }));
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(sentBody).toHaveLength(2);
    expect(sentBody[0]).toMatchObject({ to: 'ExponentPushToken[aaa]', title: 'Hi', body: 'Body' });
  });

  it('sends to every token belonging to a role when broadcasting by role instead of userId', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{ ...notificationRow, userId: null, role: 'DISPATCHER' }])
      .mockResolvedValueOnce([{ token: 'ExponentPushToken[ccc]' }]);

    await service.create({ role: 'DISPATCHER', title: 'Alert', body: 'New dispute' });

    expect(queryRawUnsafe).toHaveBeenLastCalledWith(expect.stringContaining('join "User"'), 'DISPATCHER');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call the push API at all when there are no registered tokens', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([notificationRow])
      .mockResolvedValueOnce([]);

    await service.create({ userId: 'user-1', title: 'Hi', body: 'Body' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still returns the created notification even if push delivery throws', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([notificationRow])
      .mockRejectedValueOnce(new Error('db unavailable for token lookup'));

    const result = await service.create({ userId: 'user-1', title: 'Hi', body: 'Body' });

    expect(result.id).toBe('notif-1');
  });
});
