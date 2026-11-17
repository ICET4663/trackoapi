import { CommunicationController } from './communication.controller';
import type { CommunicationService } from './communication.service';
import type { RequestUserService } from '../common/request-user.service';
import type { DispatchSweepService } from '../shipments/dispatch-sweep.service';

describe('GET /conversations keeps the dispatch sweep running', () => {
  const user = { sub: 'customer-1', role: 'CUSTOMER' };
  const requestUser = { fromAuthorizationHeader: jest.fn().mockResolvedValue(user) } as unknown as RequestUserService;
  const conversations = [{ id: 'c1' }];

  it('returns the inbox and asks the sweep to run if it is due', async () => {
    const service = { listConversations: jest.fn().mockResolvedValue(conversations) } as unknown as CommunicationService;
    const sweep = { runIfDue: jest.fn().mockResolvedValue(true) } as unknown as DispatchSweepService;

    await expect(new CommunicationController(service, requestUser, sweep).listConversations('Bearer t')).resolves.toBe(conversations);
    expect(sweep.runIfDue).toHaveBeenCalledTimes(1);
  });

  it('does not start the sweep for a caller who is not signed in', async () => {
    const refused = { fromAuthorizationHeader: jest.fn().mockRejectedValue(new Error('Unauthorized')) } as unknown as RequestUserService;
    const sweep = { runIfDue: jest.fn() } as unknown as DispatchSweepService;

    await expect(new CommunicationController({} as CommunicationService, refused, sweep).listConversations(undefined)).rejects.toThrow('Unauthorized');
    expect(sweep.runIfDue).not.toHaveBeenCalled();
  });

  it('still works without the sweep wired in', async () => {
    const service = { listConversations: jest.fn().mockResolvedValue(conversations) } as unknown as CommunicationService;

    await expect(new CommunicationController(service, requestUser).listConversations('Bearer t')).resolves.toBe(conversations);
  });
});
