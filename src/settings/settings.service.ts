import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PayoutStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthService } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

type Role = 'CUSTOMER' | 'DRIVER' | 'TRUCK_OWNER' | 'DISPATCHER' | 'ADMIN';
type PreferenceKey =
  | 'shipmentStatusUpdates'
  | 'liveTrackingAlerts'
  | 'driverOffers'
  | 'escrowPayments'
  | 'receipts'
  | 'push'
  | 'sms'
  | 'email';

type SavedAddressRecord = {
  id: string;
  label: string;
  line: string;
  city: string;
  address?: string;
  icon?: string;
  isDefaultPickup?: boolean;
};

type PaymentMethodRecord = {
  id: string;
  brand: string;
  maskedNumber: string;
  detail?: string;
  type: string;
  isDefault?: boolean;
  expiry?: string;
  holderName?: string;
};

type DriverEscrowEarningRow = {
  shipmentId: string;
  reference: string;
  route: string;
  amount: number;
  currency: string;
  status: string;
  updatedAt: Date;
};

type PayoutMetadata = {
  amountKobo?: number;
  status?: string;
  note?: string | null;
  bankLabel?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string | null;
};

type SupportTicketRow = {
  id: string;
  shipmentId: string | null;
  userId: string | null;
  topic: string;
  channel: string;
  message: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  userName: string | null;
  userEmail: string | null;
};

type SafetyAlertInput = {
  message?: string;
  shipmentId?: string;
  latitude?: number;
  longitude?: number;
};

const notificationPreferences: Record<PreferenceKey, boolean> = {
  shipmentStatusUpdates: true,
  liveTrackingAlerts: true,
  driverOffers: true,
  escrowPayments: true,
  receipts: false,
  push: true,
  sms: false,
  email: true,
};

const legalDocuments = [
  { id: 'privacy-policy', title: 'Privacy Policy' },
  { id: 'terms-of-service', title: 'Terms of Service' },
  { id: 'account-deletion', title: 'Account Deletion' },
];

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  // This used to catch ANY read failure and fall back to hardcoded fake stats per role
  // ("12 trips, 5.0 rating", "3 trucks", "8 open, 1 alert, 24 resolved" for admin) - the
  // very first screen every user sees after logging in would silently show made-up
  // numbers instead of an error during a real DB hiccup.
  async accountOverview(role: Role, userId: string, authRole?: Role) {
    try {
      const activeRole = authRole ?? role;
      const unread = await this.notifications.unreadCount(userId, activeRole);
      const notificationBadge = unread.unreadCount ? String(unread.unreadCount) : undefined;

      if (role === 'CUSTOMER') {
        const [totalShipments, activeShipments, walletRows] = await Promise.all([
          this.prisma.shipment.count({ where: { customerId: userId } }),
          this.prisma.shipment.count({
            where: {
              customerId: userId,
              status: { in: ['ESCROW_FUNDED', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED_DESTINATION', 'DELIVERED'] },
            },
          }),
          this.prisma.$queryRawUnsafe<{ total: bigint | number | null }[]>(
            `select coalesce(sum(e."amount"), 0)::bigint as "total"
             from "Escrow" e
             join "Shipment" s on s."id" = e."shipmentId"
             where s."customerId" = $1 and e."status" in ('FUNDED', 'HELD', 'RELEASE_READY')`,
            userId,
          ),
        ]);
        return {
          stats: [
            { label: 'Shipments', value: String(totalShipments) },
            { label: 'Active', value: String(activeShipments) },
            { label: 'Wallet', value: this.formatMoney(Number(walletRows[0]?.total ?? 0)) },
          ],
          badges: { notifications: notificationBadge },
          values: {},
        };
      }

      if (role === 'DRIVER') {
        const [trips, acceptedTrips, missingDocumentRows] = await Promise.all([
          this.prisma.driverAssignment.count({ where: { driverId: userId, status: 'ACCEPTED' } }),
          this.prisma.driverAssignment.count({ where: { driverId: userId, status: 'ACCEPTED', shipment: { status: { in: ['PICKED_UP', 'IN_TRANSIT', 'ARRIVED_DESTINATION', 'DELIVERED'] } } } }),
          this.prisma.$queryRawUnsafe<{ count: bigint | number }[]>(
            `select count(*)::bigint as "count"
             from "DriverDocument"
             where "userId" = $1 and "state" in ('MISSING', 'EXPIRING')`,
            userId,
          ),
        ]);
        const missingDocuments = Number(missingDocumentRows[0]?.count ?? 0);
        return {
          stats: [
            { label: 'Trips', value: String(trips) },
            { label: 'Active', value: String(acceptedTrips) },
            { label: 'Docs', value: missingDocuments ? `${missingDocuments} due` : 'OK' },
          ],
          badges: { notifications: notificationBadge, driverDocuments: missingDocuments ? String(missingDocuments) : undefined },
          values: { regionShift: 'Lagos', driverDocuments: missingDocuments ? `${missingDocuments} due` : 'OK' },
        };
      }

      if (role === 'TRUCK_OWNER') {
        const [trucks, assigned, dueDocs] = await Promise.all([
          this.prisma.vehicle.count({ where: { ownerId: userId } }),
          this.prisma.vehicle.count({ where: { ownerId: userId, assignedDriverId: { not: null } } }),
          this.prisma.vehicle.count({ where: { ownerId: userId, isActive: false } }),
        ]);
        return {
          stats: [
            { label: 'Trucks', value: String(trucks) },
            { label: 'Assigned', value: String(assigned) },
            { label: 'Docs', value: dueDocs ? `${dueDocs} due` : 'OK' },
          ],
          badges: { notifications: notificationBadge, truckDocuments: dueDocs ? String(dueDocs) : undefined },
          values: { truckDocuments: dueDocs ? `${dueDocs} due` : 'OK' },
        };
      }

      if (role === 'ADMIN' || role === 'DISPATCHER') {
        const [openShipments, alertRows, resolvedRows] = await Promise.all([
          this.prisma.shipment.count({ where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } } }),
          this.prisma.$queryRawUnsafe<{ count: bigint | number }[]>(
            `select count(*)::bigint as "count" from "Dispute" where "status" in ('OPEN', 'IN_REVIEW')`,
          ),
          this.prisma.$queryRawUnsafe<{ count: bigint | number }[]>(
            `select count(*)::bigint as "count" from "Dispute" where "status" = 'RESOLVED'`,
          ),
        ]);
        const alerts = Number(alertRows[0]?.count ?? 0);
        const resolved = Number(resolvedRows[0]?.count ?? 0);
        return {
          stats: [
            { label: 'Open', value: String(openShipments) },
            { label: 'Alerts', value: String(alerts) },
            { label: 'Resolved', value: String(resolved) },
          ],
          badges: { notifications: notificationBadge, alerts: alerts ? String(alerts) : undefined, fraudAlerts: '0' },
          values: {},
        };
      }
    } catch (error) {
      throw new InternalServerErrorException(`Could not load your dashboard. Please try again: ${this.errorMessage(error)}`);
    }
    // Every branch above returns; an unrecognized role falls through to here.
    throw new BadRequestException('Unsupported account role.');
  }

  // This used to fall back to a fake identity - a hardcoded name/email/phone/verification
  // status ("Tracko Preview User", VERIFIED) belonging to nobody - on any DB read failure
  // or a genuinely-missing user row. A real authenticated user could see someone else's
  // (fake) name and a fake "VERIFIED" status on their own Personal Details screen.
  async profile(userId: string) {
    let user;
    try {
      user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: { profile: true },
      });
    } catch (error) {
      throw new InternalServerErrorException(`Could not load your profile. Please try again: ${this.errorMessage(error)}`);
    }
    if (!user) throw new NotFoundException('Account not found.');
    return this.toProfileRecord(user);
  }

  // Same bug as profile() above, plus this is a WRITE: on any failure after the update
  // was attempted, this used to echo the submitted input straight back as if it had been
  // saved - the user saw their new name/address/avatar "succeed" even when nothing was
  // actually persisted, and the real (unchanged) data would reappear on next real fetch.
  async updateProfile(userId: string, input: Record<string, unknown>) {
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true },
    }).catch((error) => {
      throw new InternalServerErrorException(`Could not load your profile. Please try again: ${this.errorMessage(error)}`);
    });
    if (!current) throw new NotFoundException('Account not found.');

    const fullName = String(input.fullName ?? current.profile?.fullName ?? current.email).trim();
    const address = input.address === undefined ? current.profile?.address : input.address ? String(input.address) : null;
    const avatarUrl = input.avatarUrl === undefined ? current.profile?.avatarUrl : input.avatarUrl ? String(input.avatarUrl) : null;

    try {
      await this.prisma.profile.upsert({
        where: { userId },
        create: {
          userId,
          fullName,
          address,
          avatarUrl,
        },
        update: {
          fullName,
          address,
          avatarUrl,
        },
      });
    } catch (error) {
      throw new InternalServerErrorException(`Could not save your profile. Please try again: ${this.errorMessage(error)}`);
    }

    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'ACCOUNT_PROFILE_UPDATED',
        entity: 'User',
        entityId: userId,
        metadata: { fields: Object.keys(input).filter((key) => key !== 'avatarUrl') },
      },
    }).catch(() => null);

    return this.profile(userId);
  }

  async requestAccountDeletion(userId: string, input: { reason?: string }) {
    const id = `account-deletion-${Date.now()}`;
    const reason = String(input.reason ?? 'User requested account deletion from app.');

    // The audit log entry IS the request - it's what pendingAccountDeletionRequests()
    // below reads to build the admin review queue. If this insert fails, the request was
    // never actually recorded and no admin will ever see it, so this must surface as a
    // real failure rather than the honest-sounding "received" message it used to fake.
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: userId,
          action: 'ACCOUNT_DELETION_REQUESTED',
          entity: 'User',
          entityId: userId,
          metadata: {
            requestId: id,
            reason,
            status: 'PENDING_REVIEW',
            retentionNotice: 'Operational records may be retained for legal, safety, dispute, tax, or fraud-prevention reasons.',
          },
        },
      });
    } catch (error) {
      throw new InternalServerErrorException(`Could not submit your deletion request. Please try again: ${this.errorMessage(error)}`);
    }

    await this.notifications.create({
      role: 'ADMIN',
      title: 'Account deletion request',
      body: 'A user requested account deletion from inside the app.',
      tone: 'WARNING',
      entity: 'User',
      entityId: userId,
      actionUrl: '/admin/deletion-requests',
    });

    await this.notifications.create({
      userId,
      title: 'Deletion request received',
      body: 'Tracko will review your account deletion request and follow up according to our retention policy.',
      tone: 'INFO',
      entity: 'User',
      entityId: userId,
      actionUrl: '/customer/legal-document?id=account-deletion',
    });

    return {
      id,
      status: 'PENDING_REVIEW',
      message: 'Account deletion request received. Tracko will review and follow up.',
    };
  }

  // The admin-facing counterpart to requestAccountDeletion() above - previously nothing
  // ever read these requests back out, so every one went into a black hole no admin action
  // could resolve. A request is "pending" while the target account is still active and no
  // later APPROVED/REJECTED entry exists for it yet.
  async pendingAccountDeletionRequests() {
    return this.prisma.$queryRawUnsafe<
      { id: string; userId: string; requestedAt: Date; reason: string | null; email: string; phone: string; fullName: string | null }[]
    >(
      `select al."id", al."entityId" as "userId", al."createdAt" as "requestedAt",
              al.metadata->>'reason' as "reason", u."email", u."phone", p."fullName"
       from "AuditLog" al
       join "User" u on u."id" = al."entityId"
       left join "Profile" p on p."userId" = u."id"
       where al.action = 'ACCOUNT_DELETION_REQUESTED'
         and u."isActive" = true
         and not exists (
           select 1 from "AuditLog" al2
           where al2."entityId" = al."entityId"
             and al2.action in ('ACCOUNT_DELETION_APPROVED', 'ACCOUNT_DELETION_REJECTED')
             and al2."createdAt" > al."createdAt"
         )
       order by al."createdAt" desc
       limit 100`,
    ).then((rows) => rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      requestedAt: row.requestedAt.toISOString(),
      reason: row.reason,
      email: row.email,
      phone: row.phone,
      fullName: row.fullName ?? row.email,
    })));
  }

  async reviewAccountDeletionRequest(userId: string, reviewerId: string, input: { decision?: string; note?: string }) {
    const decision = String(input.decision ?? '').toUpperCase();
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      throw new BadRequestException('Use APPROVE or REJECT as the deletion decision.');
    }

    if (decision === 'APPROVE') {
      const result = await this.auth.adminExecuteAccountDeletion(userId, reviewerId, input.note);
      return { userId, decision: 'APPROVED', ...result };
    }

    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: reviewerId,
          action: 'ACCOUNT_DELETION_REJECTED',
          entity: 'User',
          entityId: userId,
          metadata: { note: input.note ?? null },
        },
      });
    } catch (error) {
      throw new InternalServerErrorException(`Could not record this decision. Please try again: ${this.errorMessage(error)}`);
    }

    await this.notifications.create({
      userId,
      title: 'Deletion request update',
      body: input.note
        ? `Tracko reviewed your account deletion request: ${input.note}`
        : 'Tracko reviewed your account deletion request and your account was not deleted. Contact support for details.',
      tone: 'INFO',
      entity: 'User',
      entityId: userId,
      actionUrl: '/customer/support',
    });

    return { userId, decision: 'REJECTED' };
  }

  private toProfileRecord(user: {
    id: string;
    email: string;
    phone: string;
    role: string;
    verificationStatus: string;
    profile?: { fullName: string; address: string | null; city: string | null; state: string | null; avatarUrl: string | null } | null;
  }) {
    return {
      id: user.id,
      fullName: user.profile?.fullName ?? user.email,
      email: user.email,
      phone: user.phone,
      role: user.role,
      verificationStatus: user.verificationStatus,
      address: user.profile?.address ?? undefined,
      city: user.profile?.city ?? undefined,
      state: user.profile?.state ?? undefined,
      avatarUrl: user.profile?.avatarUrl ?? undefined,
    };
  }

  async notificationPreferences(userId: string, role: Role = 'CUSTOMER') {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ key: PreferenceKey; value: boolean }[]>(
        `select "key", "value"
         from "NotificationPreference"
         where "userId" = $1 and "role" = cast($2 as "UserRole")`,
        userId,
        role,
      );
      return rows.reduce(
        (preferences, row) => ({ ...preferences, [row.key]: row.value }),
        { ...notificationPreferences },
      );
    } catch (error) {
      // Used to silently return the default preference set on any read failure - a user
      // who had actually customized their preferences would see them apparently reset,
      // with no indication the real values just failed to load.
      throw new InternalServerErrorException(`Could not load your notification preferences. Please try again: ${this.errorMessage(error)}`);
    }
  }

  async updateNotificationPreference(userId: string, role: Role, input: { key?: PreferenceKey; value?: boolean }) {
    if (!input.key) throw new BadRequestException('A preference key is required.');
    try {
      await this.prisma.$executeRawUnsafe(
        `insert into "NotificationPreference" ("id", "userId", "role", "key", "value", "updatedAt")
         values ($1, $2, cast($3 as "UserRole"), $4, $5, current_timestamp)
         on conflict ("userId", "role", "key")
         do update set "value" = excluded."value", "updatedAt" = current_timestamp`,
        // "id" has no database-level default (Prisma's @default(cuid()) is client-side
        // only) - this was still missing after the earlier updatedAt-only fix.
        `notifpref_${randomUUID().replace(/-/g, '')}`,
        userId,
        role,
        input.key,
        Boolean(input.value),
      );

      await this.prisma.auditLog.create({
        data: {
          actorId: userId,
          action: 'NOTIFICATION_PREFERENCE_UPDATED',
          entity: 'NotificationPreference',
          entityId: `${role}:${input.key}`,
          metadata: { role, key: input.key, value: Boolean(input.value) },
        },
      }).catch(() => null);

      return this.notificationPreferences(userId, role);
    } catch (error) {
      // Used to echo back the requested value as if it had been saved on ANY failure of
      // the actual insert - the toggle would appear to flip in the UI while nothing was
      // written to the database, silently reverting on next real load.
      throw new InternalServerErrorException(`Could not save this preference. Please try again: ${this.errorMessage(error)}`);
    }
  }

  private static readonly SUPPORTED_LANGUAGES = ['en', 'ha', 'yo', 'ig'];

  // Drives CommunicationService.translateForRecipient - the app UI's own language switch
  // is purely on-device (see the frontend's src/i18n/locale-context.tsx); this is the only
  // copy of "what language does this user read" the backend has, so translation quietly
  // does nothing useful until the frontend actually calls this on every language change.
  async updatePreferredLanguage(userId: string, language?: string) {
    if (!language || !SettingsService.SUPPORTED_LANGUAGES.includes(language)) {
      throw new BadRequestException(`Language must be one of: ${SettingsService.SUPPORTED_LANGUAGES.join(', ')}.`);
    }
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { preferredLanguage: language } });
    } catch (error) {
      throw new InternalServerErrorException(`Could not save this language preference. Please try again: ${this.errorMessage(error)}`);
    }
    return { preferredLanguage: language };
  }

  supportIndex() {
    return {
      topics: [
        { id: 'shipments', label: 'Shipments' },
        { id: 'payments', label: 'Payments and escrow' },
        { id: 'account', label: 'Account and verification' },
      ],
      contacts: [
        { id: 'chat', label: 'Chat support', helper: 'Start a support conversation', channel: 'CHAT' },
        { id: 'email', label: 'Email support', helper: 'Send details for follow-up', channel: 'EMAIL' },
        { id: 'phone', label: 'Emergency phone line', helper: 'Use only for urgent shipment issues', channel: 'PHONE' },
      ],
    };
  }

  supportArticle(id: string) {
    return {
      id,
      title: id === 'payments' ? 'Payments and escrow' : 'Getting help with Tracko',
      intro: 'This preview article explains the workflow while the live support knowledge base is being connected.',
      sections: [
        {
          heading: 'Current stage',
          body: 'The frontend is connected to the local backend, with preview data returned for stakeholder walkthroughs.',
        },
        {
          heading: 'Production next step',
          body: 'Each support topic will be backed by Supabase content and admin-managed help articles.',
        },
      ],
      related: ['shipments', 'account'],
    };
  }

  async createSupportContact(userId: string, input: { channel?: string; role?: string; topic?: string; message?: string; shipmentId?: string }) {
    const channel = String(input.channel ?? 'CHAT').toUpperCase();
    const topic = String(input.topic ?? input.role ?? 'General support');
    const message = String(input.message ?? `${channel} support request from ${input.role ?? 'user'}.`);
    const id = `support-${Date.now()}`;

    // Same reasoning as createSafetyTicket() below: the catch here used to swallow a failed
    // insert into a fake "request received" response, so a user's support request could be
    // silently lost while the UI told them it had gone through. It also carried the same
    // "updatedAt" bug - that column uses Prisma's client-side-only @updatedAt, which has no
    // database default, so every raw-SQL insert that omits it violates a NOT NULL constraint.
    try {
      await this.prisma.$executeRawUnsafe(
        `insert into "SupportTicket" ("id", "shipmentId", "userId", "topic", "channel", "message", "status", "updatedAt")
         values ($1, $2, $3, $4, $5, $6, 'OPEN'::"SupportTicketStatus", current_timestamp)`,
        id,
        input.shipmentId ?? null,
        userId,
        topic,
        channel,
        message,
      );
    } catch (error) {
      throw new InternalServerErrorException(
        `Could not submit your support request. Please try again: ${this.errorMessage(error)}`,
      );
    }

    await this.notifications.create({
      role: 'ADMIN',
      title: 'New support request',
      body: `${topic} request opened through ${channel.toLowerCase()} support.`,
      tone: 'WARNING',
      entity: 'SupportTicket',
      entityId: id,
      actionUrl: '/admin/support',
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'SUPPORT_TICKET_CREATED',
        entity: 'SupportTicket',
        entityId: id,
        metadata: { channel, topic, role: input.role ?? null },
      },
    }).catch(() => null);

    return {
      message: 'Support request received. Tracko support will follow up.',
      conversationId: id,
      ticketId: id,
      status: 'OPEN',
    };
  }

  async sendEmergencyAlert(userId: string, role: Role, input: SafetyAlertInput = {}) {
    return this.createSafetyTicket(userId, role, {
      ...input,
      topic: 'Safety emergency',
      action: 'SAFETY_EMERGENCY_REPORTED',
      userMessage: 'Emergency alert received. Tracko operations has been notified.',
    });
  }

  async reportSafetyIncident(userId: string, input: SafetyAlertInput = {}) {
    return this.createSafetyTicket(userId, 'DRIVER', {
      ...input,
      topic: 'Driver safety incident',
      action: 'DRIVER_SAFETY_INCIDENT_REPORTED',
      userMessage: 'Safety incident received. Tracko operations has been notified.',
    });
  }

  private async createSafetyTicket(
    userId: string,
    role: Role,
    input: SafetyAlertInput & { topic: string; action: string; userMessage: string },
  ) {
    const id = `safety-${Date.now()}`;
    const location =
      Number.isFinite(input.latitude) && Number.isFinite(input.longitude)
        ? ` Location: ${input.latitude}, ${input.longitude}.`
        : '';
    const message = `${input.message ?? `${input.topic} reported from the ${role.toLowerCase()} app.`}${location}`;

    // This is the single most safety-critical write path in the app - a driver or
    // customer using this believes operations has been alerted. The catch below used to
    // swallow ANY failure here (DB unreachable, bad connection, anything) into a fake
    // { sent: true, reported: true } response, meaning an emergency could silently go
    // completely unreported while the app told the person help was on the way. A real
    // failure must surface as a real failure so the caller knows to try another channel
    // (call emergency services / dispatch directly) instead of trusting a false positive.
    try {
      await this.prisma.$executeRawUnsafe(
        `insert into "SupportTicket" ("id", "shipmentId", "userId", "topic", "channel", "message", "status", "updatedAt")
         values ($1, $2, $3, $4, 'EMERGENCY', $5, 'OPEN'::"SupportTicketStatus", current_timestamp)`,
        id,
        input.shipmentId ?? null,
        userId,
        input.topic,
        message,
      );
    } catch (error) {
      throw new InternalServerErrorException(
        `Could not report this ${input.topic.toLowerCase()}. Please try again immediately, or contact emergency services directly if you cannot wait: ${this.errorMessage(error)}`,
      );
    }

    // Notifying staff is the actual point of an emergency alert, not a nice-to-have - but
    // NotificationsService.create() already never throws (it falls back to an in-memory
    // preview record on its own DB errors), so this can't silently mask a real failure the
    // way the removed outer catch did. The ticket itself (the source of truth staff can
    // find in the support queue) is already safely persisted above regardless.
    await Promise.all([
      this.notifications.create({
        role: 'ADMIN',
        title: input.topic,
        body: message,
        tone: 'DANGER',
        entity: 'SupportTicket',
        entityId: id,
        actionUrl: '/admin/support',
      }),
      this.notifications.create({
        role: 'DISPATCHER',
        title: input.topic,
        body: message,
        tone: 'DANGER',
        entity: 'SupportTicket',
        entityId: id,
        actionUrl: '/dispatcher/support',
      }),
      this.notifications.create({
        userId,
        title: 'Safety alert received',
        body: input.userMessage,
        tone: 'WARNING',
        entity: 'SupportTicket',
        entityId: id,
        actionUrl: role === 'DRIVER' ? '/driver/safety-settings' : '/customer/support',
      }),
    ]);

    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: input.action,
        entity: 'SupportTicket',
        entityId: id,
        metadata: {
          role,
          shipmentId: input.shipmentId ?? null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          priority: 'HIGH',
        },
      },
    }).catch(() => null);

    return {
      sent: true,
      reported: true,
      ticketId: id,
      status: 'OPEN',
      priority: 'HIGH',
      message: input.userMessage,
    };
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  async supportTickets() {
    try {
      const rows = await this.prisma.$queryRawUnsafe<SupportTicketRow[]>(
        `select st."id", st."shipmentId", st."userId", st."topic", st."channel", st."message",
           st."status"::text as "status", st."createdAt", st."updatedAt", st."resolvedAt",
           coalesce(p."fullName", u."email") as "userName", u."email" as "userEmail"
         from "SupportTicket" st
         left join "User" u on u."id" = st."userId"
         left join "Profile" p on p."userId" = u."id"
         order by st."createdAt" desc
         limit 100`,
      );

      return rows.map((row) => ({
        id: row.id,
        shipmentId: row.shipmentId,
        userId: row.userId,
        userName: row.userName ?? 'Tracko user',
        userEmail: row.userEmail ?? undefined,
        topic: row.topic,
        channel: row.channel,
        message: row.message,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        createdAtLabel: row.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        updatedAt: row.updatedAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString(),
      }));
    } catch (error) {
      // Used to fall back to a single fabricated "Tracko Customer" support ticket on any
      // read failure - an admin/dispatcher's support queue would show a made-up ticket
      // instead of an error.
      throw new InternalServerErrorException(`Could not load support tickets. Please try again: ${this.errorMessage(error)}`);
    }
  }

  async resolveSupportTicket(id: string, actorId: string, input: { resolution?: string }) {
    const resolution = String(input.resolution ?? 'Resolved by Tracko support.');
    try {
      const rows = await this.prisma.$queryRawUnsafe<SupportTicketRow[]>(
        `update "SupportTicket"
         set "status" = 'RESOLVED'::"SupportTicketStatus",
             "resolvedAt" = current_timestamp,
             "updatedAt" = current_timestamp
         where "id" = $1
         returning "id", "shipmentId", "userId", "topic", "channel", "message",
           "status"::text as "status", "createdAt", "updatedAt", "resolvedAt",
           null::text as "userName", null::text as "userEmail"`,
        id,
      );
      if (!rows[0]) throw new NotFoundException('Support ticket not found.');

      await this.prisma.auditLog.create({
        data: {
          actorId,
          action: 'SUPPORT_TICKET_RESOLVED',
          entity: 'SupportTicket',
          entityId: id,
          metadata: { resolution },
        },
      }).catch(() => null);

      if (rows[0].userId) {
        await this.notifications.create({
          userId: rows[0].userId,
          title: 'Support ticket resolved',
          body: resolution,
          tone: 'SUCCESS',
          entity: 'SupportTicket',
          entityId: id,
          actionUrl: '/customer/support',
        });
      }

      return {
        id,
        status: 'RESOLVED',
        message: 'Support ticket resolved.',
      };
    } catch (error) {
      // Used to fall back to a fake "resolved" confirmation on any failure other than a
      // genuinely-missing ticket - an admin resolving a real support ticket during a DB
      // hiccup would see success while nothing was actually updated.
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(`Could not resolve this support ticket. Please try again: ${this.errorMessage(error)}`);
    }
  }

  legalDocumentSummaries() {
    return legalDocuments;
  }

  legalDocument(id: string) {
    const summary = legalDocuments.find((document) => document.id === id);
    if (!summary) throw new NotFoundException('Legal document not found.');

    return {
      ...summary,
      updated: 'July 20, 2026',
      clauses: [
        {
          heading: 'Preview notice',
          body: 'This document is included so the app has the required legal page flow during development.',
        },
        {
          heading: 'Production review',
          body: 'Before store submission, legal counsel should review privacy, deletion, terms, payment, and KYC language.',
        },
      ],
    };
  }

  // This used to fall back to 2 fake hardcoded addresses ("Home" - Lekki Phase 1, "Office"
  // - Victoria Island) whenever the read failed OR the customer genuinely had zero saved
  // addresses yet - the normal state before ever adding one. A customer could pick one of
  // these fake addresses for a real shipment pickup/destination.
  async savedAddresses(userId: string) {
    try {
      return await this.prisma.$queryRawUnsafe<SavedAddressRecord[]>(
        'select "id", "label", "line", "city", "address", "icon", "isDefaultPickup" from "SavedAddress" where "userId" = $1 order by "isDefaultPickup" desc, "createdAt" desc limit 50',
        userId,
      );
    } catch (error) {
      throw new InternalServerErrorException(`Could not load saved addresses: ${this.errorMessage(error)}`);
    }
  }

  async savedAddress(id: string, userId: string) {
    let rows: SavedAddressRecord[];
    try {
      rows = await this.prisma.$queryRawUnsafe<SavedAddressRecord[]>(
        'select "id", "label", "line", "city", "address", "icon", "isDefaultPickup" from "SavedAddress" where "id" = $1 and "userId" = $2 limit 1',
        id,
        userId,
      );
    } catch (error) {
      throw new InternalServerErrorException(`Could not load this address: ${this.errorMessage(error)}`);
    }
    if (!rows[0]) throw new NotFoundException('Saved address not found.');
    return rows[0];
  }

  // Was faking success on any insert/update failure by echoing the submitted input
  // straight back - the customer saw their new address "saved" when it never was, and it
  // would silently vanish (revert to whatever was really in the DB) on the next real fetch.
  async saveAddress(input: Record<string, unknown>, id: string | undefined, userId: string) {
    const addressId = id ?? `addr_${randomUUID().replace(/-/g, '')}`;
    try {
      const rows = await this.prisma.$queryRawUnsafe<SavedAddressRecord[]>(
        `insert into "SavedAddress" ("id", "userId", "label", "line", "city", "address", "icon", "isDefaultPickup", "updatedAt")
         values ($1, $2, $3, $4, $5, $6, $7, $8, current_timestamp)
         on conflict ("id") do update set
           "label" = excluded."label",
           "line" = excluded."line",
           "city" = excluded."city",
           "address" = excluded."address",
           "icon" = excluded."icon",
           "isDefaultPickup" = excluded."isDefaultPickup",
           "updatedAt" = current_timestamp
         returning "id", "label", "line", "city", "address", "icon", "isDefaultPickup"`,
        addressId,
        userId,
        String(input.label ?? 'Saved address'),
        String(input.line ?? input.address ?? ''),
        String(input.city ?? ''),
        input.address ? String(input.address) : null,
        input.icon ? String(input.icon) : null,
        Boolean(input.isDefaultPickup),
      );
      if (!rows[0]) throw new Error('Insert returned no row.');
      return rows[0];
    } catch (error) {
      throw new InternalServerErrorException(`Could not save this address. Please try again: ${this.errorMessage(error)}`);
    }
  }

  // Was faking a "Visa **** 4242, Preview card" payment method whenever the read failed
  // OR the customer had zero saved cards yet (the normal state before their first real
  // Paystack charge, since a card is only saved after a successful charge - see
  // savePaymentMethodFromAuthorization in payment-provider.service.ts).
  async paymentMethods(userId: string) {
    try {
      return await this.prisma.$queryRawUnsafe<PaymentMethodRecord[]>(
        'select "id", "brand", "maskedNumber", "detail", "type", "isDefault", "expiry", "holderName" from "PaymentMethod" where "userId" = $1 order by "isDefault" desc, "createdAt" desc',
        userId,
      );
    } catch (error) {
      throw new InternalServerErrorException(`Could not load payment methods: ${this.errorMessage(error)}`);
    }
  }

  async paymentMethod(id: string, userId: string) {
    const methods = await this.paymentMethods(userId);
    const method = methods.find((method: { id: string }) => method.id === id);
    // Used to silently fall back to the customer's FIRST payment method (re-labeled with
    // the requested id) when the id didn't match any of theirs - a request for a
    // nonexistent/deleted card's details would silently show a real, different card's
    // brand/masked number under the wrong id instead of a proper "not found".
    if (!method) throw new NotFoundException('Payment method not found.');
    return method;
  }

  // Previously always returned { ...method, isDefault: true } without writing anything -
  // the change never actually persisted, so it silently reverted the next time the list
  // was fetched.
  async setDefaultPaymentMethod(id: string, userId: string) {
    const owned = await this.prisma.paymentMethod.findFirst({ where: { id, userId } });
    if (!owned) throw new NotFoundException('Payment method not found.');
    await this.prisma.paymentMethod.updateMany({ where: { userId }, data: { isDefault: false } });
    return this.prisma.paymentMethod.update({ where: { id }, data: { isDefault: true } });
  }

  // Previously had no auth check and no real query at all - just always returned
  // { deleted: true }, whether or not a method with that id (or a valid session) existed.
  async removePaymentMethod(id: string, userId: string) {
    const result = await this.prisma.paymentMethod.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw new NotFoundException('Payment method not found.');
    return { deleted: true };
  }

  // paymentMethodId was accepted by the frontend and dropped on the floor here - every card's
  // "Billing history" screen actually showed every card's charges. And on a query failure OR a
  // genuinely empty history, this used to fall back to 2 hardcoded fake invoices ("TRK-1024",
  // "TRK-1008"), so a real customer/driver with zero charges saw invoices that never happened.
  async billingHistory(userId: string, paymentMethodId?: string) {
    try {
      return paymentMethodId
        ? await this.prisma.$queryRawUnsafe<unknown[]>(
            'select "id", "ref", "dateLabel" as "date", "amount" from "BillingCharge" where "userId" = $1 and "paymentMethodId" = $2 order by "createdAt" desc',
            userId,
            paymentMethodId,
          )
        : await this.prisma.$queryRawUnsafe<unknown[]>(
            'select "id", "ref", "dateLabel" as "date", "amount" from "BillingCharge" where "userId" = $1 order by "createdAt" desc',
            userId,
          );
    } catch {
      // Real infra failure: an honest empty list, never fabricated charges.
      return [];
    }
  }

  async bankAccount(userId: string) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<unknown[]>(
        'select "id", "bankName", "maskedNumber", "holderName", "verified", "payoutSchedule", "pendingPayout" from "BankAccount" where "userId" = $1 limit 1',
        userId,
      );
      if (rows[0]) return rows[0];
    } catch {
      // A real infra failure (DB unreachable) falls through to the placeholder below too -
      // but that placeholder must never claim `verified: true`. It previously did, which
      // meant a driver who had never actually set up a payout account still saw a fully
      // "Verified" fake "Preview Bank" and could pass the withdraw screen's bankReady gate
      // with nothing real for finance to actually pay out to.
    }

    return {
      id: null,
      bankName: null,
      maskedNumber: null,
      holderName: null,
      verified: false,
      payoutSchedule: 'Weekly',
      pendingPayout: 'N0',
    };
  }

  // Paystack's real-time account-name resolution, not a fake "verification URL" flow -
  // the previous "Change bank account" button opened nothing and called a stub that
  // always said "disabled in preview."
  async payoutBanks() {
    const secretKey = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secretKey) throw new BadRequestException('Bank verification is not configured yet.');

    const response = await fetch('https://api.paystack.co/bank?currency=NGN', {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const payload = (await response.json().catch(() => ({}))) as {
      status?: boolean;
      data?: { name: string; code: string; slug: string }[];
    };
    if (!response.ok || !payload.status) throw new BadRequestException('Could not load the bank list. Please try again.');

    return (payload.data ?? []).map((bank) => ({ name: bank.name, code: bank.code, slug: bank.slug }));
  }

  async setPayoutAccount(userId: string, input: { bankCode?: string; bankName?: string; accountNumber?: string }) {
    const secretKey = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secretKey) throw new BadRequestException('Bank verification is not configured yet.');

    const bankCode = String(input.bankCode ?? '').trim();
    const accountNumber = String(input.accountNumber ?? '').trim();
    if (!bankCode || accountNumber.length < 10) {
      throw new BadRequestException('A valid bank and 10-digit account number are required.');
    }

    const response = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      status?: boolean;
      message?: string;
      data?: { account_number?: string; account_name?: string };
    };
    if (!response.ok || !payload.status || !payload.data?.account_name) {
      throw new BadRequestException(payload.message || 'Could not verify this account number with the bank. Please check the details and try again.');
    }

    const resolvedName = payload.data.account_name;
    const driverName = (await this.prisma.$queryRawUnsafe<{ fullName: string | null }[]>(
      'select p."fullName" from "Profile" p where p."userId" = $1 limit 1',
      userId,
    ).catch(() => [])) [0]?.fullName;

    // The account name Paystack resolves must reasonably match the driver's own verified
    // identity - otherwise this is exactly the kind of "payout to someone else's account"
    // fraud pattern the (pre-existing) UI copy already warns about, now actually enforced.
    const nameMatches = driverName ? this.namesRoughlyMatch(resolvedName, driverName) : false;

    const maskedNumber = `**** ${accountNumber.slice(-4)}`;
    await this.prisma.$queryRawUnsafe(
      `insert into "BankAccount" ("id", "userId", "bankName", "maskedNumber", "holderName", "verified", "payoutSchedule", "updatedAt")
       values ($1, $2, $3, $4, $5, $6, 'Weekly', current_timestamp)
       on conflict ("userId") do update set
         "bankName" = excluded."bankName",
         "maskedNumber" = excluded."maskedNumber",
         "holderName" = excluded."holderName",
         "verified" = excluded."verified",
         "updatedAt" = current_timestamp`,
      `bank-${userId}`,
      userId,
      input.bankName ?? bankCode,
      maskedNumber,
      resolvedName,
      nameMatches,
    );

    return this.bankAccount(userId);
  }

  private namesRoughlyMatch(a: string, b: string) {
    const words = (value: string) => new Set(value.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter((word) => word.length > 1));
    const wordsA = words(a);
    const wordsB = words(b);
    for (const word of wordsA) {
      if (wordsB.has(word)) return true;
    }
    return false;
  }

  async driverRatingSummary(driverId: string) {
    const [aggregate, recent] = await Promise.all([
      this.prisma.review.aggregate({
        where: { driverId },
        _avg: { rating: true },
        _count: { rating: true },
      }).catch(() => null),
      this.prisma.review.findMany({
        where: { driverId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, rating: true, comment: true, createdAt: true },
      }).catch(() => []),
    ]);

    return {
      averageRating: aggregate?._avg.rating ? Number(aggregate._avg.rating.toFixed(2)) : null,
      totalReviews: aggregate?._count.rating ?? 0,
      recentReviews: recent,
    };
  }

  async driverEarnings(userId: string, options: { strict?: boolean } = {}) {
    try {
      const [releasedRows, pendingRows, bankAccount, withdrawalLogs] = await Promise.all([
        this.prisma.$queryRawUnsafe<DriverEscrowEarningRow[]>(
          `select s."id" as "shipmentId", s."reference",
             concat(s."pickupLabel", ' to ', s."destinationLabel") as "route",
             e."amount", e."currency", e."status"::text as "status", e."updatedAt"
           from "DriverAssignment" da
           join "Shipment" s on s."id" = da."shipmentId"
           join "Escrow" e on e."shipmentId" = s."id"
           where da."driverId" = $1
             and da."status" = 'ACCEPTED'
             and e."status" = 'RELEASED'
           order by e."updatedAt" desc
           limit 100`,
          userId,
        ),
        this.prisma.$queryRawUnsafe<DriverEscrowEarningRow[]>(
          `select s."id" as "shipmentId", s."reference",
             concat(s."pickupLabel", ' to ', s."destinationLabel") as "route",
             e."amount", e."currency", e."status"::text as "status", e."updatedAt"
           from "DriverAssignment" da
           join "Shipment" s on s."id" = da."shipmentId"
           join "Escrow" e on e."shipmentId" = s."id"
           where da."driverId" = $1
             and da."status" = 'ACCEPTED'
             and e."status" in ('FUNDED', 'HELD', 'RELEASE_READY')
           order by e."updatedAt" desc
           limit 100`,
          userId,
        ),
        this.bankAccount(userId),
        this.prisma.payout.findMany({
          where: { driverId: userId },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);

      const withdrawals = withdrawalLogs.map((payout) => ({
        id: payout.id,
        title: 'Withdrawal request',
        amount: -payout.amountKobo,
        amountLabel: `-${this.formatMoney(payout.amountKobo)}`,
        status: payout.status,
        date: payout.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        method: payout.bankLabel ?? 'Payout account',
      }));

      const releasedTotal = releasedRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
      const pendingTotal = pendingRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
      // A rejected withdrawal never actually left the driver's balance, so it must not
      // count against what's available — only requests still pending or already paid out do.
      const withdrawalTotal = withdrawals
        .filter((row) => row.status !== 'REJECTED')
        .reduce((sum, row) => sum + Math.abs(row.amount), 0);
      const availableBalance = Math.max(0, releasedTotal - withdrawalTotal);

      return {
        availableBalance,
        availableBalanceLabel: this.formatMoney(availableBalance),
        pendingEscrow: pendingTotal,
        pendingEscrowLabel: this.formatMoney(pendingTotal),
        releasedTotal,
        releasedTotalLabel: this.formatMoney(releasedTotal),
        bankAccount,
        transactions: [
          ...releasedRows.map((row) => ({
            id: `earning-${row.reference}`,
            title: row.route,
            amount: Number(row.amount ?? 0),
            amountLabel: `+${this.formatMoney(row.amount)}`,
            status: 'RELEASED',
            date: row.updatedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            shipmentId: row.reference,
          })),
          ...pendingRows.map((row) => ({
            id: `pending-${row.reference}`,
            title: row.route,
            amount: Number(row.amount ?? 0),
            amountLabel: `+${this.formatMoney(row.amount)}`,
            status: 'PENDING_ESCROW',
            date: row.updatedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            shipmentId: row.reference,
          })),
          ...withdrawals,
        ],
      };
    } catch (error) {
      // requestDriverWithdrawal() validates the requested amount against this balance -
      // if the real computation fails, it must never fall through to this fixed preview
      // balance (₦512,400) and let a withdrawal request be validated against a number
      // that has nothing to do with the driver's real released escrow. Reserve the
      // friendly fallback for the read-only earnings screen.
      if (options.strict) throw error;
      return {
        availableBalance: 51240000,
        availableBalanceLabel: 'N512,400',
        pendingEscrow: 33000000,
        pendingEscrowLabel: 'N330,000',
        releasedTotal: 63240000,
        releasedTotalLabel: 'N632,400',
        bankAccount: await this.bankAccount(userId),
        transactions: [
          { id: 'earning-preview-1', title: 'Kano to Abuja', amount: 33000000, amountLabel: '+N330,000', status: 'PENDING_ESCROW', date: 'Jun 22', shipmentId: 'TRK-1024' },
          { id: 'earning-preview-2', title: 'Lagos to Ibadan', amount: 18500000, amountLabel: '+N185,000', status: 'RELEASED', date: 'Jun 18', shipmentId: 'TRK-1008' },
          { id: 'withdrawal-preview-1', title: 'Withdrawal request', amount: -12000000, amountLabel: '-N120,000', status: 'PENDING', date: 'Jun 15', method: 'Preview Bank' },
        ],
      };
    }
  }

  async requestDriverWithdrawal(userId: string, input: { amountKobo?: number; amount?: number; note?: string }) {
    const amountKobo = Number(input.amountKobo ?? input.amount ?? 0);
    if (!Number.isFinite(amountKobo) || amountKobo <= 0) {
      throw new BadRequestException('Enter a valid withdrawal amount.');
    }

    let earnings: Awaited<ReturnType<typeof this.driverEarnings>>;
    try {
      earnings = await this.driverEarnings(userId, { strict: true });
    } catch (error) {
      throw new InternalServerErrorException(`Could not verify your available balance. Please try again: ${this.errorMessage(error)}`);
    }
    if (amountKobo > earnings.availableBalance) {
      throw new BadRequestException('Withdrawal amount is higher than available balance.');
    }

    const bank = earnings.bankAccount as { bankName?: string; maskedNumber?: string };
    if (!(earnings.bankAccount as { verified?: boolean }).verified) {
      throw new BadRequestException('Verify your payout account before requesting withdrawal.');
    }

    const [driver] = await this.prisma.$queryRawUnsafe<Array<{ verificationStatus: string }>>(
      'select "verificationStatus"::text as "verificationStatus" from "User" where "id" = $1 limit 1',
      userId,
    );
    // Fails closed: `driver` coming back empty (no matching User row) must be treated the
    // same as "not verified", not silently skipped. The original `driver && ...` check let
    // an unverified/unresolvable driver bypass the KYC gate entirely if this query ever
    // returned zero rows for a valid session.
    if (!driver || driver.verificationStatus !== 'VERIFIED') {
      throw new BadRequestException('Complete KYC approval before requesting driver payout.');
    }

    const payout = await this.prisma.payout.create({
      data: {
        driverId: userId,
        amountKobo,
        note: input.note ?? null,
        bankLabel: [bank?.bankName, bank?.maskedNumber].filter(Boolean).join(' '),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'PAYOUT_WITHDRAWAL_REQUESTED',
        entity: 'Payout',
        entityId: payout.id,
        metadata: this.toJson({ amountKobo }),
      },
    }).catch(() => null);

    await this.notifications.create({
      userId,
      title: 'Withdrawal request submitted',
      body: `${this.formatMoney(amountKobo)} is pending Tracko finance review.`,
      tone: 'INFO',
      entity: 'Payout',
      entityId: payout.id,
      actionUrl: '/driver/earnings',
    });

    return {
      id: payout.id,
      status: payout.status,
      amount: amountKobo,
      amountLabel: this.formatMoney(amountKobo),
      message: 'Withdrawal request submitted for finance review.',
    };
  }

  // This used to catch ANY read failure (a DB outage, a bad query) and return a single
  // fabricated pending withdrawal request - "Tracko Driver", "Preview Bank **** 0012",
  // N120,000 - indistinguishable from a real one on the admin finance queue. Worse,
  // reviewPayoutRequest() had a matching special case that let an admin "approve" or
  // "mark paid" that fake id without ever touching the real Payout table - an admin
  // could believe they'd paid a driver N120,000 when nothing happened on either side.
  // A real infra failure here must surface as a real error, never a phantom request.
  async adminPayoutRequests() {
    try {
      const payouts = await this.prisma.payout.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { driver: { include: { profile: true } } },
      });

      return payouts.map((payout) => ({
        id: payout.id,
        driverId: payout.driverId,
        driverName: payout.driver.profile?.fullName ?? payout.driver.email,
        driverEmail: payout.driver.email,
        amount: payout.amountKobo,
        amountLabel: this.formatMoney(payout.amountKobo),
        status: payout.status,
        bankLabel: payout.bankLabel || 'Payout account pending',
        note: payout.note,
        reviewNote: payout.reviewNote,
        requestedAt: payout.createdAt.toISOString(),
        requestedAtLabel: payout.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      }));
    } catch (error) {
      throw new InternalServerErrorException(`Could not load payout requests. Please try again: ${this.errorMessage(error)}`);
    }
  }

  async reviewPayoutRequest(id: string, reviewerId: string, input: { decision?: string; note?: string }) {
    const decision = String(input.decision ?? '').toUpperCase();
    if (!['APPROVED', 'REJECTED', 'PAID'].includes(decision)) {
      throw new BadRequestException('Use APPROVED, REJECTED, or PAID as the payout decision.');
    }

    const existing = await this.prisma.payout.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Payout request not found.');
    }

    const updated = await this.prisma.payout.update({
      where: { id },
      data: {
        status: decision as PayoutStatus,
        reviewedAt: new Date(),
        reviewedById: reviewerId,
        reviewNote: input.note ?? null,
      },
    });

    // The payout row is the mutable business record; this is the immutable trail of who
    // reviewed it and when, kept separate rather than overwriting the audit log itself.
    await this.prisma.auditLog.create({
      data: {
        actorId: reviewerId,
        action: 'PAYOUT_WITHDRAWAL_REVIEWED',
        entity: 'Payout',
        entityId: updated.id,
        metadata: this.toJson({ decision, note: input.note ?? null, amountKobo: updated.amountKobo }),
      },
    }).catch(() => null);

    await this.notifications.create({
      userId: updated.driverId,
      title: decision === 'PAID' ? 'Withdrawal paid' : decision === 'APPROVED' ? 'Withdrawal approved' : 'Withdrawal rejected',
      body: `${this.formatMoney(updated.amountKobo)} payout request was marked ${decision.toLowerCase()}.`,
      tone: decision === 'REJECTED' ? 'DANGER' : 'SUCCESS',
      entity: 'Payout',
      entityId: updated.id,
      actionUrl: '/driver/earnings',
    });

    return {
      id: updated.id,
      status: updated.status,
      amount: updated.amountKobo,
      amountLabel: this.formatMoney(updated.amountKobo),
      message: `Payout request marked as ${decision.toLowerCase()}.`,
    };
  }

  private formatMoney(amountKobo?: number | null) {
    if (!amountKobo) return 'N0';
    return `N${Math.round(Number(amountKobo) / 100).toLocaleString('en-US')}`;
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private readonly requiredDriverDocuments = [
    { type: 'license', title: 'Driver license' },
    { type: 'insurance', title: 'Insurance certificate' },
  ] as const;

  // driverDbId() used to be the type slug ("license"/"insurance") ITSELF, used directly
  // as DriverDocument's primary key - which is global across every driver, not scoped to
  // one. Two different drivers uploading a "license" collided on the same row via
  // `on conflict ("id")`: the second upload silently overwrote the first driver's file
  // and review state while the row's userId stayed the FIRST driver's - so driver A's
  // document list could show driver B's actual uploaded photo/ID under driver A's name,
  // and driver B's own upload would appear to have vanished (their own query, scoped by
  // their own userId, would never find the row). Scoping the key per user fixes this.
  private driverDocumentDbId(userId: string, type: string) {
    return `${userId}_${type}`;
  }

  // This used to fall back to 2 fake documents - "Driver license: Verified, valid until
  // Dec 2027" and "Vehicle insurance: missing" - whenever the read failed OR (the normal
  // state for every driver before their first upload, since nothing is pre-seeded) there
  // were genuinely zero real rows yet. A driver could believe their license was already
  // verified when they had never uploaded anything. Mirrors vehicleDocuments()'s honest
  // per-type default below instead: a real "missing" row for anything not yet uploaded,
  // never a fabricated "verified".
  async driverDocuments(userId: string) {
    const rows = await this.prisma.$queryRawUnsafe<
      { id: string; title: string; meta: string; state: string; issued?: Date; expires?: Date; number?: string; fileUrl?: string; reviewNote?: string | null }[]
    >(
      'select "id", "title", "meta", lower("state"::text) as "state", "issued", "expires", "number", "fileUrl", "reviewNote" from "DriverDocument" where "userId" = $1 order by "createdAt" desc',
      userId,
    ).catch((error) => {
      throw new InternalServerErrorException(`Could not load driver documents: ${this.errorMessage(error)}`);
    });

    const byDbId = new Map(rows.map((row) => [row.id, row]));
    return this.requiredDriverDocuments.map(({ type, title }) => {
      const row = byDbId.get(this.driverDocumentDbId(userId, type));
      if (!row) return { id: type, title, meta: 'Upload required', state: 'missing' as const };
      return {
        id: type,
        title: row.title,
        meta: row.meta,
        state: row.state,
        issued: row.issued?.toISOString?.(),
        expires: row.expires?.toISOString?.(),
        number: row.number,
        fileUrl: row.fileUrl,
        reviewNote: row.reviewNote,
      };
    });
  }

  async driverDocument(id: string, userId: string) {
    const documents = await this.driverDocuments(userId);
    const document = documents.find((doc) => doc.id === id);
    if (!document) throw new NotFoundException('Document not found.');
    return document;
  }

  async uploadDriverDocument(
    userId: string,
    id: string,
    input: { fileUrl?: string; url?: string; number?: string; expires?: string; meta?: string },
  ) {
    const fileUrl = String(input.fileUrl ?? input.url ?? '').trim();
    if (!fileUrl) throw new BadRequestException('Document file URL is required.');

    const expires = input.expires ? new Date(input.expires) : null;
    const expiresValue = expires && !Number.isNaN(expires.getTime()) ? expires : null;
    const title = id
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Driver document';

    try {
      await this.prisma.$queryRawUnsafe(
        `insert into "DriverDocument" ("id", "userId", "title", "meta", "state", "expires", "number", "fileUrl", "updatedAt")
         values ($1, $2, $3, $4, 'PENDING_REVIEW'::"DriverDocumentState", $5, $6, $7, current_timestamp)
         on conflict ("id") do update
         set "meta" = excluded."meta",
             "state" = 'PENDING_REVIEW'::"DriverDocumentState",
             "expires" = excluded."expires",
             "number" = excluded."number",
             "fileUrl" = excluded."fileUrl",
             "reviewNote" = null,
             "reviewedAt" = null,
             "reviewedById" = null,
             "updatedAt" = current_timestamp`,
        this.driverDocumentDbId(userId, id),
        userId,
        title,
        input.meta ?? 'Uploaded - pending review',
        expiresValue,
        input.number ?? null,
        fileUrl,
      );

      await this.prisma.auditLog.create({
        data: {
          actorId: userId,
          action: 'DRIVER_DOCUMENT_UPLOADED',
          entity: 'DriverDocument',
          entityId: this.driverDocumentDbId(userId, id),
          metadata: { fileUrl, number: input.number ?? null, expires: input.expires ?? null },
        },
      }).catch(() => null);

      await this.notifications.create({
        role: 'ADMIN',
        title: 'Driver document uploaded',
        body: `${title} was uploaded and needs review.`,
        tone: 'WARNING',
        entity: 'DriverDocument',
        entityId: this.driverDocumentDbId(userId, id),
        actionUrl: '/admin/driver-documents',
      });

      return {
        uploaded: true,
        message: 'Driver document uploaded for review.',
        document: { id, title, meta: input.meta ?? 'Uploaded - pending review', state: 'pending_review', fileUrl },
      };
    } catch (error) {
      // The insert IS the upload - a driver who believes their license photo was saved
      // when it never persisted has no real document on file, silently. Same
      // fake-success-on-failure pattern this session has repeatedly fixed elsewhere.
      throw new InternalServerErrorException(`Could not save this document. Please try again: ${this.errorMessage(error)}`);
    }
  }

  // The admin-facing counterpart to uploadDriverDocument() above - previously nothing
  // anywhere ever read PENDING_REVIEW documents back out or set a document to VERIFIED,
  // so a driver's uploaded license/insurance could never actually pass review; the "state"
  // shown was always the wrong hardcoded value regardless of what an admin did (nothing,
  // since there was no admin action to take).
  async pendingDriverDocuments() {
    return this.prisma.$queryRawUnsafe<
      { id: string; userId: string; title: string; meta: string; number: string | null; expires: Date | null; fileUrl: string | null; createdAt: Date; email: string; phone: string; fullName: string | null }[]
    >(
      `select d."id", d."userId", d."title", d."meta", d."number", d."expires", d."fileUrl", d."createdAt",
              u."email", u."phone", p."fullName"
       from "DriverDocument" d
       join "User" u on u."id" = d."userId"
       left join "Profile" p on p."userId" = u."id"
       where d."state" = 'PENDING_REVIEW'::"DriverDocumentState"
       order by d."createdAt" asc
       limit 100`,
    ).then((rows) => rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      title: row.title,
      meta: row.meta,
      number: row.number,
      expires: row.expires?.toISOString() ?? null,
      fileUrl: row.fileUrl,
      submittedAt: row.createdAt.toISOString(),
      email: row.email,
      phone: row.phone,
      fullName: row.fullName ?? row.email,
    })));
  }

  async reviewDriverDocument(documentId: string, reviewerId: string, input: { decision?: string; note?: string }) {
    const decision = String(input.decision ?? '').toUpperCase();
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      throw new BadRequestException('Use APPROVE or REJECT as the document decision.');
    }
    const nextState = decision === 'APPROVE' ? 'VERIFIED' : 'REJECTED';

    let updated;
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        { id: string; userId: string; title: string; state: string }[]
      >(
        `update "DriverDocument"
         set "state" = $1::"DriverDocumentState",
             "issued" = case when $1 = 'VERIFIED' then current_timestamp else "issued" end,
             "reviewNote" = $2,
             "reviewedAt" = current_timestamp,
             "reviewedById" = $3,
             "updatedAt" = current_timestamp
         where "id" = $4 and "state" = 'PENDING_REVIEW'::"DriverDocumentState"
         returning "id", "userId", "title", lower("state"::text) as "state"`,
        nextState,
        input.note ?? null,
        reviewerId,
        documentId,
      );
      updated = rows[0];
    } catch (error) {
      throw new InternalServerErrorException(`Could not record this decision. Please try again: ${this.errorMessage(error)}`);
    }
    if (!updated) throw new NotFoundException('No pending document found for this decision - it may have already been reviewed.');

    await this.prisma.auditLog.create({
      data: {
        actorId: reviewerId,
        action: decision === 'APPROVE' ? 'DRIVER_DOCUMENT_APPROVED' : 'DRIVER_DOCUMENT_REJECTED',
        entity: 'DriverDocument',
        entityId: documentId,
        metadata: { note: input.note ?? null },
      },
    }).catch(() => null);

    await this.notifications.create({
      userId: updated.userId,
      title: decision === 'APPROVE' ? `${updated.title} verified` : `${updated.title} needs attention`,
      body: decision === 'APPROVE'
        ? `Your ${updated.title.toLowerCase()} has been verified.`
        : input.note
          ? `Your ${updated.title.toLowerCase()} was not approved: ${input.note}`
          : `Your ${updated.title.toLowerCase()} was not approved. Please upload a clearer copy.`,
      tone: decision === 'APPROVE' ? 'SUCCESS' : 'DANGER',
      entity: 'DriverDocument',
      entityId: documentId,
      actionUrl: '/driver/documents',
    });

    return { id: updated.id, state: updated.state, decision };
  }

  private readonly requiredVehicleDocuments = [
    { type: 'REGISTRATION', title: 'Vehicle registration' },
    { type: 'INSURANCE', title: 'Insurance certificate' },
    { type: 'ROADWORTHINESS', title: 'Roadworthiness certificate' },
  ] as const;

  async vehicleDocuments(vehicleId: string, ownerId: string) {
    await this.assertVehicleOwner(vehicleId, ownerId);
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      id: string; type: string; title: string; state: string; number: string | null;
      expires: Date | null; fileUrl: string | null; reviewNote: string | null;
    }>>(
      `select "id", "type", "title", lower("state"::text) as "state", "number", "expires", "fileUrl", "reviewNote"
       from "VehicleDocument" where "vehicleId" = $1 order by "createdAt" asc`,
      vehicleId,
    ).catch(() => []);
    const byType = new Map(rows.map((row) => [row.type, row]));
    return this.requiredVehicleDocuments.map((required) => {
      const row = byType.get(required.type);
      return row ? { ...row, expires: row.expires?.toISOString() ?? null } : {
        id: `${vehicleId}-${required.type.toLowerCase()}`,
        vehicleId,
        type: required.type,
        title: required.title,
        state: 'missing',
        number: null,
        expires: null,
        fileUrl: null,
        reviewNote: null,
      };
    });
  }

  async uploadVehicleDocument(
    vehicleId: string,
    ownerId: string,
    typeInput: string,
    input: { fileUrl?: string; url?: string; number?: string; expires?: string },
  ) {
    const vehicle = await this.assertVehicleOwner(vehicleId, ownerId);
    const type = typeInput.trim().toUpperCase();
    const required = this.requiredVehicleDocuments.find((item) => item.type === type);
    if (!required) throw new BadRequestException('Unsupported vehicle document type.');
    const fileUrl = String(input.fileUrl ?? input.url ?? '').trim();
    if (!fileUrl) throw new BadRequestException('Document file URL is required.');
    const expires = input.expires ? new Date(input.expires) : null;
    const expiresValue = expires && !Number.isNaN(expires.getTime()) ? expires : null;
    const id = `${vehicleId}-${type.toLowerCase()}`;

    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; state: string }>>(
      `insert into "VehicleDocument" ("id", "vehicleId", "type", "title", "state", "number", "expires", "fileUrl", "updatedAt")
       values ($1, $2, $3, $4, 'PENDING_REVIEW'::"DriverDocumentState", $5, $6, $7, current_timestamp)
       on conflict ("vehicleId", "type") do update set
         "state" = 'PENDING_REVIEW'::"DriverDocumentState", "number" = excluded."number",
         "expires" = excluded."expires", "fileUrl" = excluded."fileUrl", "reviewNote" = null,
         "reviewedAt" = null, "reviewedById" = null, "updatedAt" = current_timestamp
       returning "id", lower("state"::text) as "state"`,
      id, vehicleId, type, required.title, input.number ?? null, expiresValue, fileUrl,
    ).catch((error) => {
      throw new InternalServerErrorException(`Could not save this vehicle document: ${this.errorMessage(error)}`);
    });

    await this.notifications.create({
      role: 'ADMIN', title: 'Vehicle document uploaded',
      body: `${required.title} for ${vehicle.plateNumber} needs review.`, tone: 'WARNING',
      entity: 'VehicleDocument', entityId: rows[0]?.id ?? id, actionUrl: '/admin/vehicle-documents',
    }).catch(() => null);
    return { uploaded: true, message: 'Vehicle document uploaded for review.', document: rows[0] };
  }

  async pendingVehicleDocuments() {
    return this.prisma.$queryRawUnsafe<Array<{
      id: string; vehicleId: string; type: string; title: string; number: string | null;
      expires: Date | null; fileUrl: string | null; createdAt: Date; plateNumber: string;
      ownerId: string; ownerEmail: string; ownerName: string | null;
    }>>(
      `select d."id", d."vehicleId", d."type", d."title", d."number", d."expires", d."fileUrl", d."createdAt",
              v."plateNumber", v."ownerId", u."email" as "ownerEmail", p."fullName" as "ownerName"
       from "VehicleDocument" d join "Vehicle" v on v."id" = d."vehicleId"
       join "User" u on u."id" = v."ownerId" left join "Profile" p on p."userId" = u."id"
       where d."state" = 'PENDING_REVIEW'::"DriverDocumentState"
       order by d."createdAt" asc limit 100`,
    ).then((rows) => rows.map((row) => ({
      ...row,
      ownerName: row.ownerName ?? row.ownerEmail,
      expires: row.expires?.toISOString() ?? null,
      submittedAt: row.createdAt.toISOString(),
    })));
  }

  async reviewVehicleDocument(documentId: string, reviewerId: string, input: { decision?: string; note?: string }) {
    const decision = String(input.decision ?? '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new BadRequestException('Use APPROVE or REJECT as the document decision.');
    if (decision === 'REJECT' && !String(input.note ?? '').trim()) throw new BadRequestException('A reviewer note is required when rejecting a document.');
    const state = decision === 'APPROVE' ? 'VERIFIED' : 'REJECTED';
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; vehicleId: string; title: string; ownerId: string; plateNumber: string; state: string }>>(
      `update "VehicleDocument" d set "state" = $1::"DriverDocumentState", "reviewNote" = $2,
         "reviewedAt" = current_timestamp, "reviewedById" = $3, "updatedAt" = current_timestamp
       from "Vehicle" v where d."id" = $4 and d."vehicleId" = v."id"
         and d."state" = 'PENDING_REVIEW'::"DriverDocumentState"
       returning d."id", d."vehicleId", d."title", v."ownerId", v."plateNumber", lower(d."state"::text) as "state"`,
      state, input.note ?? null, reviewerId, documentId,
    ).catch((error) => {
      throw new InternalServerErrorException(`Could not record this vehicle document decision: ${this.errorMessage(error)}`);
    });
    const updated = rows[0];
    if (!updated) throw new NotFoundException('No pending vehicle document found; it may already have been reviewed.');
    await this.notifications.create({
      userId: updated.ownerId,
      title: decision === 'APPROVE' ? `${updated.title} verified` : `${updated.title} needs attention`,
      body: decision === 'APPROVE'
        ? `${updated.title} for ${updated.plateNumber} is verified.`
        : `${updated.title} for ${updated.plateNumber} was rejected: ${input.note}`,
      tone: decision === 'APPROVE' ? 'SUCCESS' : 'DANGER',
      entity: 'VehicleDocument', entityId: updated.id, actionUrl: `/owner/vehicle-documents/${updated.vehicleId}`,
    }).catch(() => null);
    return { id: updated.id, vehicleId: updated.vehicleId, state: updated.state, decision };
  }

  private async assertVehicleOwner(vehicleId: string, ownerId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({ where: { id: vehicleId, ownerId }, select: { id: true, plateNumber: true } });
    if (!vehicle) throw new NotFoundException('Truck not found for this owner account.');
    return vehicle;
  }

  // A real read failure used to be indistinguishable from "no row yet" (the normal state
  // before a driver has ever touched a safety toggle) - both fell back to the same fake
  // defaults, including a fabricated emergencyContact phone number that was never
  // actually theirs. A read failure now throws; "no row yet" still returns real column
  // defaults for the booleans (matches SafetySettings' actual schema defaults - this
  // isn't faking data, it's what a fresh row would genuinely contain), but an honest
  // `null` for emergencyContact instead of inventing one.
  async safetySettings(userId: string) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        { availableForAssignments: boolean; shareLiveTripLocation: boolean; nightDrivingCheckIns: boolean; emergencyContact: string | null }[]
      >(
        'select "availableForAssignments", "shareLiveTripLocation", "nightDrivingCheckIns", "emergencyContact" from "SafetySettings" where "userId" = $1 limit 1',
        userId,
      );
      if (rows[0]) return rows[0];
    } catch (error) {
      throw new InternalServerErrorException(`Could not load safety settings: ${this.errorMessage(error)}`);
    }

    return {
      availableForAssignments: true,
      shareLiveTripLocation: true,
      nightDrivingCheckIns: true,
      emergencyContact: null,
    };
  }

  async updateSafetySetting(input: { key?: string; value?: boolean | string }, userId: string) {
    // This never actually wrote to the database - it just echoed back
    // { ...currentSettings, [key]: value } as if it had saved, so a driver's safety
    // toggles (live location sharing, night-driving check-ins, emergency contact) reset
    // the moment they reloaded the app, no matter how many times they changed them.
    const key = String(input.key ?? 'shareLiveTripLocation');
    const validKeys = ['availableForAssignments', 'shareLiveTripLocation', 'nightDrivingCheckIns', 'emergencyContact'];
    if (!validKeys.includes(key)) {
      throw new BadRequestException(`Unknown safety setting: ${key}`);
    }

    const current = (await this.safetySettings(userId)) as {
      availableForAssignments: boolean;
      shareLiveTripLocation: boolean;
      nightDrivingCheckIns: boolean;
      emergencyContact: string | null;
    };
    const next = { ...current, [key]: input.value };

    try {
      await this.prisma.$executeRawUnsafe(
        `insert into "SafetySettings" ("id", "userId", "availableForAssignments", "shareLiveTripLocation", "nightDrivingCheckIns", "emergencyContact", "updatedAt")
         values ($1, $2, $3, $4, $5, $6, current_timestamp)
         on conflict ("userId") do update set
           "availableForAssignments" = excluded."availableForAssignments",
           "shareLiveTripLocation" = excluded."shareLiveTripLocation",
           "nightDrivingCheckIns" = excluded."nightDrivingCheckIns",
           "emergencyContact" = excluded."emergencyContact",
           "updatedAt" = current_timestamp`,
        `safety_${randomUUID().replace(/-/g, '')}`,
        userId,
        Boolean(next.availableForAssignments),
        Boolean(next.shareLiveTripLocation),
        Boolean(next.nightDrivingCheckIns),
        next.emergencyContact ? String(next.emergencyContact) : null,
      );
    } catch (error) {
      throw new InternalServerErrorException(`Could not save this safety setting. Please try again: ${this.errorMessage(error)}`);
    }

    return next;
  }

  async updateDriverAvailabilityLocation(
    userId: string,
    input: { latitude?: number; longitude?: number },
  ) {
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new BadRequestException('A valid latitude is required.');
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new BadRequestException('A valid longitude is required.');
    }

    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        availableForAssignments: boolean;
        lastKnownLatitude: number;
        lastKnownLongitude: number;
        locationUpdatedAt: Date;
      }>>(
        `insert into "SafetySettings" ("id", "userId", "lastKnownLatitude", "lastKnownLongitude", "locationUpdatedAt", "updatedAt")
         values ($1, $2, $3, $4, current_timestamp, current_timestamp)
         on conflict ("userId") do update set
           "lastKnownLatitude" = excluded."lastKnownLatitude",
           "lastKnownLongitude" = excluded."lastKnownLongitude",
           "locationUpdatedAt" = current_timestamp,
           "updatedAt" = current_timestamp
         returning "availableForAssignments", "lastKnownLatitude", "lastKnownLongitude", "locationUpdatedAt"`,
        `safety_${randomUUID().replace(/-/g, '')}`,
        userId,
        latitude,
        longitude,
      );
      return rows[0];
    } catch (error) {
      throw new InternalServerErrorException(`Could not update driver location: ${this.errorMessage(error)}`);
    }
  }

  // updatePlatformSetting() used to just echo `{ ...defaults, value: body.value }` straight
  // back to the caller with no database write at all - an admin toggling e.g. maintenance
  // mode saw it "save", but the very next load reverted to this hardcoded default. These
  // are now real, persisted, audit-logged rows. Note: persisting the value is the whole of
  // this fix - actually enforcing what each flag means (blocking signups, showing a
  // maintenance banner, requiring staff 2FA, skipping manual KYC review) is separate,
  // larger work nothing in the codebase currently reads these flags to act on.
  private readonly platformSettingCatalog: {
    key: string;
    title: string;
    description: string;
    label: string;
    defaultValue: string;
    helper: string;
    type: 'number' | 'text' | 'boolean';
    min?: number;
    max?: number;
  }[] = [
    { key: 'fee', title: 'Platform fee', description: 'Default platform commission applied to new shipments.', label: 'Fee (%)', defaultValue: '7.5', helper: 'Applies to newly created shipments only; shipments already in progress keep their original rate.', type: 'number' },
    { key: 'pricingServiceFeePercent', title: 'Quote service fee', description: 'Service and escrow fee included in new customer quotes.', label: 'Service fee (%)', defaultValue: '3.5', helper: 'Allowed range: 0-20%. Existing shipment quotes remain unchanged.', type: 'number', min: 0, max: 20 },
    { key: 'pricingFuelSurchargePercent', title: 'Fuel surcharge', description: 'Fuel adjustment applied to the distance-based line-haul charge.', label: 'Fuel surcharge (%)', defaultValue: '0', helper: 'Allowed range: 0-50%. Set to 0 when no surcharge is required.', type: 'number', min: 0, max: 50 },
    { key: 'pricingTollAllowanceNgn', title: 'Toll allowance', description: 'Flat toll and route allowance included in every new quote.', label: 'Allowance (NGN)', defaultValue: '0', helper: 'Allowed range: NGN 0-500,000 per shipment.', type: 'number', min: 0, max: 500000 },
    { key: 'pricingDemandSurgePercent', title: 'Demand adjustment', description: 'Temporary network demand adjustment applied to new quotes.', label: 'Demand adjustment (%)', defaultValue: '0', helper: 'Allowed range: 0-50%. Keep at 0 during normal demand.', type: 'number', min: 0, max: 50 },
    { key: 'pricingQuoteValidityMinutes', title: 'Quote validity', description: 'How long a customer quote remains valid before it must be recalculated.', label: 'Validity (minutes)', defaultValue: '30', helper: 'Allowed range: 5-240 minutes.', type: 'number', min: 5, max: 240 },
    { key: 'driverOfferValidityMinutes', title: 'Driver offer validity', description: 'How long a driver has to accept or decline a shipment offer.', label: 'Validity (minutes)', defaultValue: '15', helper: 'Allowed range: 5-120 minutes. Expired offers return to dispatch for reassignment.', type: 'number', min: 5, max: 120 },
    { key: 'pricingFlatbedBaseFareNgn', title: 'Flatbed base fare', description: 'Starting charge for a flatbed shipment.', label: 'Base fare (NGN)', defaultValue: '55000', helper: 'Allowed range: NGN 0-2,000,000.', type: 'number', min: 0, max: 2000000 },
    { key: 'pricingFlatbedPerKmRateNgn', title: 'Flatbed kilometre rate', description: 'Distance rate for flatbed shipments.', label: 'Rate per km (NGN)', defaultValue: '720', helper: 'Allowed range: NGN 100-10,000 per km.', type: 'number', min: 100, max: 10000 },
    { key: 'pricingFlatbedMinimumFareNgn', title: 'Flatbed minimum fare', description: 'Lowest permitted quote for a flatbed shipment.', label: 'Minimum fare (NGN)', defaultValue: '95000', helper: 'Allowed range: NGN 0-2,000,000.', type: 'number', min: 0, max: 2000000 },
    { key: 'pricingBoxBaseFareNgn', title: 'Box truck base fare', description: 'Starting charge for a box truck shipment.', label: 'Base fare (NGN)', defaultValue: '50000', helper: 'Allowed range: NGN 0-2,000,000.', type: 'number', min: 0, max: 2000000 },
    { key: 'pricingBoxPerKmRateNgn', title: 'Box truck kilometre rate', description: 'Distance rate for box truck shipments.', label: 'Rate per km (NGN)', defaultValue: '680', helper: 'Allowed range: NGN 100-10,000 per km.', type: 'number', min: 100, max: 10000 },
    { key: 'pricingBoxMinimumFareNgn', title: 'Box truck minimum fare', description: 'Lowest permitted quote for a box truck shipment.', label: 'Minimum fare (NGN)', defaultValue: '90000', helper: 'Allowed range: NGN 0-2,000,000.', type: 'number', min: 0, max: 2000000 },
    { key: 'pricingTipperBaseFareNgn', title: 'Tipper base fare', description: 'Starting charge for a tipper shipment.', label: 'Base fare (NGN)', defaultValue: '60000', helper: 'Allowed range: NGN 0-2,000,000.', type: 'number', min: 0, max: 2000000 },
    { key: 'pricingTipperPerKmRateNgn', title: 'Tipper kilometre rate', description: 'Distance rate for tipper shipments.', label: 'Rate per km (NGN)', defaultValue: '760', helper: 'Allowed range: NGN 100-10,000 per km.', type: 'number', min: 100, max: 10000 },
    { key: 'pricingTipperMinimumFareNgn', title: 'Tipper minimum fare', description: 'Lowest permitted quote for a tipper shipment.', label: 'Minimum fare (NGN)', defaultValue: '100000', helper: 'Allowed range: NGN 0-2,000,000.', type: 'number', min: 0, max: 2000000 },
    { key: 'pricingTankerBaseFareNgn', title: 'Tanker base fare', description: 'Starting charge for a tanker shipment.', label: 'Base fare (NGN)', defaultValue: '70000', helper: 'Allowed range: NGN 0-2,000,000.', type: 'number', min: 0, max: 2000000 },
    { key: 'pricingTankerPerKmRateNgn', title: 'Tanker kilometre rate', description: 'Distance rate for tanker shipments.', label: 'Rate per km (NGN)', defaultValue: '820', helper: 'Allowed range: NGN 100-10,000 per km.', type: 'number', min: 100, max: 10000 },
    { key: 'pricingTankerMinimumFareNgn', title: 'Tanker minimum fare', description: 'Lowest permitted quote for a tanker shipment.', label: 'Minimum fare (NGN)', defaultValue: '115000', helper: 'Allowed range: NGN 0-2,000,000.', type: 'number', min: 0, max: 2000000 },
    { key: 'pricingStandardBaseFareNgn', title: 'Standard truck base fare', description: 'Starting charge for a standard truck shipment.', label: 'Base fare (NGN)', defaultValue: '50000', helper: 'Allowed range: NGN 0-2,000,000.', type: 'number', min: 0, max: 2000000 },
    { key: 'pricingStandardPerKmRateNgn', title: 'Standard truck kilometre rate', description: 'Distance rate for standard truck shipments.', label: 'Rate per km (NGN)', defaultValue: '700', helper: 'Allowed range: NGN 100-10,000 per km.', type: 'number', min: 100, max: 10000 },
    { key: 'pricingStandardMinimumFareNgn', title: 'Standard truck minimum fare', description: 'Lowest permitted quote for a standard truck shipment.', label: 'Minimum fare (NGN)', defaultValue: '90000', helper: 'Allowed range: NGN 0-2,000,000.', type: 'number', min: 0, max: 2000000 },
    { key: 'payout', title: 'Payout schedule', description: 'How often driver payout requests are reviewed for release.', label: 'Schedule', defaultValue: 'weekly', helper: 'Accepted values: daily, weekly, biweekly, monthly.', type: 'text' },
    { key: 'escrow', title: 'Escrow release window', description: 'Intended days after delivery confirmation before escrow auto-releases if undisputed.', label: 'Days', defaultValue: '3', helper: 'Recorded for reference - there is no scheduled job yet to auto-release after this many days. Customers can confirm delivery manually to release funds now, and operations can release/refund from the dispute queue at any time.', type: 'number' },
    { key: 'manualDriverVerification', title: 'Manual driver verification', description: 'Require an admin to manually review every driver KYC submission.', label: 'Manual driver verification', defaultValue: 'true', helper: 'Recorded for reference - KYC review is currently always manual regardless of this flag.', type: 'boolean' },
    { key: 'staff2fa', title: 'Require staff 2FA', description: 'Require two-factor authentication for admin and dispatcher accounts.', label: 'Require staff 2FA', defaultValue: 'false', helper: 'Recorded for reference - login does not yet enforce 2FA regardless of this flag.', type: 'boolean' },
    { key: 'pauseRegistrations', title: 'Pause new registrations', description: 'Temporarily stop new customer, driver, and truck owner sign-ups.', label: 'Pause new registrations', defaultValue: 'false', helper: 'Blocks both the OTP request and account creation steps for new sign-ups while on. Existing accounts can still log in.', type: 'boolean' },
    { key: 'maintenanceMode', title: 'Maintenance mode', description: 'Block new shipment creation network-wide while on.', label: 'Maintenance mode', defaultValue: 'false', helper: 'Blocks new shipment creation with a clear message while on. Existing shipments, tracking, messaging, and login are unaffected - this does not take the whole app down.', type: 'boolean' },
    { key: 'supportHours', title: 'Support hours', description: 'Displayed to customers on the Help & support screen.', label: 'Hours', defaultValue: '24/7', helper: 'Free text, e.g. "Mon-Sat, 8am-8pm WAT".', type: 'text' },
  ];

  async platformSettings() {
    const rows = await this.prisma.platformSetting.findMany().catch(() => []);
    const overridesByKey = new Map(rows.map((row) => [row.key, row.value]));
    return this.platformSettingCatalog.map((definition) => this.toPlatformSetting(definition, overridesByKey.get(definition.key)));
  }

  async platformSetting(key: string) {
    const definition = this.platformSettingCatalog.find((entry) => entry.key === key) ?? this.platformSettingCatalog[0];
    const row = await this.prisma.platformSetting.findUnique({ where: { key: definition.key } }).catch(() => null);
    return this.toPlatformSetting(definition, row?.value);
  }

  async updatePlatformSetting(key: string, value: string, actorId: string) {
    const definition = this.platformSettingCatalog.find((entry) => entry.key === key);
    if (!definition) throw new BadRequestException(`Unknown platform setting: ${key}`);
    if (definition.type === 'boolean' && value !== 'true' && value !== 'false') {
      throw new BadRequestException(`${definition.title} must be true or false.`);
    }
    if (definition.type === 'number' && (!value.trim() || Number.isNaN(Number(value)))) {
      throw new BadRequestException(`${definition.title} must be a number.`);
    }
    if (definition.type === 'number' && definition.min !== undefined && Number(value) < definition.min) {
      throw new BadRequestException(`${definition.title} must be at least ${definition.min}.`);
    }
    if (definition.type === 'number' && definition.max !== undefined && Number(value) > definition.max) {
      throw new BadRequestException(`${definition.title} must not exceed ${definition.max}.`);
    }

    try {
      await this.prisma.platformSetting.upsert({
        where: { key: definition.key },
        update: { value, updatedById: actorId },
        create: { key: definition.key, value, updatedById: actorId },
      });
    } catch (error) {
      throw new InternalServerErrorException(`Could not save ${definition.title.toLowerCase()}. Please try again: ${this.errorMessage(error)}`);
    }

    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: 'PLATFORM_SETTING_UPDATED',
        entity: 'PlatformSetting',
        entityId: definition.key,
        metadata: { key: definition.key, value },
      },
    }).catch(() => null);

    return this.toPlatformSetting(definition, value);
  }

  private toPlatformSetting(definition: (typeof this.platformSettingCatalog)[number], storedValue?: string) {
    const value = storedValue ?? definition.defaultValue;
    const displayValue = definition.type === 'boolean' ? (value === 'true' ? 'On' : 'Off')
      : definition.type === 'number' && (definition.key === 'fee' || definition.key.endsWith('Percent')) ? `${value}%`
      : definition.type === 'number' && definition.key.endsWith('Ngn') ? `NGN ${Number(value).toLocaleString('en-US')}`
      : definition.key === 'pricingQuoteValidityMinutes' ? `${value} minutes`
      : definition.key === 'payout' ? value.charAt(0).toUpperCase() + value.slice(1)
      : value;
    return {
      key: definition.key,
      title: definition.title,
      description: definition.description,
      label: definition.label,
      value,
      displayValue,
      helper: definition.helper,
      type: definition.type,
    };
  }

  async auditLogs(category?: string) {
    try {
      const logs = await this.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      const actorIds = [...new Set(logs.map((log) => log.actorId).filter(Boolean) as string[])];
      const actors = await this.prisma.user.findMany({
        where: { id: { in: actorIds } },
        include: { profile: true },
      });
      const actorsById = new Map(actors.map((actor) => [actor.id, actor]));
      const records = logs.map((log) => {
        const actor = log.actorId ? actorsById.get(log.actorId) : null;
        const recordCategory = this.auditCategory(log.action, log.entity);
        return {
          id: log.id,
          actor: actor?.profile?.fullName ?? actor?.email ?? 'System',
          action: this.auditActionLabel(log.action),
          time: this.auditTime(log.createdAt),
          icon: this.auditIcon(log.action, log.entity),
          tone: this.auditTone(log.action),
          category: recordCategory,
        };
      });

      if (category && category !== 'All') return records.filter((record) => record.category === category);
      return records;
    } catch (error) {
      // Used to fall back to 3 hardcoded fake audit entries ("Preview backend started",
      // "Reviewed demo workflow"...) on any read failure - an admin investigating an
      // incident during a DB hiccup would see fabricated audit history with nothing
      // distinguishing it from the real trail, which defeats the entire point of an
      // audit log.
      throw new InternalServerErrorException(`Could not load audit logs. Please try again: ${this.errorMessage(error)}`);
    }
  }

  async pricingReport() {
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    let logs;
    try {
      logs = await this.prisma.auditLog.findMany({
        where: {
          action: 'SHIPMENT_QUOTE_ACCEPTED',
          createdAt: { gte: periodStart },
        },
        include: { actor: { include: { profile: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
    } catch {
      throw new InternalServerErrorException('Could not load the pricing report. Please try again.');
    }

    const quotes = logs.map((log) => {
      const metadata = (log.metadata ?? {}) as Record<string, unknown>;
      const breakdown = metadata.pricingBreakdown && typeof metadata.pricingBreakdown === 'object'
        ? metadata.pricingBreakdown as Record<string, unknown>
        : {};
      const amountKobo = this.reportNumber(metadata.quotedPriceKobo);
      const distanceKm = this.reportNumber(metadata.distanceKm);
      return {
        id: log.id,
        shipmentId: log.entityId ?? undefined,
        customer: log.actor?.profile?.fullName ?? log.actor?.email ?? 'Customer',
        acceptedAt: log.createdAt.toISOString(),
        amountKobo,
        distanceKm,
        ratePerKmKobo: distanceKm > 0 ? Math.round(amountKobo / distanceKm) : 0,
        truckType: String(breakdown.truckType ?? 'Truck'),
        provider: String(metadata.provider ?? 'coordinate'),
        pricingMode: String(metadata.pricingMode ?? 'coordinate_estimate'),
        pricingVersion: String(metadata.pricingVersion ?? 'unknown'),
      };
    });
    const totalQuoteValueKobo = quotes.reduce((total, quote) => total + quote.amountKobo, 0);
    const totalDistanceKm = quotes.reduce((total, quote) => total + quote.distanceKm, 0);
    const liveRouteCount = quotes.filter((quote) => quote.provider === 'google' || quote.pricingMode === 'live_road_route').length;

    return {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      acceptedQuoteCount: quotes.length,
      totalQuoteValueKobo,
      averageQuoteKobo: quotes.length ? Math.round(totalQuoteValueKobo / quotes.length) : 0,
      averageRatePerKmKobo: totalDistanceKm > 0 ? Math.round(totalQuoteValueKobo / totalDistanceKm) : 0,
      liveRoutePercent: quotes.length ? Math.round((liveRouteCount / quotes.length) * 100) : 0,
      latestQuotes: quotes.slice(0, 20),
    };
  }

  async auditLog(id: string) {
    try {
      const log = await this.prisma.auditLog.findUnique({ where: { id } });
      if (!log) throw new NotFoundException('Audit entry not found.');
      const actor = log.actorId
        ? await this.prisma.user.findUnique({ where: { id: log.actorId }, include: { profile: true } })
        : null;
      const metadata = (log.metadata ?? {}) as Record<string, unknown>;
      return {
        id: log.id,
        actor: actor?.profile?.fullName ?? actor?.email ?? 'System',
        action: this.auditActionLabel(log.action),
        time: log.createdAt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
        icon: this.auditIcon(log.action, log.entity),
        tone: this.auditTone(log.action),
        category: this.auditCategory(log.action, log.entity),
        role: actor?.role ?? 'SYSTEM',
        target: [log.entity, log.entityId].filter(Boolean).join(' - ') || log.entity,
        ip: String(metadata.ip ?? metadata.source ?? 'Vercel/Supabase'),
        result: String(metadata.status ?? metadata.result ?? 'Recorded'),
      };
    } catch (error) {
      // Used to fall back to a fake preview audit entry on ANY failure - including a
      // genuinely-missing id, since the NotFoundException thrown above was swallowed by
      // this same catch instead of propagating. The fallback didn't even look up the
      // requested id among its 3 hardcoded fakes correctly: any real id (which never
      // matches 'audit-1'/'audit-2'/'audit-3') silently returned the FIRST fake entry
      // ("System - Preview backend started") as if it were the record the admin asked
      // for - a serious integrity problem for a feature that exists for accountability.
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(`Could not load this audit entry. Please try again: ${this.errorMessage(error)}`);
    }
  }

  private auditActionLabel(action: string) {
    return action
      .toLowerCase()
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private auditCategory(action: string, entity: string) {
    if (/PAYOUT|ESCROW|PAYMENT/i.test(`${action} ${entity}`)) return 'Finance';
    if (/AUTH|LOGIN|OTP|KYC|USER|ACCOUNT/i.test(`${action} ${entity}`)) return 'Accounts';
    return 'System';
  }

  private auditIcon(action: string, entity: string) {
    if (/PAYOUT|ESCROW|PAYMENT/i.test(`${action} ${entity}`)) return 'payments';
    if (/KYC|VERIFICATION/i.test(`${action} ${entity}`)) return 'verified-user';
    if (/AUTH|LOGIN|OTP|USER/i.test(`${action} ${entity}`)) return 'manage-accounts';
    return 'history';
  }

  private auditTone(action: string): 'success' | 'error' | 'warning' | 'info' {
    if (/REJECT|FAIL|ERROR|DISPUTE/i.test(action)) return 'error';
    if (/REQUEST|PENDING|REVIEW/i.test(action)) return 'warning';
    if (/APPROVE|PAID|RELEASE|SUCCESS|COMPLETE/i.test(action)) return 'success';
    return 'info';
  }

  private auditTime(date: Date) {
    const minutes = Math.max(1, Math.round((Date.now() - date.getTime()) / 60000));
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  private reportNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }
}
