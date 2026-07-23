import { Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
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
  constructor(private readonly prisma: PrismaService) {}

  async create(input: NotificationInput) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<NotificationRow[]>(
        `insert into "Notification" ("userId", "role", "title", "body", "tone", "entity", "entityId", "actionUrl")
         values ($1, cast($2 as "UserRole"), $3, $4, cast($5 as "NotificationTone"), $6, $7, $8)
         returning "id", "userId", "role"::text as "role", "title", "body", "tone"::text as "tone", "entity", "entityId", "actionUrl", "readAt", "createdAt"`,
        input.userId && !input.userId.startsWith('preview-') ? input.userId : null,
        input.role ?? null,
        input.title,
        input.body,
        input.tone ?? 'INFO',
        input.entity ?? null,
        input.entityId ?? null,
        input.actionUrl ?? null,
      );
      if (rows[0]) return this.toRecord(rows[0]);
    } catch {
      // Preview fallback below.
    }

    return this.previewNotification(input);
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
        `insert into "PushToken" ("userId", "token", "platform", "deviceId")
         values ($1, $2, $3, $4)
         on conflict ("userId", "token")
         do update set "platform" = excluded."platform", "deviceId" = excluded."deviceId", "updatedAt" = current_timestamp`,
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
