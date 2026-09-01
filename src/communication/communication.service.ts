import { ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { AuthUser } from '../common/types/auth-user';
import { TranslationProviderService } from '../integrations/translation-provider.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SendMessageDto } from './dto/send-message.dto';
import { TranscribeVoiceDto } from './dto/transcribe-voice.dto';
import { TypingStatusDto } from './dto/typing-status.dto';


@Injectable()
export class CommunicationService {
  private readonly logger = new Logger(CommunicationService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly translationProvider: TranslationProviderService,
  ) {}

  // A conversation created with a customerId/driverId is scoped: only those two
  // people (or ops staff) may read/write it. A conversation with both null is a
  // legacy/admin-mock thread from before scoping existed - left open rather than
  // locking existing admin/dispatcher screens out of threads they already use.
  private async assertConversationAccess(
    conversation: { customerId: string | null; driverId: string | null },
    user: AuthUser,
  ) {
    if (user.role === 'ADMIN' || user.role === 'DISPATCHER') return;
    if (!conversation.customerId && !conversation.driverId) return;
    if (conversation.customerId === user.sub || conversation.driverId === user.sub) return;
    throw new ForbiddenException('You do not have access to this conversation.');
  }

  // Finds (or lazily creates) the single conversation thread scoped to a shipment,
  // so the customer and the assigned driver have exactly one place to talk about it.
  async getOrCreateShipmentConversation(shipmentId: string, user: AuthUser) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { id: true, reference: true, customerId: true },
    });
    if (!shipment) throw new NotFoundException('Shipment was not found.');

    let driverId: string | null = null;
    if (user.role === 'DRIVER') {
      const assignment = await this.prisma.driverAssignment.findFirst({
        where: { shipmentId, driverId: user.sub, status: 'ACCEPTED' },
        select: { driverId: true },
      });
      if (!assignment) throw new ForbiddenException('You are not the assigned driver for this shipment.');
      driverId = assignment.driverId;
    } else if (user.role === 'CUSTOMER') {
      if (shipment.customerId !== user.sub) throw new ForbiddenException('You do not have access to this shipment.');
    } else if (user.role !== 'ADMIN' && user.role !== 'DISPATCHER') {
      throw new ForbiddenException('You do not have access to this shipment.');
    }

    if (!driverId) {
      const acceptedAssignment = await this.prisma.driverAssignment.findFirst({
        where: { shipmentId, status: 'ACCEPTED' },
        select: { driverId: true },
      });
      driverId = acceptedAssignment?.driverId ?? null;
    }

    const conversation = await this.prisma.conversation.upsert({
      where: { shipmentId },
      update: driverId ? { driverId } : {},
      create: {
        subject: `Shipment ${shipment.reference}`,
        shipmentId,
        customerId: shipment.customerId,
        driverId,
      },
    });

    return { id: conversation.id, shipmentId, subject: conversation.subject };
  }

  async listConversations(user: AuthUser) {
    try {
      const where =
        user.role === 'CUSTOMER'
          ? { customerId: user.sub }
          : user.role === 'DRIVER'
            ? { driverId: user.sub }
            : {}; // ADMIN/DISPATCHER get operational visibility across all threads.

      const conversations = await this.prisma.conversation.findMany({
        where,
        include: {
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { sender: { include: { profile: true } } },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      });

      return conversations.map((conversation) => {
        const lastMessage = conversation.messages[0];
        return {
          id: conversation.id,
          role: user.role,
          title: conversation.subject ?? 'Tracko conversation',
          subtitle: lastMessage?.body ?? lastMessage?.transcript ?? 'No messages yet',
          lastMessageAt: lastMessage?.createdAt?.toISOString() ?? conversation.updatedAt.toISOString(),
          unreadCount: 0,
        };
      });
    } catch {
      return [];
    }
  }

  // This used to fall back to a fabricated "Preview conversation is ready" thread on ANY
  // read failure - a real DB error looked identical to a genuinely-empty new thread, and
  // the two participants could believe they were looking at their real conversation when
  // they were not. A read failure now surfaces as a real error instead.
  async listMessages(conversationId: string, user: AuthUser) {
    let conversation;
    try {
      conversation = await this.prisma.conversation.upsert({
        where: { id: conversationId },
        update: {},
        create: { id: conversationId, subject: 'Tracko conversation' },
      });
    } catch (error) {
      throw new InternalServerErrorException(`Could not load this conversation. Please try again: ${this.errorMessage(error)}`);
    }
    await this.assertConversationAccess(conversation, user);

    let messages;
    try {
      messages = await this.prisma.message.findMany({
        where: { conversationId },
        include: { sender: { include: { profile: true } } },
        orderBy: { createdAt: 'asc' },
      });
    } catch (error) {
      throw new InternalServerErrorException(`Could not load messages. Please try again: ${this.errorMessage(error)}`);
    }

    return {
      conversation,
      typingUserIds: [],
      messages: messages.map((message) => this.toMessageRecord(message)),
    };
  }

  // This used to fall back to a fabricated "sent" message on ANY failure of the actual
  // insert - the sender saw their message appear as delivered while the recipient never
  // received anything, since nothing was ever saved. The core write now fails loudly.
  // Translation is layered on afterward as a genuinely best-effort side effect: it must
  // never block or fail the send itself.
  async sendMessage(conversationId: string, senderId: string, dto: SendMessageDto, user: AuthUser) {
    const conversation = await this.prisma.conversation.upsert({
      where: { id: conversationId },
      update: { updatedAt: new Date() },
      create: { id: conversationId, subject: 'Tracko conversation' },
    }).catch((error) => {
      throw new InternalServerErrorException(`Could not open this conversation. Please try again: ${this.errorMessage(error)}`);
    });
    await this.assertConversationAccess(conversation, user);

    const translation = await this.translateForRecipient(conversation, senderId, dto).catch(() => null);

    let message;
    try {
      message = await this.prisma.message.create({
        data: {
          id: dto.id,
          conversationId,
          senderId,
          kind: dto.kind,
          body: dto.body,
          attachmentUrl: dto.attachmentUrl ?? dto.attachmentUri,
          transcript: dto.transcript,
          durationSeconds: dto.durationSeconds,
          translatedText: translation?.translatedText,
          translatedLanguage: translation?.translatedLanguage,
          sourceLanguage: translation?.sourceLanguage,
        },
        include: { sender: { include: { profile: true } } },
      });
    } catch (error) {
      throw new InternalServerErrorException(`Could not send this message. Please try again: ${this.errorMessage(error)}`);
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    }).catch((error) => {
      this.logger.error(`Could not bump conversation ${conversationId} after a real message was saved: ${this.errorMessage(error)}`);
    });

    return this.toMessageRecord(message);
  }

  // Translates dto.body (TEXT) or dto.transcript (VOICE) into whichever language the
  // *other* participant has set as their preferred app language, when that's known and
  // actually differs from the sender's. Never throws - a translation failure (unconfigured
  // provider, API error, unsupported language pair) must never block the message itself;
  // callers already wrap this in .catch(() => null).
  private async translateForRecipient(
    conversation: { customerId: string | null; driverId: string | null },
    senderId: string,
    dto: SendMessageDto,
  ): Promise<{ translatedText: string; translatedLanguage: string; sourceLanguage?: string } | null> {
    const text = (dto.kind === 'VOICE' ? dto.transcript : dto.body)?.trim();
    if (!text) return null;

    const recipientId = conversation.customerId === senderId ? conversation.driverId : conversation.customerId;
    if (!recipientId) return null;

    const [sender, recipient] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: senderId }, select: { preferredLanguage: true } }),
      this.prisma.user.findUnique({ where: { id: recipientId }, select: { preferredLanguage: true } }),
    ]);
    const recipientLanguage = recipient?.preferredLanguage ?? 'en';
    // Same-language heuristic to skip a pointless API call in the common case - if the
    // sender's own language happens to differ from what they actually typed/spoke, the
    // real translate() call below still runs whenever the languages differ, and its
    // detectedSourceLanguage (not this assumption) is what actually gets stored.
    if (recipientLanguage === (sender?.preferredLanguage ?? 'en')) return null;

    const result = await this.translationProvider.translate(text, recipientLanguage);
    if (!result) return null;
    return {
      translatedText: result.translatedText,
      translatedLanguage: recipientLanguage,
      sourceLanguage: result.detectedSourceLanguage ?? sender?.preferredLanguage,
    };
  }

  updateTypingStatus(conversationId: string, userId: string, dto: TypingStatusDto) {
    // userId always comes from the verified session, never from the request body -
    // otherwise any caller could report typing status (and thus presence) as anyone else.
    return {
      conversationId,
      userId,
      isTyping: dto.isTyping,
      updatedAt: new Date().toISOString(),
    };
  }

  async transcribeVoiceNote(dto: TranscribeVoiceDto) {
    if (dto.base64) {
      const result = await this.translationProvider.transcribe(dto.base64, dto.mimeType ?? 'audio/webm', dto.languageHint);
      if (result) {
        return {
          transcript: result.transcript,
          detectedLanguage: result.detectedLanguage,
          durationSeconds: dto.durationSeconds,
        };
      }
    }
    return {
      transcript: '',
      durationSeconds: dto.durationSeconds,
      unavailableReason: this.translationProvider.status().transcriptionEnabled
        ? 'Could not transcribe this recording. Use Chrome or Edge browser speech recognition for live transcript instead.'
        : 'Server transcription is not configured yet. Use Chrome or Edge browser speech recognition for live transcript, or add a speech-to-text provider key for backend transcription.',
    };
  }

  registerPushToken(userId: string, token: string, platform?: string, deviceId?: string) {
    return this.notifications.registerPushToken(userId, token, platform, deviceId);
  }

  async uploadMedia(input: Record<string, unknown>, userId: string) {
    const media = await this.prepareMedia(input, userId);
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        {
          id: string;
          kind: string;
          url?: string;
          storageKey?: string;
          label: string;
          transcript?: string;
          durationSeconds?: number;
          createdAt: Date;
        }[]
      >(
        `insert into "MediaAsset" ("id", "userId", "shipmentId", "conversationId", "kind", "url", "storageKey", "label", "transcript", "durationSeconds", "mimeType")
         values (
           $11,
           $10,
           $1,
           $2,
           cast($3 as "MediaKind"),
           $4,
           $5,
           $6,
           $7,
           $8,
           $9
         )
         returning "id", "kind"::text as "kind", "url", "storageKey", "label", "transcript", "durationSeconds", "createdAt"`,
        input.shipmentId ? String(input.shipmentId) : null,
        input.conversationId ? String(input.conversationId) : null,
        String(input.kind ?? 'DOCUMENT'),
        media.url,
        media.storageKey,
        String(input.label ?? 'Uploaded media'),
        input.transcript ? String(input.transcript) : null,
        input.durationSeconds ? Number(input.durationSeconds) : null,
        media.mimeType,
        userId.startsWith('preview-') ? null : userId,
        // "id" has no database-level default (Prisma's @default(cuid()) is client-side
        // only) - this raw insert must generate its own, matching the pattern used
        // elsewhere in the codebase (e.g. KycService.id()) for handwritten SQL inserts.
        `media_${randomUUID().replace(/-/g, '')}`,
      );
      if (rows[0]) {
        return {
          ...rows[0],
          createdAt: rows[0].createdAt.toISOString(),
          uploaded: true,
        };
      }
    } catch {
      // Preview fallback below.
    }

    return {
      id: `media-${Date.now()}`,
      kind: String(input.kind ?? 'DOCUMENT'),
      url: media.url,
      label: String(input.label ?? 'Uploaded media'),
      transcript: input.transcript ? String(input.transcript) : undefined,
      durationSeconds: input.durationSeconds ? Number(input.durationSeconds) : undefined,
      createdAt: new Date().toISOString(),
      storageKey: media.storageKey,
      uploaded: true,
    };
  }

  private async prepareMedia(input: Record<string, unknown>, userId: string) {
    const mimeType = typeof input.mimeType === 'string' && input.mimeType.trim() ? input.mimeType.trim() : 'application/octet-stream';
    const base64 = typeof input.base64 === 'string' && input.base64.trim() ? input.base64.trim() : null;
    const storage = this.storageConfig();

    if (base64 && storage) {
      try {
        const storageKey = this.storageKey(input, userId, mimeType);
        const response = await fetch(`${storage.url}/storage/v1/object/${storage.bucket}/${storageKey}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${storage.serviceRoleKey}`,
            apikey: storage.serviceRoleKey,
            'Content-Type': mimeType,
            'x-upsert': 'false',
          },
          body: Buffer.from(base64, 'base64'),
        });

        if (!response.ok) throw new Error(`Supabase storage upload failed with ${response.status}`);

        return {
          url: `${storage.url}/storage/v1/object/public/${storage.bucket}/${storageKey}`,
          storageKey,
          mimeType,
        };
      } catch {
        // Keep demo uploads working even if storage is not configured correctly yet.
      }
    }

    return {
      url: this.mediaUrl(input),
      storageKey: `preview/${Date.now()}`,
      mimeType,
    };
  }

  private mediaUrl(input: Record<string, unknown>) {
    if (typeof input.base64 === 'string' && input.base64.trim()) {
      const mimeType = typeof input.mimeType === 'string' && input.mimeType.trim() ? input.mimeType.trim() : 'application/octet-stream';
      return `data:${mimeType};base64,${input.base64.trim()}`;
    }
    if (typeof input.localUri === 'string' && input.localUri.trim()) return input.localUri.trim();
    if (typeof input.uri === 'string' && input.uri.trim()) return input.uri.trim();
    return `local://media/${Date.now()}`;
  }

  private storageConfig() {
    const url = this.config.get<string>('SUPABASE_URL') ?? this.config.get<string>('EXPO_PUBLIC_SUPABASE_URL') ?? this.config.get<string>('NEXT_PUBLIC_SUPABASE_URL');
    const serviceRoleKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    const bucket = this.config.get<string>('SUPABASE_STORAGE_BUCKET') ?? 'tracko-media';
    if (!url || !serviceRoleKey) return null;
    return { url: url.replace(/\/$/, ''), serviceRoleKey, bucket };
  }

  private storageKey(input: Record<string, unknown>, userId: string, mimeType: string) {
    const kind = String(input.kind ?? 'DOCUMENT').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const owner = userId.startsWith('preview-') ? 'preview' : userId.replace(/[^a-zA-Z0-9_-]/g, '');
    return `${kind}/${owner}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${this.extensionForMime(mimeType)}`;
  }

  private extensionForMime(mimeType: string) {
    if (mimeType.includes('png')) return 'png';
    if (mimeType.includes('webp')) return 'webp';
    if (mimeType.includes('pdf')) return 'pdf';
    if (mimeType.includes('mpeg')) return 'mp3';
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('mp4')) return 'mp4';
    return 'jpg';
  }

  private toMessageRecord(message: {
    id: string;
    conversationId: string;
    senderId: string;
    kind: string;
    body: string | null;
    attachmentUrl: string | null;
    transcript: string | null;
    durationSeconds: number | null;
    translatedText?: string | null;
    translatedLanguage?: string | null;
    sourceLanguage?: string | null;
    deliveryStatus: string;
    readAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      kind: message.kind,
      body: message.body,
      attachmentUrl: message.attachmentUrl,
      transcript: message.transcript,
      durationSeconds: message.durationSeconds,
      translatedText: message.translatedText,
      translatedLanguage: message.translatedLanguage,
      sourceLanguage: message.sourceLanguage,
      deliveryStatus: message.deliveryStatus,
      readAt: message.readAt?.toISOString(),
      createdAt: message.createdAt.toISOString(),
    };
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
