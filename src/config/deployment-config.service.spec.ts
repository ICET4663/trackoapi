import { ConfigService } from '@nestjs/config';
import { DeploymentConfigService } from './deployment-config.service';

function buildService(apiKey: string | undefined) {
  const config = { get: jest.fn((key: string) => (key === 'RESEND_API_KEY' ? apiKey : undefined)) } as unknown as ConfigService;
  return new DeploymentConfigService(config);
}

describe('DeploymentConfigService.emailDomainStatus', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('reports unchecked when RESEND_API_KEY is not set, without calling the network', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    const service = buildService(undefined);

    const result = await service.emailDomainStatus();

    expect(result.checked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a verified domain when Resend confirms one', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ name: 'tracko.ng', status: 'verified' }] }),
    }) as never;
    const service = buildService('re_fake_key');

    const result = await service.emailDomainStatus();

    expect(result.checked).toBe(true);
    expect(result.verifiedDomains).toEqual(['tracko.ng']);
    expect(result.message).toContain('tracko.ng');
  });

  it('reports sandbox-only when a domain is added but not yet verified', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ name: 'tracko.ng', status: 'pending' }] }),
    }) as never;
    const service = buildService('re_fake_key');

    const result = await service.emailDomainStatus();

    expect(result.verifiedDomains).toEqual([]);
    expect(result.pendingDomains).toEqual(['tracko.ng']);
    expect(result.message).toContain('not yet verified');
  });

  it('reports sandbox-only when no domain has been added at all', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }) as never;
    const service = buildService('re_fake_key');

    const result = await service.emailDomainStatus();

    expect(result.message).toContain('No domain added');
  });

  it('never throws when the Resend API call fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as never;
    const service = buildService('re_fake_key');

    const result = await service.emailDomainStatus();

    expect(result.checked).toBe(false);
    expect(result.message).toContain('network down');
  });
});
