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
  const originalFetch = global.fetch;

  const notificationRow = {
    id: 'notif-1', userId: 'user-1', role: null, title: 'Hi', body: 'Body', tone: 'INFO',
    entity: null, entityId: null, actionUrl: null, readAt: null, createdAt: new Date(),
  };

  afterEach(() => { global.fetch = originalFetch; });

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

    expect(result).not.toBeNull();
    expect(result?.id).toBe('notif-1');
  });
});

// create() used to fall back to a fabricated, never-persisted notification on any insert
// failure - every caller across the codebase believed the recipient had been notified
// when nothing was actually saved. It's deliberately kept non-throwing (several callers
// rely on that), but a failure must return null (never fake data) so it's at least honest.
describe('NotificationsService.create never fakes a persisted notification on failure', () => {
  it('returns null, not a fake notification, when the insert fails', async () => {
    const queryRawUnsafe = jest.fn().mockRejectedValue(new Error('connection reset'));
    const service = new NotificationsService({ $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService);

    const result = await service.create({ userId: 'user-1', title: 'Hi', body: 'Body' });

    expect(result).toBeNull();
  });
});

// list()/unreadCount()/markRead()/markAllRead()/registerPushToken() used to fall back to
// fake data (a canned "preview" notification, a phantom "1 unread", a fake "read"
// confirmation, "registered: true" for a token that was never saved) on any DB failure.
describe('NotificationsService other methods never fake success on failure', () => {
  function buildService(queryRawUnsafe: jest.Mock) {
    return new NotificationsService({ $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService);
  }

  it('list() throws a real error instead of a fake preview notification when the read fails', async () => {
    const service = buildService(jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.list('user-1', 'CUSTOMER')).rejects.toThrow();
  });

  it('list() returns a genuinely empty list, not a fake notification, when there are none', async () => {
    const service = buildService(jest.fn().mockResolvedValue([]));

    expect(await service.list('user-1', 'CUSTOMER')).toEqual([]);
  });

  it('unreadCount() returns an honest 0, not the old fake "1", on a read failure', async () => {
    const service = buildService(jest.fn().mockRejectedValue(new Error('connection reset')));

    expect(await service.unreadCount('user-1', 'CUSTOMER')).toEqual({ unreadCount: 0 });
  });

  it('markRead() throws instead of a fake "read" confirmation when the update fails', async () => {
    const service = buildService(jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.markRead('notif-1', 'user-1', 'CUSTOMER')).rejects.toThrow();
  });

  it('markRead() throws NotFoundException instead of fake success for a notification that is not theirs', async () => {
    const service = buildService(jest.fn().mockResolvedValue([]));

    await expect(service.markRead('notif-1', 'user-1', 'CUSTOMER')).rejects.toThrow('not found');
  });

  it('markAllRead() throws instead of silently claiming success when the update fails', async () => {
    const service = buildService(jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.markAllRead('user-1', 'CUSTOMER')).rejects.toThrow();
  });

  it('registerPushToken() throws instead of claiming "registered: true" when the insert fails', async () => {
    const service = buildService(jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.registerPushToken('user-1', 'ExponentPushToken[aaa]')).rejects.toThrow();
  });
});
