import { ConfigService } from '@nestjs/config';
import { GoogleAuth } from 'google-auth-library';
import { TranslationProviderService } from './translation-provider.service';

function buildService(apiKey: string | undefined) {
  const config = {
    get: jest.fn((key: string) => key === 'GOOGLE_CLOUD_API_KEY' ? apiKey : undefined),
  } as unknown as ConfigService;
  return new TranslationProviderService(config);
}

function buildServiceWith(values: Record<string, string | undefined>) {
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  return new TranslationProviderService(config);
}

describe('TranslationProviderService.status', () => {
  it('reports mock mode with nothing enabled when no key is configured', () => {
    expect(buildService(undefined).status()).toMatchObject({ mode: 'mock', translationEnabled: false, transcriptionEnabled: false });
  });

  it('reports configured mode when a key is present', () => {
    expect(buildService('key123').status()).toMatchObject({ mode: 'configured', translationEnabled: true, transcriptionEnabled: true });
  });

  it('reports translation enabled when service-account credentials are configured without an API key', () => {
    const service = buildServiceWith({
      GOOGLE_CLOUD_PROJECT_ID: 'project-1',
      GOOGLE_CLOUD_CLIENT_EMAIL: 'speech@project-1.iam.gserviceaccount.com',
      GOOGLE_CLOUD_PRIVATE_KEY: 'private-key',
    });

    expect(service.status()).toMatchObject({
      mode: 'configured',
      translationEnabled: true,
      multilingualTranscriptionEnabled: true,
    });
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
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

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

  it('translates Yoruba to English through authenticated Translation v3', async () => {
    jest.spyOn(GoogleAuth.prototype, 'getAccessToken').mockResolvedValue('access-token');
    const service = buildServiceWith({
      GOOGLE_CLOUD_PROJECT_ID: 'project-1',
      GOOGLE_CLOUD_CLIENT_EMAIL: 'speech@project-1.iam.gserviceaccount.com',
      GOOGLE_CLOUD_PRIVATE_KEY: 'private-key',
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        translations: [{ translatedText: 'Good morning', detectedLanguageCode: 'yo' }],
      }),
    }) as never;

    const result = await service.translate('E kaaro', 'en', 'yo');

    expect(result).toEqual({
      translatedText: 'Good morning',
      detectedSourceLanguage: 'yo',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://translation.googleapis.com/v3/projects/project-1:translateText',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
      }),
    );
  });

  it('translates Igbo to English through authenticated Translation v3', async () => {
    jest.spyOn(GoogleAuth.prototype, 'getAccessToken').mockResolvedValue('access-token');
    const service = buildServiceWith({
      GOOGLE_CLOUD_PROJECT_ID: 'project-1',
      GOOGLE_CLOUD_CLIENT_EMAIL: 'speech@project-1.iam.gserviceaccount.com',
      GOOGLE_CLOUD_PRIVATE_KEY: 'private-key',
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        translations: [{ translatedText: 'Good morning', detectedLanguageCode: 'ig' }],
      }),
    }) as never;

    const result = await service.translate('Ututu oma', 'en', 'ig');

    expect(result).toEqual({
      translatedText: 'Good morning',
      detectedSourceLanguage: 'ig',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://translation.googleapis.com/v3/projects/project-1:translateText',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"sourceLanguageCode":"ig"'),
      }),
    );
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

  it.each([
    ['yo', 'yo-NG', 'E kaaro'],
    ['ig', 'ig-NG', 'Ututu oma'],
    ['ha', 'ha-NG', 'Ina kwana'],
  ])('transcribes %s with Speech v2 Chirp using the selected language', async (language, languageCode, transcript) => {
    jest.spyOn(GoogleAuth.prototype, 'getAccessToken').mockResolvedValue('access-token');
    const service = buildServiceWith({
      GOOGLE_CLOUD_PROJECT_ID: 'project-1',
      GOOGLE_CLOUD_CLIENT_EMAIL: 'speech@project-1.iam.gserviceaccount.com',
      GOOGLE_CLOUD_PRIVATE_KEY: 'private-key',
      GOOGLE_SPEECH_LOCATION: 'us-central1',
      GOOGLE_SPEECH_MODEL: 'chirp_2',
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ alternatives: [{ transcript }], languageCode }],
      }),
    }) as never;

    const result = await service.transcribe('base64audio', 'audio/webm;codecs=opus', language);

    expect(result).toEqual({ transcript, detectedLanguage: language });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://speech.googleapis.com/v2/projects/project-1/locations/us-central1/recognizers/_:recognize',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
        body: expect.stringContaining(`"languageCodes":["${languageCode}"]`),
      }),
    );
  });

  it('retries with the "chirp" model when the default "chirp_2" model rejects the language, and no model was explicitly configured', async () => {
    jest.spyOn(GoogleAuth.prototype, 'getAccessToken').mockResolvedValue('access-token');
    const service = buildServiceWith({
      GOOGLE_CLOUD_PROJECT_ID: 'project-1',
      GOOGLE_CLOUD_CLIENT_EMAIL: 'speech@project-1.iam.gserviceaccount.com',
      GOOGLE_CLOUD_PRIVATE_KEY: 'private-key',
    });
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ error: { message: 'chirp_2 does not support yo-NG' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ alternatives: [{ transcript: 'E kaaro' }], languageCode: 'yo-NG' }] }) });
    global.fetch = fetchMock as never;

    const result = await service.transcribe('base64audio', 'audio/webm;codecs=opus', 'yo');

    expect(result).toEqual({ transcript: 'E kaaro', detectedLanguage: 'yo' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toEqual(expect.stringContaining('"model":"chirp_2"'));
    expect(fetchMock.mock.calls[1][1].body).toEqual(expect.stringContaining('"model":"chirp"'));
  });

  it('does not retry with a different model when GOOGLE_SPEECH_MODEL was explicitly configured', async () => {
    jest.spyOn(GoogleAuth.prototype, 'getAccessToken').mockResolvedValue('access-token');
    const service = buildServiceWith({
      GOOGLE_CLOUD_PROJECT_ID: 'project-1',
      GOOGLE_CLOUD_CLIENT_EMAIL: 'speech@project-1.iam.gserviceaccount.com',
      GOOGLE_CLOUD_PRIVATE_KEY: 'private-key',
      GOOGLE_SPEECH_MODEL: 'chirp_2',
    });
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ error: { message: 'unsupported' } }) });
    global.fetch = fetchMock as never;

    const result = await service.transcribe('base64audio', 'audio/webm;codecs=opus', 'yo');

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('transcribe() returns null when the access token cannot be obtained, without throwing', async () => {
    jest.spyOn(GoogleAuth.prototype, 'getAccessToken').mockResolvedValue(undefined as never);
    const service = buildServiceWith({
      GOOGLE_CLOUD_PROJECT_ID: 'project-1',
      GOOGLE_CLOUD_CLIENT_EMAIL: 'speech@project-1.iam.gserviceaccount.com',
      GOOGLE_CLOUD_PRIVATE_KEY: 'private-key',
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;

    expect(await service.transcribe('base64audio', 'audio/webm;codecs=opus', 'yo')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

