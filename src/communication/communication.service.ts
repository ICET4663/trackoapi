import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes, randomUUID } from "crypto";
import type { AuthUser } from "../common/types/auth-user";
import { TranslationProviderService } from "../integrations/translation-provider.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { SendMessageDto } from "./dto/send-message.dto";
import { TranscribeVoiceDto } from "./dto/transcribe-voice.dto";
import { TypingStatusDto } from "./dto/typing-status.dto";

// App area each recipient role opens a conversation in (app routes /<area>/messages/<id>).
const MESSAGE_AREA = {
  CUSTOMER: "/customer",
  DRIVER: "/driver",
  TRUCK_OWNER: "/owner",
  DISPATCHER: "/dispatcher",
  ADMIN: "/admin",
} as const;

// Lock-screen text for a message; long text is cut so a push stays a preview.
function messagePreview(kind: string, body: string | null): string {
  if (kind === "VOICE") return "Voice note";
  if (kind === "ATTACHMENT") return "Sent an attachment";
  if (kind === "LOCATION") return "Shared a location";
  const text = body?.trim() || "New message";
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

// Same codes as TranslationProviderService and the app's i18n.
const SUPPORTED_MESSAGE_LANGUAGES = ["en", "ha", "yo", "ig"];

@Injectable()
export class CommunicationService {
  private readonly logger = new Logger(CommunicationService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly translationProvider: TranslationProviderService,
  ) {}

  // A conversation is readable by its customer and driver, the assigned truck owner, and
  // operations staff. A thread with neither a customer nor a driver (old admin threads)
  // used to be open to every signed-in account; it is now staff-only.
  private async assertConversationAccess(
    conversation: {
      shipmentId: string | null;
      customerId: string | null;
      driverId: string | null;
    },
    user: AuthUser,
  ) {
    if (user.role === "ADMIN" || user.role === "DISPATCHER") return;
    if (
      conversation.customerId === user.sub ||
      conversation.driverId === user.sub
    )
      return;
    if (user.role === "TRUCK_OWNER" && conversation.shipmentId) {
      const ownerAssignment = await this.prisma.driverAssignment.findFirst({
        where: {
          shipmentId: conversation.shipmentId,
          status: { in: ["OFFERED", "ACCEPTED"] },
          vehicle: { ownerId: user.sub },
        },
        select: { id: true },
      });
      if (ownerAssignment) return;
    }
    throw new ForbiddenException(
      "You do not have access to this conversation.",
    );
  }

  // Opens the thread a screen asks for. Only operations staff may start one from an id:
  // their "Message driver" / "Message user" buttons use the person's user id as the
  // thread id, so such a thread is addressed to that customer or driver and shows in
  // their inbox (it used to be created with no participants, so they never saw it, and
  // any signed-in account could read it). Everyone else can only open existing threads.
  private async openConversation(conversationId: string, user: AuthUser, touch = false) {
    const staff = user.role === "ADMIN" || user.role === "DISPATCHER";
    try {
      const existing = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
      if (!existing && !staff) throw new NotFoundException("Conversation was not found.");
      if (staff && (!existing || (!existing.customerId && !existing.driverId))) {
        const recipient = await this.prisma.user.findUnique({ where: { id: conversationId }, select: { role: true } });
        const addressedTo =
          recipient?.role === "CUSTOMER" ? { customerId: conversationId }
            : recipient?.role === "DRIVER" ? { driverId: conversationId }
              : {};
        return await this.prisma.conversation.upsert({
          where: { id: conversationId },
          update: { ...addressedTo, ...(touch ? { updatedAt: new Date() } : {}) },
          create: { id: conversationId, subject: "Trako conversation", ...addressedTo },
        });
      }
      if (touch && existing) {
        return await this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      }
      return existing!;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(
        `Could not open this conversation. Please try again: ${this.errorMessage(error)}`,
      );
    }
  }

  // Finds (or lazily creates) the single conversation thread scoped to a shipment,
  // so the customer, assigned driver, truck owner and operations team share one thread.
  async getOrCreateShipmentConversation(shipmentId: string, user: AuthUser) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { id: true, reference: true, customerId: true },
    });
    if (!shipment) throw new NotFoundException("Shipment was not found.");

    let driverId: string | null = null;
    if (user.role === "DRIVER") {
      const assignment = await this.prisma.driverAssignment.findFirst({
        where: { shipmentId, driverId: user.sub, status: { in: ["OFFERED", "ACCEPTED"] } },
        select: { driverId: true },
      });
      if (!assignment)
        throw new ForbiddenException(
          "You are not the assigned driver for this shipment.",
        );
      driverId = assignment.driverId;
    } else if (user.role === "CUSTOMER") {
      if (shipment.customerId !== user.sub)
        throw new ForbiddenException(
          "You do not have access to this shipment.",
        );
    } else if (user.role === "TRUCK_OWNER") {
      const ownerAssignment = await this.prisma.driverAssignment.findFirst({
        where: {
          shipmentId,
          status: { in: ["OFFERED", "ACCEPTED"] },
          vehicle: { ownerId: user.sub },
        },
        select: { driverId: true },
      });
      if (!ownerAssignment)
        throw new ForbiddenException(
          "Your truck is not assigned to this shipment.",
        );
      driverId = ownerAssignment.driverId;
    } else if (user.role !== "ADMIN" && user.role !== "DISPATCHER") {
      throw new ForbiddenException("You do not have access to this shipment.");
    }

    if (!driverId) {
      const acceptedAssignment = await this.prisma.driverAssignment.findFirst({
        where: { shipmentId, status: { in: ["OFFERED", "ACCEPTED"] } },
        orderBy: { offeredAt: "desc" },
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
        user.role === "CUSTOMER"
          ? { customerId: user.sub }
          : user.role === "DRIVER"
            ? { driverId: user.sub }
            : user.role === "TRUCK_OWNER"
              ? {
                  shipment: {
                    assignments: {
                      some: {
                        status: { in: ["OFFERED" as const, "ACCEPTED" as const] },
                        vehicle: { ownerId: user.sub },
                      },
                    },
                  },
                }
              : {}; // ADMIN/DISPATCHER get operational visibility across all threads.

      const conversations = await this.prisma.conversation.findMany({
        where,
        include: {
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { sender: { include: { profile: true } } },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
      });

      return conversations.map((conversation) => {
        const lastMessage = conversation.messages[0];
        return {
          id: conversation.id,
          role: user.role,
          title: conversation.subject ?? "Trako conversation",
          subtitle:
            lastMessage?.body ?? lastMessage?.transcript ?? "No messages yet",
          lastMessageAt:
            lastMessage?.createdAt?.toISOString() ??
            conversation.updatedAt.toISOString(),
          unreadCount: 0,
        };
      });
    } catch (error) {
      this.logger.error(`listConversations() failed: ${this.errorMessage(error)}`);
      throw new InternalServerErrorException("Could not load conversations. Please try again.");
    }
  }

  // This used to fall back to a fabricated "Preview conversation is ready" thread on ANY
  // read failure - a real DB error looked identical to a genuinely-empty new thread, and
  // the two participants could believe they were looking at their real conversation when
  // they were not. A read failure now surfaces as a real error instead.
  async listMessages(conversationId: string, user: AuthUser) {
    const conversation = await this.openConversation(conversationId, user);
    await this.assertConversationAccess(conversation, user);

    let messages;
    try {
      messages = await this.prisma.message.findMany({
        where: { conversationId },
        include: { sender: { include: { profile: true } } },
        orderBy: { createdAt: "asc" },
      });
    } catch (error) {
      throw new InternalServerErrorException(
        `Could not load messages. Please try again: ${this.errorMessage(error)}`,
      );
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
  async sendMessage(
    conversationId: string,
    senderId: string,
    dto: SendMessageDto,
    user: AuthUser,
  ) {
    const conversation = await this.openConversation(conversationId, user, true);
    await this.assertConversationAccess(conversation, user);

    const suppliedEnglishTranscript = dto.englishTranscript?.trim();
    const translation = await this.translateForRecipient(
      conversation,
      senderId,
      dto,
    ).catch(() => null);

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
          transcript: dto.sourceTranscript?.trim() || dto.transcript,
          durationSeconds: dto.durationSeconds,
          translatedText:
            translation?.translatedText ?? suppliedEnglishTranscript,
          translatedLanguage:
            translation?.translatedLanguage ??
            (suppliedEnglishTranscript ? "en" : undefined),
          sourceLanguage: dto.sourceLanguage ?? translation?.sourceLanguage,
        },
        include: { sender: { include: { profile: true } } },
      });
    } catch (error) {
      throw new InternalServerErrorException(
        `Could not send this message. Please try again: ${this.errorMessage(error)}`,
      );
    }

    await this.prisma.conversation
      .update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      })
      .catch((error) => {
        this.logger.error(
          `Could not bump conversation ${conversationId} after a real message was saved: ${this.errorMessage(error)}`,
        );
      });

    await this.pushNewMessage(conversation, message).catch((error) => {
      this.logger.error(
        `Could not push message ${message.id} in conversation ${conversationId}: ${this.errorMessage(error)}`,
      );
    });

    return this.toMessageRecord(message);
  }

  // Tells the other participants about a new message while the app is in the background
  // or closed. Push only: the conversation list is the inbox for messages.
  private async pushNewMessage(
    conversation: { id: string; customerId: string | null; driverId: string | null },
    message: {
      senderId: string;
      kind: string;
      body: string | null;
      sender?: { role?: string | null; profile?: { fullName?: string | null } | null } | null;
    },
  ) {
    if (message.kind === "SYSTEM") return;
    const recipientIds = [conversation.customerId, conversation.driverId].filter(
      (id): id is string => Boolean(id) && id !== message.senderId,
    );
    if (!recipientIds.length) return;

    const recipients = await this.prisma.user.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, role: true },
    });
    const senderRole = message.sender?.role;
    const title =
      senderRole === "DISPATCHER" || senderRole === "ADMIN"
        ? "Trako operations"
        : message.sender?.profile?.fullName?.trim() || "New message";
    const body = messagePreview(message.kind, message.body);

    for (const recipient of recipients) {
      const area = MESSAGE_AREA[recipient.role as keyof typeof MESSAGE_AREA];
      if (!area) continue;
      await this.notifications.pushOnly({
        userId: recipient.id,
        title,
        body,
        entity: "Conversation",
        entityId: conversation.id,
        actionUrl: `${area}/messages/${conversation.id}`,
        channelId: "messages",
      });
    }
  }

  // Translates dto.body (TEXT) or the original transcript (VOICE) into whichever language
  // the *other* participant has set as their preferred app language, when that's known and
  // actually differs from the message's language. Never throws - a translation failure (unconfigured
  // provider, API error, unsupported language pair) must never block the message itself;
  // callers already wrap this in .catch(() => null).
  private async translateForRecipient(
    conversation: { customerId: string | null; driverId: string | null },
    senderId: string,
    dto: SendMessageDto,
  ): Promise<{
    translatedText: string;
    translatedLanguage: string;
    sourceLanguage?: string;
  } | null> {
    const voice = dto.kind === "VOICE";
    const text = (
      voice ? dto.sourceTranscript?.trim() || dto.transcript : dto.body
    )?.trim();
    if (!text) return null;

    const recipientId =
      conversation.customerId === senderId
        ? conversation.driverId
        : conversation.customerId;
    if (!recipientId) return null;

    const [sender, recipient] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: senderId },
        select: { preferredLanguage: true },
      }),
      this.prisma.user.findUnique({
        where: { id: recipientId },
        select: { preferredLanguage: true },
      }),
    ]);
    const recipientLanguage = recipient?.preferredLanguage ?? "en";
    // A voice note's language is detected from the recording, so trust it over the
    // sender's app setting: a Yoruba-setting customer speaking English to a Yoruba-setting
    // driver is still English. Typed text has no detected language, so it keeps the
    // same-language heuristic that skips a pointless API call in the common case.
    const spokenLanguage =
      voice && dto.sourceLanguage && SUPPORTED_MESSAGE_LANGUAGES.includes(dto.sourceLanguage)
        ? dto.sourceLanguage
        : undefined;
    if (recipientLanguage === (spokenLanguage ?? sender?.preferredLanguage ?? "en")) return null;
    // The app already sends an English translation of non-English voice notes; translate
    // again only when the reader wants a language other than English.
    if (recipientLanguage === "en" && dto.englishTranscript?.trim()) return null;

    const result = spokenLanguage
      ? await this.translationProvider.translate(text, recipientLanguage, spokenLanguage)
      : await this.translationProvider.translate(text, recipientLanguage);
    if (!result) return null;
    return {
      translatedText: result.translatedText,
      translatedLanguage: recipientLanguage,
      sourceLanguage:
        spokenLanguage ?? result.detectedSourceLanguage ?? sender?.preferredLanguage,
    };
  }

  updateTypingStatus(
    conversationId: string,
    userId: string,
    dto: TypingStatusDto,
  ) {
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
      const result = await this.translationProvider.transcribe(
        dto.base64,
        dto.mimeType ?? "audio/webm",
        dto.languageHint,
      );
      if (result?.transcript) {
        const english =
          result.detectedLanguage && result.detectedLanguage !== "en"
            ? await this.translationProvider
                .translate(result.transcript, "en", result.detectedLanguage)
                .catch(() => null)
            : null;
        return {
          transcript: english?.translatedText ?? result.transcript,
          sourceTranscript: english ? result.transcript : undefined,
          detectedLanguage: result.detectedLanguage,
          translatedToEnglish: Boolean(english),
          durationSeconds: dto.durationSeconds,
        };
      }
      if (result?.reason) {
        return {
          transcript: "",
          durationSeconds: dto.durationSeconds,
          unavailableReason: `Server transcription could not process this recording: ${result.reason}`,
        };
      }
    }
    return {
      transcript: "",
      durationSeconds: dto.durationSeconds,
      unavailableReason: this.translationProvider.status().transcriptionEnabled
        ? "Server transcription could not process this recording. Check the microphone, select the spoken language, and try a short, clear recording."
        : "Server transcription is not configured yet. Add Google Speech service-account credentials before retrying multilingual voice notes.",
    };
  }

  registerPushToken(
    userId: string,
    token: string,
    platform?: string,
    deviceId?: string,
  ) {
    return this.notifications.registerPushToken(
      userId,
      token,
      platform,
      deviceId,
    );
  }

  async uploadMedia(input: Record<string, unknown>, userId: string) {
    const media = await this.prepareMedia(input, userId);
    // This used to catch ANY insert failure and fall back to a fake "uploaded: true"
    // response with a locally-generated id, never persisted anywhere - this is the
    // backing endpoint for KYC document capture, driver/vehicle document uploads, and
    // chat voice/photo attachments. A KYC document screen would show "Document attached"
    // and save a KycSubmissionDocument row pointing at a MediaAsset that was never
    // created - an admin reviewing that submission later would find nothing there. A
    // real upload failure must surface as a real error, not a false confirmation.
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
        String(input.kind ?? "DOCUMENT"),
        media.url,
        media.storageKey,
        String(input.label ?? "Uploaded media"),
        input.transcript ? String(input.transcript) : null,
        input.durationSeconds ? Number(input.durationSeconds) : null,
        media.mimeType,
        userId.startsWith("preview-") ? null : userId,
        // "id" has no database-level default (Prisma's @default(cuid()) is client-side
        // only) - this raw insert must generate its own, matching the pattern used
        // elsewhere in the codebase (e.g. KycService.id()) for handwritten SQL inserts.
        `media_${randomUUID().replace(/-/g, "")}`,
      );
      if (!rows[0]) throw new Error("Media asset insert returned no row.");
      return {
        ...rows[0],
        createdAt: rows[0].createdAt.toISOString(),
        uploaded: true,
      };
    } catch (error) {
      this.logger.error(
        `uploadMedia() failed to save the MediaAsset record: ${this.errorMessage(error)}`,
      );
      throw new InternalServerErrorException(
        `Could not save this upload. Please try again: ${this.errorMessage(error)}`,
      );
    }
  }

  static isAllowedUploadType(mimeType: string) {
    // SVG is an image type that can carry script, so it is excluded with the rest.
    if (mimeType === "image/svg+xml") return false;
    return (
      /^(image|audio|video)\/[a-z0-9.+-]+$/.test(mimeType) ||
      mimeType === "application/pdf" ||
      // What prepareMedia() falls back to when no type is given.
      mimeType === "application/octet-stream"
    );
  }

  private async prepareMedia(input: Record<string, unknown>, userId: string) {
    // MediaRecorder commonly reports `audio/webm;codecs=opus`. Supabase bucket MIME
    // allow-lists and file extensions expect the canonical media type without params.
    const suppliedMimeType =
      typeof input.mimeType === "string" && input.mimeType.trim()
        ? input.mimeType.trim()
        : "application/octet-stream";
    const mimeType = suppliedMimeType.split(";", 1)[0].trim().toLowerCase();
    // The stored file is served with this type, and it used to be whatever the client
    // claimed - so a signed-in user could host HTML or script in Trako's public storage.
    // The apps only upload photos, voice notes, video and PDFs.
    if (!CommunicationService.isAllowedUploadType(mimeType)) {
      throw new BadRequestException(
        "This file type cannot be uploaded. Send a photo, a voice note, a video or a PDF.",
      );
    }
    const base64 =
      typeof input.base64 === "string" && input.base64.trim()
        ? input.base64.trim()
        : null;
    const storage = this.storageConfig();

    // A bare localUri/uri (a path on the sender's own device, e.g. `file:///...`) can
    // never be read by the backend or reached by anyone else - it used to be accepted
    // here and stored verbatim as if it were a real, retrievable URL. This is genuinely
    // reachable: MessageThreadScreen's retryMessage() re-sends a failed voice/photo
    // message with only the original localUri, no base64 (the recorded/captured bytes
    // aren't kept around for a retry). That "successful" retry would silently produce a
    // MediaAsset pointing nowhere - the sender sees "sent", the recipient sees a broken
    // attachment forever. Real file content is required; a caller with only a local path
    // must fail loudly so the UI's existing "tap to retry" affordance can ask for it again.
    if (!base64) {
      throw new BadRequestException(
        "Real file content is required to upload media - a local device path cannot be stored or shared.",
      );
    }

    if (storage) {
      try {
        const storageKey = this.storageKey(input, userId, mimeType);
        const objectUrl = `${storage.url}/storage/v1/object/${storage.bucket}/${storageKey}`;
        const bytes = Buffer.from(base64, "base64");
        const upload = (contentType: string) =>
          fetch(objectUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${storage.serviceRoleKey}`,
              apikey: storage.serviceRoleKey,
              "Content-Type": contentType,
              "x-upsert": "false",
            },
            body: bytes,
          });

        let response = await upload(mimeType);
        // Existing deployments may still have the older bucket allow-list that omitted
        // audio/webm/audio/ogg. application/octet-stream was always allowed, so retry
        // audio once with that storage content type while retaining the real MIME on the
        // MediaAsset record and a correct audio file extension for playback.
        if (
          !response.ok &&
          response.status === 400 &&
          mimeType.startsWith("audio/")
        ) {
          response = await upload("application/octet-stream");
        }

        if (!response.ok)
          throw new Error(
            `Supabase storage upload failed with ${response.status}`,
          );

        return {
          url: `${storage.url}/storage/v1/object/public/${storage.bucket}/${storageKey}`,
          storageKey,
          mimeType,
        };
      } catch (error) {
        // Storage is configured, meaning a real, shareable URL was expected - silently
        // falling back here used to return a "successful" upload whose data: URI is
        // only ever visible to the uploader's own request, not a real stored asset any
        // other viewer (an admin, the message recipient) could later fetch on demand.
        this.logger.error(
          `prepareMedia() Supabase storage upload failed: ${this.errorMessage(error)}`,
        );
        throw new InternalServerErrorException(
          `Could not upload this file. Please try again: ${this.errorMessage(error)}`,
        );
      }
    }

    // No object storage configured at all (e.g. local/demo environment) - embed the
    // real file bytes directly rather than a broken reference. Unlike the localUri case
    // above, this is honest: the actual content is what gets persisted and rendered.
    return {
      url: `data:${mimeType};base64,${base64}`,
      storageKey: `inline/${Date.now()}`,
      mimeType,
    };
  }

  private storageConfig() {
    const url =
      this.config.get<string>("SUPABASE_URL") ??
      this.config.get<string>("EXPO_PUBLIC_SUPABASE_URL") ??
      this.config.get<string>("NEXT_PUBLIC_SUPABASE_URL");
    const serviceRoleKey = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY");
    const bucket =
      this.config.get<string>("SUPABASE_STORAGE_BUCKET") ?? "tracko-media";
    if (!url || !serviceRoleKey) return null;
    return { url: url.replace(/\/$/, ""), serviceRoleKey, bucket };
  }

  private storageKey(
    input: Record<string, unknown>,
    userId: string,
    mimeType: string,
  ) {
    const kind = String(input.kind ?? "DOCUMENT")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const owner = userId.startsWith("preview-")
      ? "preview"
      : userId.replace(/[^a-zA-Z0-9_-]/g, "");
    // Objects are served from a public bucket, so the filename is the only thing keeping a
    // URL private. Math.random() (~41 bits, not cryptographically secure) after a
    // millisecond timestamp and a user id that appears in API responses is guessable in
    // principle; 128 bits from the OS CSPRNG is not.
    return `${kind}/${owner}/${Date.now()}-${randomBytes(16).toString("hex")}.${this.extensionForMime(mimeType)}`;
  }

  private extensionForMime(mimeType: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("pdf")) return "pdf";
    if (mimeType.includes("mpeg")) return "mp3";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("x-m4a") || mimeType.includes("aac")) return "m4a";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("mp4")) return "mp4";
    return "jpg";
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


