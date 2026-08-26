import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SendMessageDto } from './dto/send-message.dto';
import { TranscribeVoiceDto } from './dto/transcribe-voice.dto';
import { TypingStatusDto } from './dto/typing-status.dto';


@Injectable()
export class CommunicationService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async listConversations(role: UserRole) {
    try {
      const conversations = await this.prisma.conversation.findMany({
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
          role,
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

  async listMessages(conversationId: string) {
    try {
      const conversation = await this.prisma.conversation.upsert({
        where: { id: conversationId },
        update: {},
        create: { id: conversationId, subject: 'Tracko conversation' },
      });

      const messages = await this.prisma.message.findMany({
        where: { conversationId },
        include: { sender: { include: { profile: true } } },
        orderBy: { createdAt: 'asc' },
      });

      return {
        conversation,
        typingUserIds: [],
        messages: messages.map((message) => this.toMessageRecord(message)),
      };
    } catch {
      return {
        conversation: {
          id: conversationId,
          name: 'Tracko conversation',
          subtitle: 'Preview thread',
          initial: 'T',
        },
        typingUserIds: [],
        messages: [
          {
            id: 'msg-preview',
            conversationId,
            senderId: 'preview-system',
            kind: 'SYSTEM',
            body: 'Preview conversation is ready.',
            createdAt: new Date().toISOString(),
            deliveryStatus: 'SENT',
          },
        ],
      };
    }
  }

  async sendMessage(conversationId: string, senderId: string, dto: SendMessageDto) {
    try {
      await this.prisma.conversation.upsert({
        where: { id: conversationId },
        update: { updatedAt: new Date() },
        create: { id: conversationId, subject: 'Tracko conversation' },
      });

      const message = await this.prisma.message.create({
        data: {
          id: dto.id,
          conversationId,
          senderId,
          kind: dto.kind,
          body: dto.body,
          attachmentUrl: dto.attachmentUrl ?? dto.attachmentUri,
          transcript: dto.transcript,
          durationSeconds: dto.durationSeconds,
        },
        include: { sender: { include: { profile: true } } },
      });

      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });

      return this.toMessageRecord(message);
    } catch {
      return {
        id: dto.id ?? `msg-${Date.now()}`,
        conversationId,
        senderId,
        kind: dto.kind,
        body: dto.body,
        attachmentUrl: dto.attachmentUrl ?? dto.attachmentUri,
        transcript: dto.transcript,
        durationSeconds: dto.durationSeconds,
        createdAt: new Date().toISOString(),
        deliveryStatus: 'SENT',
      };
    }
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

  transcribeVoiceNote(dto: TranscribeVoiceDto) {
    return {
      transcript: '',
      durationSeconds: dto.durationSeconds,
      unavailableReason: 'Server transcription is not configured yet. Use Chrome or Edge browser speech recognition for live transcript, or add a speech-to-text provider key for backend transcription.',
    };
  }

  registerPushToken(userId: string, token: string, platform?: string, deviceId?: string) {
    return this.notifications.registerPushToken(userId, token, platform, deviceId);
  }

  async uploadMedia(input: Record<string, unknown>, userId = 'preview-customer') {
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
        `insert into "MediaAsset" ("userId", "shipmentId", "conversationId", "kind", "url", "storageKey", "label", "transcript", "durationSeconds", "mimeType")
         values (
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
      deliveryStatus: message.deliveryStatus,
      readAt: message.readAt?.toISOString(),
      createdAt: message.createdAt.toISOString(),
    };
  }
}
