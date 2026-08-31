import { ConfigService } from '@nestjs/config';
import { TranslationProviderService } from './translation-provider.service';

function buildService(apiKey: string | undefined) {
  const config = { get: jest.fn().mockReturnValue(apiKey) } as unknown as ConfigService;
  return new TranslationProviderService(config);
}

describe('TranslationProviderService.status', () => {
  it('reports mock mode with nothing enabled when no key is configured', () => {
    expect(buildService(undefined).status()).toMatchObject({ mode: 'mock', translationEnabled: false, transcriptionEnabled: false });
  });

  it('reports configured mode when a key is present', () => {
    expect(buildService('key123').status()).toMatchObject({ mode: 'configured', translationEnabled: true, transcriptionEnabled: true });
  });
});

// Both translate() and transcribe() must return null - never a fabricated
// translation/transcript - on any failure, since callers treat null as "not available"
// and fall back to showing only the original text/nothing.
describe('TranslationProviderService never fabricates a result on failure', () => {
  // A plain `global.fetch = jest.fn()` assignment (not jest.spyOn) leaks across test
  // files sharing a worker process - jest.restoreAllMocks() does not undo it, only spies.
  // Confirmed this was actually happening: it broke an unrelated file's tests
  // (maps-provider.service.spec.ts) when both ran in the same worker.
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('translate() returns null, not a fake translation, when unconfigured', async () => {
    const service = buildService(undefined);
    expect(await service.translate('hello', 'yo')).toBeNull();
  });

  it('translate() returns null when the API call fails', async () => {
    const service = buildService('key123');
    global.fetch = jest.fn().mockResolvedValue({ ok: false, statusText: 'Bad Request', json: async () => ({ error: { message: 'invalid target' } }) }) as never;

    expect(await service.translate('hello', 'yo')).toBeNull();
  });

  it('translate() returns null when fetch throws', async () => {
    const service = buildService('key123');
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as never;

    expect(await service.translate('hello', 'yo')).toBeNull();
  });

  it('translate() returns the real translated text on success', async () => {
    const service = buildService('key123');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { translations: [{ translatedText: 'bawo ni', detectedSourceLanguage: 'en' }] } }),
    }) as never;

    const result = await service.translate('hello', 'yo');

    expect(result).toEqual({ translatedText: 'bawo ni', detectedSourceLanguage: 'en' });
  });

  it('translate() rejects an unsupported target language before ever calling fetch', async () => {
    const service = buildService('key123');
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;

    expect(await service.translate('hello', 'fr')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('transcribe() returns null, not a fake transcript, when unconfigured', async () => {
    const service = buildService(undefined);
    expect(await service.transcribe('base64audio', 'audio/webm')).toBeNull();
  });

  it('transcribe() returns the real transcript on success', async () => {
    const service = buildService('key123');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ alternatives: [{ transcript: 'good morning' }], languageCode: 'en-US' }] }),
    }) as never;

    const result = await service.transcribe('base64audio', 'audio/webm', 'en');

    expect(result).toEqual({ transcript: 'good morning', detectedLanguage: 'en' });
  });
});
