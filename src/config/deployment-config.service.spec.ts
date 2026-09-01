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
    expect(result.keyConfigured).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Observed live: a real Resend API key that's scoped to "Sending access" only (Resend's
  // more restrictive option) can send emails fine via /emails but gets a 401 from
  // /domains. That must not be reported the same as "no key configured at all" - sending
  // may well already work.
  it('distinguishes "key exists but domain check was refused" from "no key at all"', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'This API key is restricted to only send emails' }),
    }) as never;
    const service = buildService('re_fake_key');

    const result = await service.emailDomainStatus();

    expect(result.checked).toBe(false);
    expect(result.keyConfigured).toBe(true);
    expect(result.message).toContain('401');
    expect(result.message).toContain('Sending access');
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

// storageStatus() is the live diagnostic behind /v1/demo/readiness's fileUploads section -
// every upload (KYC/driver/vehicle documents, chat attachments) depends on this being
// reachable. Env vars alone can't tell you whether the URL is actually valid or the
// bucket exists, only whether values are set.
describe('DeploymentConfigService.storageStatus', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  function buildStorageService(env: Record<string, string | undefined>) {
    const config = { get: jest.fn((key: string) => env[key]) } as unknown as ConfigService;
    return new DeploymentConfigService(config);
  }

  it('reports unchecked without calling the network when neither URL nor key is set', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    const service = buildStorageService({});

    const result = await service.storageStatus();

    expect(result.checked).toBe(false);
    expect(result.urlConfigured).toBe(false);
    expect(result.keyConfigured).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the bucket as missing (not a generic failure) on a 404 from Supabase', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 404, ok: false }) as never;
    const service = buildStorageService({ SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' });

    const result = await service.storageStatus();

    expect(result.checked).toBe(true);
    expect(result.bucketExists).toBe(false);
    expect(result.message).toContain('no "tracko-media" bucket exists');
  });

  it('reports connected when the bucket exists', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200, ok: true }) as never;
    const service = buildStorageService({ SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' });

    const result = await service.storageStatus();

    expect(result.checked).toBe(true);
    expect(result.bucketExists).toBe(true);
    expect(result.urlHost).toBe('proj.supabase.co');
  });

  // This is exactly the live failure observed against production: SUPABASE_URL and
  // SUPABASE_SERVICE_ROLE_KEY are both set, but the request never gets a response at all
  // (DNS failure, malformed host, connection refused) - Node's fetch throws "fetch failed"
  // rather than resolving to a response object.
  it('surfaces the real network error and a safe hostname when the request itself fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed')) as never;
    const service = buildStorageService({ SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' });

    const result = await service.storageStatus();

    expect(result.checked).toBe(false);
    expect(result.urlConfigured).toBe(true);
    expect(result.keyConfigured).toBe(true);
    expect(result.urlHost).toBe('proj.supabase.co');
    expect(result.message).toContain('fetch failed');
  });

  it('never throws even when SUPABASE_URL is not a valid URL', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to parse URL')) as never;
    const service = buildStorageService({ SUPABASE_URL: 'not-a-url', SUPABASE_SERVICE_ROLE_KEY: 'key' });

    const result = await service.storageStatus();

    expect(result.checked).toBe(false);
    expect(result.urlHost).toBe('invalid-url:"not-a-url"');
  });
});
