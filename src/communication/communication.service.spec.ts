import { InternalServerErrorException } from '@nestjs/common';
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
