import { Injectable, Logger } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

type NotificationTone = 'INFO' | 'SUCCESS' | 'WARNING' | 'DANGER';

type NotificationInput = {
  userId?: string;
  role?: UserRole;
  title: string;
  body: string;
  tone?: NotificationTone;
  entity?: string;
  entityId?: string;
  actionUrl?: string;
};

type NotificationRow = {
  id: string;
  userId: string | null;
  role: string | null;
  title: string;
  body: string;
  tone: string;
  entity: string | null;
  entityId: string | null;
  actionUrl: string | null;
  readAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(input: NotificationInput) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<NotificationRow[]>(
        `insert into "Notification" ("id", "userId", "role", "title", "body", "tone", "entity", "entityId", "actionUrl")
         values ($1, $2, cast($3 as "UserRole"), $4, $5, cast($6 as "NotificationTone"), $7, $8, $9)
         returning "id", "userId", "role"::text as "role", "title", "body", "tone"::text as "tone", "entity", "entityId", "actionUrl", "readAt", "createdAt"`,
        // "id" has no database-level default (Prisma's @default(cuid()) is client-side
        // only) - every raw insert into this table must generate its own.
        `notif_${randomUUID().replace(/-/g, '')}`,
        input.userId && !input.userId.startsWith('preview-') ? input.userId : null,
        input.role ?? null,
        input.title,
        input.body,
        input.tone ?? 'INFO',
        input.entity ?? null,
        input.entityId ?? null,
        input.actionUrl ?? null,
      );
      if (rows[0]) {
        const record = this.toRecord(rows[0]);
        // Best-effort: registerPushToken() has always stored real device tokens, but
        // nothing ever actually sent to them - a closed app never got notified of
        // anything (shipment updates, new messages, dispute resolutions) until the user
        // happened to reopen it and check the in-app list. Push delivery failing must
        // never fail notification creation itself, hence the separate try/catch.
        await this.sendPushNotifications(input).catch((error) => {
          this.logger.error(`Push delivery failed for notification ${record.id}: ${this.errorMessage(error)}`);
        });
        return record;
      }
    } catch {
      // Preview fallback below.
    }

    return this.previewNotification(input);
  }

  // Expo's push service needs no API key - just the recipient's Expo push token(s), sent
  // in batches of up to 100 per request.
  private async sendPushNotifications(input: NotificationInput) {
    const tokens = await this.resolvePushTokens(input);
    if (!tokens.length) return;

    const messages = tokens.map((token) => ({
      to: token,
      title: input.title,
      body: input.body,
      data: { entity: input.entity, entityId: input.entityId, actionUrl: input.actionUrl },
    }));

    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!response.ok) {
        this.logger.warn(`Expo push send returned ${response.status} for a batch of ${batch.length} tokens`);
      }
    }
  }

  private async resolvePushTokens(input: NotificationInput): Promise<string[]> {
    if (input.userId && !input.userId.startsWith('preview-')) {
      const rows = await this.prisma.$queryRawUnsafe<{ token: string }[]>(
        'select "token" from "PushToken" where "userId" = $1',
        input.userId,
      );
      return rows.map((row) => row.token);
    }
    if (input.role) {
      const rows = await this.prisma.$queryRawUnsafe<{ token: string }[]>(
        `select pt."token" from "PushToken" pt join "User" u on u."id" = pt."userId" where u."role" = cast($1 as "UserRole")`,
        input.role,
      );
      return rows.map((row) => row.token);
    }
    return [];
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  async list(userId: string, role: UserRole) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<NotificationRow[]>(
        `select "id", "userId", "role"::text as "role", "title", "body", "tone"::text as "tone", "entity", "entityId", "actionUrl", "readAt", "createdAt"
         from "Notification"
         where ("userId" = $1 or "role" = cast($2 as "UserRole"))
         order by "createdAt" desc
         limit 100`,
        userId,
        role,
      );
      if (rows.length) return rows.map((row) => this.toRecord(row));
    } catch {
      // Preview fallback below.
    }

    return [
      this.previewNotification({
        userId,
        role,
        title: 'Tracko preview is ready',
        body: 'Backend notifications are active in preview mode.',
        tone: 'SUCCESS',
        entity: 'System',
      }),
    ];
  }

  async unreadCount(userId: string, role: UserRole) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `select count(*)::bigint as "count"
         from "Notification"
         where ("userId" = $1 or "role" = cast($2 as "UserRole")) and "readAt" is null`,
        userId,
        role,
      );
      return { unreadCount: Number(rows[0]?.count ?? 0) };
    } catch {
      return { unreadCount: 1 };
    }
  }

  async markRead(id: string, userId: string, role: UserRole) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<NotificationRow[]>(
        `update "Notification"
         set "readAt" = current_timestamp
         where "id" = $1 and ("userId" = $2 or "role" = cast($3 as "UserRole"))
         returning "id", "userId", "role"::text as "role", "title", "body", "tone"::text as "tone", "entity", "entityId", "actionUrl", "readAt", "createdAt"`,
        id,
        userId,
        role,
      );
      if (rows[0]) return this.toRecord(rows[0]);
    } catch {
      // Preview fallback below.
    }

    return { ...this.previewNotification({ title: 'Notification read', body: 'Marked as read.' }), id, readAt: new Date().toISOString() };
  }

  async markAllRead(userId: string, role: UserRole) {
    try {
      await this.prisma.$queryRawUnsafe(
        `update "Notification"
         set "readAt" = current_timestamp
         where ("userId" = $1 or "role" = cast($2 as "UserRole")) and "readAt" is null`,
        userId,
        role,
      );
    } catch {
      // Preview response below.
    }

    return { markedRead: true, updatedAt: new Date().toISOString() };
  }

  async registerPushToken(userId: string, token: string, platform?: string, deviceId?: string) {
    try {
      await this.prisma.$queryRawUnsafe(
        `insert into "PushToken" ("id", "userId", "token", "platform", "deviceId", "updatedAt")
         values ($1, $2, $3, $4, $5, current_timestamp)
         on conflict ("userId", "token")
         do update set "platform" = excluded."platform", "deviceId" = excluded."deviceId", "updatedAt" = current_timestamp`,
        // "id" has no database-level default (Prisma's @default(cuid()) is client-side
        // only) - this was still missing after the earlier updatedAt-only fix, which is
        // why registerPushToken() kept silently failing even after that pass.
        `push_${randomUUID().replace(/-/g, '')}`,
        userId.startsWith('preview-') ? 'preview-customer' : userId,
        token,
        platform ?? null,
        deviceId ?? null,
      );
    } catch {
      // Preview response below.
    }

    return {
      registered: true,
      userId,
      tokenPreview: `${token.slice(0, 8)}...`,
      platform,
      deviceId,
    };
  }

  private toRecord(row: NotificationRow) {
    return {
      id: row.id,
      userId: row.userId ?? undefined,
      role: row.role ?? undefined,
      title: row.title,
      body: row.body,
      tone: row.tone,
      entity: row.entity ?? undefined,
      entityId: row.entityId ?? undefined,
      actionUrl: row.actionUrl ?? undefined,
      readAt: row.readAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private previewNotification(input: Partial<NotificationInput>) {
    return {
      id: `notification-${Date.now()}`,
      userId: input.userId,
      role: input.role,
      title: input.title ?? 'Tracko notification',
      body: input.body ?? 'Preview notification.',
      tone: input.tone ?? 'INFO',
      entity: input.entity,
      entityId: input.entityId,
      actionUrl: input.actionUrl,
      createdAt: new Date().toISOString(),
    };
  }
}
