import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommunicationService } from './communication.service';
import { TranslationProviderService } from '../integrations/translation-provider.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { AuthUser } from '../common/types/auth-user';

const customer: AuthUser = { sub: 'customer-1', email: 'c@x.com', role: 'CUSTOMER' } as AuthUser;

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    conversation: {
      upsert: jest.fn().mockResolvedValue({ id: 'conv-1', customerId: 'customer-1', driverId: 'driver-1' }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    message: {
      create: jest.fn().mockResolvedValue({
        id: 'msg-1', conversationId: 'conv-1', senderId: 'customer-1', kind: 'TEXT', body: 'hello',
        attachmentUrl: null, transcript: null, durationSeconds: null,
        translatedText: null, translatedLanguage: null, sourceLanguage: null,
        deliveryStatus: 'SENT', readAt: null, createdAt: new Date(),
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ preferredLanguage: 'en' }),
    },
    ...overrides,
  } as unknown as PrismaService;
}

// sendMessage()/listMessages() used to fall back to a fabricated "sent"/"empty preview
// thread" response on ANY failure of the real DB operation - the sender could see their
// message as delivered while the recipient never received it, since nothing was saved.
describe('CommunicationService never fakes success on failure', () => {
  function buildService(prisma: PrismaService, translationProvider?: TranslationProviderService) {
    const notifications = {} as NotificationsService;
    return new CommunicationService(
      {} as ConfigService,
      prisma,
      notifications,
      translationProvider ?? ({ translate: jest.fn().mockResolvedValue(null), transcribe: jest.fn(), status: jest.fn() } as unknown as TranslationProviderService),
    );
  }

  it('sendMessage throws a real error instead of a fake "sent" message when the insert fails', async () => {
    const prisma = buildPrisma({
      message: { create: jest.fn().mockRejectedValue(new Error('connection reset')), findMany: jest.fn() },
    });
    const service = buildService(prisma);

    await expect(service.sendMessage('conv-1', 'customer-1', { kind: 'TEXT', body: 'hello' } as never, customer))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('listMessages throws a real error instead of a fake preview thread when the read fails', async () => {
    const prisma = buildPrisma({
      message: { create: jest.fn(), findMany: jest.fn().mockRejectedValue(new Error('connection reset')) },
    });
    const service = buildService(prisma);

    await expect(service.listMessages('conv-1', customer)).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('still returns a real message on genuine success', async () => {
    const prisma = buildPrisma();
    const service = buildService(prisma);

    const result = await service.sendMessage('conv-1', 'customer-1', { kind: 'TEXT', body: 'hello' } as never, customer);

    expect(result.id).toBe('msg-1');
    expect(result.body).toBe('hello');
  });
});

// Translation is a best-effort side effect layered on top of the real send - it must
// never block the message, and must never run a pointless API call when both
// participants already share a language.
describe('CommunicationService.sendMessage translation for the recipient', () => {
  function buildService(prisma: PrismaService, translate: jest.Mock) {
    const translationProvider = { translate, transcribe: jest.fn(), status: jest.fn() } as unknown as TranslationProviderService;
    return new CommunicationService({} as ConfigService, prisma, {} as NotificationsService, translationProvider);
  }

  it('skips the translate() call entirely when sender and recipient share a language', async () => {
    const translate = jest.fn();
    const prisma = buildPrisma({
      user: { findUnique: jest.fn().mockResolvedValue({ preferredLanguage: 'en' }) },
    });
    const service = buildService(prisma, translate);

    await service.sendMessage('conv-1', 'customer-1', { kind: 'TEXT', body: 'hello' } as never, customer);

    expect(translate).not.toHaveBeenCalled();
  });

  it('calls translate() and stores the result when the recipient prefers a different language', async () => {
    const translate = jest.fn().mockResolvedValue({ translatedText: 'bawo ni', detectedSourceLanguage: 'en' });
    const userFindUnique = jest.fn()
      .mockResolvedValueOnce({ preferredLanguage: 'en' }) // sender
      .mockResolvedValueOnce({ preferredLanguage: 'yo' }); // recipient
    const messageCreate = jest.fn().mockResolvedValue({
      id: 'msg-1', conversationId: 'conv-1', senderId: 'customer-1', kind: 'TEXT', body: 'hello',
      attachmentUrl: null, transcript: null, durationSeconds: null,
      translatedText: 'bawo ni', translatedLanguage: 'yo', sourceLanguage: 'en',
      deliveryStatus: 'SENT', readAt: null, createdAt: new Date(),
    });
    const prisma = buildPrisma({ user: { findUnique: userFindUnique }, message: { create: messageCreate, findMany: jest.fn() } });
    const service = buildService(prisma, translate);

    const result = await service.sendMessage('conv-1', 'customer-1', { kind: 'TEXT', body: 'hello' } as never, customer);

    expect(translate).toHaveBeenCalledWith('hello', 'yo');
    expect(messageCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ translatedText: 'bawo ni', translatedLanguage: 'yo', sourceLanguage: 'en' }),
    }));
    expect(result.translatedText).toBe('bawo ni');
  });

  it('still sends the message when translation fails or throws', async () => {
    const translate = jest.fn().mockRejectedValue(new Error('provider down'));
    const userFindUnique = jest.fn()
      .mockResolvedValueOnce({ preferredLanguage: 'en' })
      .mockResolvedValueOnce({ preferredLanguage: 'yo' });
    const prisma = buildPrisma({ user: { findUnique: userFindUnique } });
    const service = buildService(prisma, translate);

    const result = await service.sendMessage('conv-1', 'customer-1', { kind: 'TEXT', body: 'hello' } as never, customer);

    expect(result.id).toBe('msg-1');
  });
});

// transcribeVoiceNote() used to be an unconditional stub that never called anything real.
describe('CommunicationService.transcribeVoiceNote', () => {
  function buildService(transcribe: jest.Mock, statusOverride?: Partial<{ transcriptionEnabled: boolean }>) {
    const translationProvider = {
      translate: jest.fn(),
      transcribe,
      status: jest.fn().mockReturnValue({ transcriptionEnabled: false, ...statusOverride }),
    } as unknown as TranslationProviderService;
    return new CommunicationService({} as ConfigService, {} as PrismaService, {} as NotificationsService, translationProvider);
  }

  it('returns the real transcript when base64 audio is provided and transcription succeeds', async () => {
    const transcribe = jest.fn().mockResolvedValue({ transcript: 'good morning', detectedLanguage: 'en' });
    const service = buildService(transcribe, { transcriptionEnabled: true });

    const result = await service.transcribeVoiceNote({ durationSeconds: 4, base64: 'AAAA', mimeType: 'audio/webm' } as never);

    expect(result.transcript).toBe('good morning');
  });

  it('returns an honest unavailable reason, not a fake transcript, when unconfigured', async () => {
    const transcribe = jest.fn().mockResolvedValue(null);
    const service = buildService(transcribe, { transcriptionEnabled: false });

    const result = await service.transcribeVoiceNote({ durationSeconds: 4 } as never);

    expect(result.transcript).toBe('');
    expect(result.unavailableReason).toContain('not configured');
  });
});

// uploadMedia() is the backing endpoint for KYC document capture, driver/vehicle
// document uploads, and chat voice/photo attachments. It used to (a) fall back to a
// fake "uploaded: true" response with a locally-generated id whenever the MediaAsset
// insert failed - the file could be genuinely lost while every caller believed it was
// saved - and (b) silently accept a bare device-local URI (no real file content) as if
// it were a real, storable, shareable URL, which MessageThreadScreen's retryMessage()
// on the frontend genuinely sends when re-sending a failed voice/photo message.
describe('CommunicationService.uploadMedia never fakes success on failure', () => {
  function buildService(prisma: Partial<PrismaService>, config: Partial<{ get: jest.Mock }> = {}) {
    const configService = { get: jest.fn().mockReturnValue(undefined), ...config } as unknown as ConfigService;
    const translationProvider = { translate: jest.fn(), transcribe: jest.fn(), status: jest.fn() } as unknown as TranslationProviderService;
    return new CommunicationService(configService, prisma as PrismaService, {} as NotificationsService, translationProvider);
  }

  it('throws instead of a fake "uploaded: true" echo when the MediaAsset insert fails', async () => {
    const service = buildService({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')) });

    await expect(service.uploadMedia({ kind: 'DOCUMENT', base64: 'AAAA', mimeType: 'image/png' }, 'user-1'))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('rejects a bare local device URI with no real file content instead of storing it as if it were a real URL', async () => {
    const queryRawUnsafe = jest.fn();
    const service = buildService({ $queryRawUnsafe: queryRawUnsafe });

    await expect(service.uploadMedia({ kind: 'VOICE_NOTE', localUri: 'file:///var/mobile/recording.m4a' }, 'user-1'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('embeds the real file content inline when no object storage is configured (honest degraded mode)', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([{
      id: 'media-1', kind: 'DOCUMENT', url: 'data:image/png;base64,AAAA', storageKey: 'inline/1', label: 'Doc',
      transcript: undefined, durationSeconds: undefined, createdAt: new Date(),
    }]);
    const service = buildService({ $queryRawUnsafe: queryRawUnsafe });

    const result = await service.uploadMedia({ kind: 'DOCUMENT', base64: 'AAAA', mimeType: 'image/png' }, 'user-1');

    expect(result.uploaded).toBe(true);
    expect(queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), null, null, 'DOCUMENT', 'data:image/png;base64,AAAA', expect.stringContaining('inline/'), 'Uploaded media', null, null, 'image/png', 'user-1', expect.any(String));
  });

  it('throws instead of silently falling back to a broken data: URI when real object storage is configured but the upload fails', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    try {
      const service = buildService(
        { $queryRawUnsafe: jest.fn() },
        { get: jest.fn((key: string) => ({
            SUPABASE_URL: 'https://example.supabase.co',
            SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
          } as Record<string, string>)[key]) },
      );

      await expect(service.uploadMedia({ kind: 'DOCUMENT', base64: 'AAAA', mimeType: 'image/png' }, 'user-1'))
        .rejects.toBeInstanceOf(InternalServerErrorException);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
