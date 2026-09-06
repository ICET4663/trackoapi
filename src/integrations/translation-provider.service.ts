import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleAuth } from 'google-auth-library';

// Tracko's internal language codes are bare ISO 639-1 (matches the frontend's
// SUPPORTED_LANGUAGES in src/i18n/index.ts). Google Cloud Translation v2 accepts these
// directly; Speech-to-Text needs full BCP-47 region tags, hence the separate map below.
const SUPPORTED_LANGUAGES = ['en', 'ha', 'yo', 'ig'] as const;
type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const SPEECH_LANGUAGE_TAGS: Record<SupportedLanguage, string> = {
  // Chirp 2 does not currently list en-NG for synchronous recognition. en-US is
  // supported in the configured region and handles Nigerian English recordings.
  en: 'en-US',
  ha: 'ha-NG',
  yo: 'yo-NG',
  ig: 'ig-NG',
};

function isSupportedLanguage(value: string | null | undefined): value is SupportedLanguage {
  return value != null && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

@Injectable()
export class TranslationProviderService {
  private readonly logger = new Logger(TranslationProviderService.name);

  constructor(private readonly config: ConfigService) {}

  status() {
    const apiKey = this.config.get<string>('GOOGLE_CLOUD_API_KEY');
    const speechV2 = this.speechV2Credentials();
    return {
      provider: 'google',
      mode: apiKey || speechV2 ? 'configured' : 'mock',
      translationEnabled: Boolean(apiKey),
      transcriptionEnabled: Boolean(speechV2 || apiKey),
      transcriptionApi: speechV2 ? 'speech-to-text-v2-chirp' : apiKey ? 'speech-to-text-v1-english-fallback' : 'none',
      multilingualTranscriptionEnabled: Boolean(speechV2),
      supportedLanguages: SUPPORTED_LANGUAGES,
      requiredEnv: {
        translation: ['GOOGLE_CLOUD_API_KEY'],
        multilingualTranscription: ['GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_CLIENT_EMAIL', 'GOOGLE_CLOUD_PRIVATE_KEY'],
      },
    };
  }

  // Best-effort by design: a message must still send even if translation fails or isn't
  // configured. Returns null (not a fake translation) on any failure - callers must treat
  // null as "no translation available" and fall back to showing only the original text.
  async translate(text: string, targetLanguage: string, sourceLanguage?: string): Promise<{ translatedText: string; detectedSourceLanguage?: string } | null> {
    const apiKey = this.config.get<string>('GOOGLE_CLOUD_API_KEY');
    const trimmed = text.trim();
    if (!apiKey || !trimmed || !isSupportedLanguage(targetLanguage)) return null;

    try {
      const response = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: trimmed,
          target: targetLanguage,
          ...(sourceLanguage && isSupportedLanguage(sourceLanguage) ? { source: sourceLanguage } : {}),
          format: 'text',
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        data?: { translations?: { translatedText: string; detectedSourceLanguage?: string }[] };
        error?: { message?: string };
      } | null;
      const translation = payload?.data?.translations?.[0];
      if (!response.ok || !translation?.translatedText) {
        this.logger.warn(`translate() failed: ${payload?.error?.message ?? response.statusText}`);
        return null;
      }
      return { translatedText: translation.translatedText, detectedSourceLanguage: translation.detectedSourceLanguage };
    } catch (error) {
      this.logger.warn(`translate() threw: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // Same best-effort contract as translate(): null means "not available", never a fake
  // transcript. languageHint narrows Google's guess among Tracko's 4 supported languages
  // (passed as alternativeLanguageCodes) rather than forcing a single language.
  async transcribe(base64Audio: string, mimeType: string, languageHint?: string): Promise<{ transcript: string; detectedLanguage?: string } | null> {
    const apiKey = this.config.get<string>('GOOGLE_CLOUD_API_KEY');
    const primary = isSupportedLanguage(languageHint) ? languageHint : 'en';
    if (!base64Audio.trim()) return null;

    const speechV2 = this.speechV2Credentials();
    if (speechV2) return this.transcribeV2(base64Audio, primary, speechV2);
    // The legacy V1 recognizer does not provide the Chirp coverage Tracko needs for
    // Hausa, Igbo, and Yoruba. Keep it only as an English fallback while V2 service
    // account credentials are being configured.
    if (!apiKey || primary !== 'en') return null;

    const alternatives = SUPPORTED_LANGUAGES.filter((code) => code !== primary).map((code) => SPEECH_LANGUAGE_TAGS[code]);

    try {
      const response = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            encoding: this.encodingForMimeType(mimeType),
            languageCode: SPEECH_LANGUAGE_TAGS[primary],
            alternativeLanguageCodes: alternatives,
            enableAutomaticPunctuation: true,
          },
          audio: { content: base64Audio },
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        results?: { alternatives?: { transcript?: string }[]; languageCode?: string }[];
        error?: { message?: string };
      } | null;
      const result = payload?.results?.[0];
      const transcript = result?.alternatives?.[0]?.transcript?.trim();
      if (!response.ok || !transcript) {
        this.logger.warn(`transcribe() failed: ${payload?.error?.message ?? response.statusText}`);
        return null;
      }
      const detected = result?.languageCode?.split('-')[0];
      return { transcript, detectedLanguage: isSupportedLanguage(detected) ? detected : undefined };
    } catch (error) {
      this.logger.warn(`transcribe() threw: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private speechV2Credentials() {
    const projectId = this.config.get<string>('GOOGLE_CLOUD_PROJECT_ID')?.trim();
    const clientEmail = this.config.get<string>('GOOGLE_CLOUD_CLIENT_EMAIL')?.trim();
    const privateKey = this.config.get<string>('GOOGLE_CLOUD_PRIVATE_KEY')?.replace(/\\n/g, '\n').trim();
    if (!projectId || !clientEmail || !privateKey) return null;
    return { projectId, clientEmail, privateKey };
  }

  private async transcribeV2(
    base64Audio: string,
    language: SupportedLanguage,
    credentials: { projectId: string; clientEmail: string; privateKey: string },
  ): Promise<{ transcript: string; detectedLanguage?: string } | null> {
    const location = this.config.get<string>('GOOGLE_SPEECH_LOCATION')?.trim() || 'us-central1';
    const model = this.config.get<string>('GOOGLE_SPEECH_MODEL')?.trim() || 'chirp_2';

    try {
      const auth = new GoogleAuth({
        credentials: {
          client_email: credentials.clientEmail,
          private_key: credentials.privateKey,
        },
        projectId: credentials.projectId,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      const accessToken = await auth.getAccessToken();
      if (!accessToken) return null;

      const response = await fetch(
        `https://speech.googleapis.com/v2/projects/${encodeURIComponent(credentials.projectId)}/locations/${encodeURIComponent(location)}/recognizers/_:recognize`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            config: {
              autoDecodingConfig: {},
              languageCodes: [SPEECH_LANGUAGE_TAGS[language]],
              model,
              features: { enableAutomaticPunctuation: true },
            },
            content: base64Audio,
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as {
        results?: { alternatives?: { transcript?: string }[]; languageCode?: string }[];
        error?: { message?: string };
      } | null;
      const transcript = payload?.results
        ?.flatMap((result) => result.alternatives?.[0]?.transcript?.trim() ?? [])
        .filter(Boolean)
        .join(' ')
        .trim();
      if (!response.ok || !transcript) {
        this.logger.warn(`transcribeV2() failed: ${payload?.error?.message ?? response.statusText}`);
        return null;
      }
      const detected = payload?.results?.find((result) => result.languageCode)?.languageCode?.split('-')[0];
      return { transcript, detectedLanguage: isSupportedLanguage(detected) ? detected : language };
    } catch (error) {
      this.logger.warn(`transcribeV2() threw: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // Google STT wants a codec name, not a raw MIME type. Covers audio/webm (web
  // recordings) and audio/ogg/wav cleanly. NOTE: native recordings from
  // voice-recording-service.ts are audio/m4a (AAC) - Google's v1 encoding enum has no
  // M4A/AAC entry, so this returns undefined for it and lets Google attempt
  // container auto-detection, which is not reliable for raw AAC. In practice this means
  // native-app transcription via this endpoint may fail even when configured; the
  // client-side transcript (already sent with the message on web/custom builds) remains
  // the primary transcription path, and translation of that pre-existing transcript text
  // is this service's real value-add regardless of which path produced it.
  private encodingForMimeType(mimeType: string): string | undefined {
    const normalized = mimeType.toLowerCase();
    if (normalized.includes('webm')) return 'WEBM_OPUS';
    if (normalized.includes('ogg')) return 'OGG_OPUS';
    if (normalized.includes('wav')) return 'LINEAR16';
    return undefined;
  }
}
