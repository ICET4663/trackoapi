import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
  ) {}

  async accountOverview(role: Role, userId = 'preview-user', authRole?: Role) {
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
    } catch {
      // Preview fallback below.
    }

    const base = {
      badges: { notifications: '2' },
      values: {},
    };

    if (role === 'DRIVER') {
      return {
        ...base,
        stats: [
          { label: 'Trips', value: '12' },
          { label: 'Rating', value: '5.0' },
          { label: 'Docs', value: 'OK' },
        ],
        badges: { notifications: '2', driverDocuments: '1' },
        values: { regionShift: 'Lagos', driverDocuments: '1 due' },
      };
    }

    if (role === 'TRUCK_OWNER') {
      return {
        ...base,
        stats: [
          { label: 'Trucks', value: '3' },
          { label: 'Assigned', value: '2' },
          { label: 'Docs', value: 'OK' },
        ],
        badges: { notifications: '2', truckDocuments: '1' },
        values: { truckDocuments: '1 due' },
      };
    }

    if (role === 'ADMIN' || role === 'DISPATCHER') {
      return {
        ...base,
        stats: [
          { label: 'Open', value: '8' },
          { label: 'Alerts', value: '1' },
          { label: 'Resolved', value: '24' },
        ],
        badges: { notifications: '2', alerts: '1', fraudAlerts: '0' },
      };
    }

    return {
      ...base,
      stats: [
        { label: 'Shipments', value: '4' },
        { label: 'Active', value: '1' },
        { label: 'Wallet', value: 'N0' },
      ],
    };
  }

  async profile(userId = 'preview-user') {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: { profile: true },
      });
      if (user) return this.toProfileRecord(user);
    } catch {
      // Preview fallback below.
    }

    return this.previewProfile(userId);
  }

  async updateProfile(userId: string, input: Record<string, unknown>) {
    try {
      const current = await this.prisma.user.findUnique({
        where: { id: userId },
        include: { profile: true },
      });
      if (!current) return { ...this.previewProfile(userId), ...input };

      const fullName = String(input.fullName ?? current.profile?.fullName ?? current.email).trim();
      const address = input.address === undefined ? current.profile?.address : input.address ? String(input.address) : null;
      const avatarUrl = input.avatarUrl === undefined ? current.profile?.avatarUrl : input.avatarUrl ? String(input.avatarUrl) : null;

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
    } catch {
      return { ...this.previewProfile(userId), ...input };
    }
  }

  async requestAccountDeletion(userId: string, input: { reason?: string }) {
    const id = `account-deletion-${Date.now()}`;
    const reason = String(input.reason ?? 'User requested account deletion from app.');

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

      await this.notifications.create({
        role: 'ADMIN',
        title: 'Account deletion request',
        body: 'A user requested account deletion from inside the app.',
        tone: 'WARNING',
        entity: 'User',
        entityId: userId,
        actionUrl: '/admin/audit-logs',
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
    } catch {
      return {
        id,
        status: 'PENDING_REVIEW',
        message: 'Account deletion request received in preview.',
      };
    }
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

  private previewProfile(userId: string) {
    return {
      id: userId,
      fullName: 'Tracko Preview User',
      email: 'customer@tracko.ng',
      phone: '+234 800 000 0000',
      verificationStatus: 'VERIFIED',
    };
  }

  async notificationPreferences(userId = 'preview-user', role: Role = 'CUSTOMER') {
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
    } catch {
      return notificationPreferences;
    }
  }

  async updateNotificationPreference(userId: string, role: Role, input: { key?: PreferenceKey; value?: boolean }) {
    if (!input.key) return notificationPreferences;
    try {
      await this.prisma.$executeRawUnsafe(
        `insert into "NotificationPreference" ("userId", "role", "key", "value")
         values ($1, cast($2 as "UserRole"), $3, $4)
         on conflict ("userId", "role", "key")
         do update set "value" = excluded."value", "updatedAt" = current_timestamp`,
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
    } catch {
      return { ...notificationPreferences, [input.key]: Boolean(input.value) };
    }
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

    try {
      await this.prisma.$executeRawUnsafe(
        `insert into "SupportTicket" ("id", "shipmentId", "userId", "topic", "channel", "message", "status")
         values ($1, $2, $3, $4, $5, $6, 'OPEN'::"SupportTicketStatus")`,
        id,
        input.shipmentId ?? null,
        userId,
        topic,
        channel,
        message,
      );

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
    } catch {
      return {
        message: `${channel} request received for ${input.role ?? 'user'} preview.`,
        conversationId: 'preview-support-thread',
        ticketId: id,
        status: 'OPEN',
      };
    }
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

    try {
      await this.prisma.$executeRawUnsafe(
        `insert into "SupportTicket" ("id", "shipmentId", "userId", "topic", "channel", "message", "status")
         values ($1, $2, $3, $4, 'EMERGENCY', $5, 'OPEN'::"SupportTicketStatus")`,
        id,
        input.shipmentId ?? null,
        userId,
        input.topic,
        message,
      );

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
    } catch {
      return {
        sent: true,
        reported: true,
        ticketId: id,
        status: 'OPEN',
        priority: 'HIGH',
        message: `${input.topic} captured in preview mode.`,
      };
    }
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
    } catch {
      return [
        {
          id: 'support-preview-1',
          shipmentId: null,
          userId: 'preview-customer',
          userName: 'Tracko Customer',
          userEmail: 'customer@tracko.ng',
          topic: 'General support',
          channel: 'CHAT',
          message: 'Preview support ticket.',
          status: 'OPEN',
          createdAt: new Date().toISOString(),
          createdAtLabel: 'Today',
          updatedAt: new Date().toISOString(),
        },
      ];
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
      if (error instanceof NotFoundException) throw error;
      return {
        id,
        status: 'RESOLVED',
        message: 'Support ticket resolved in preview.',
      };
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

  async savedAddresses(userId = 'preview-customer') {
    try {
      const rows = await this.prisma.$queryRawUnsafe<SavedAddressRecord[]>(
        'select "id", "label", "line", "city", "address", "icon", "isDefaultPickup" from "SavedAddress" where "userId" = $1 order by "isDefaultPickup" desc, "createdAt" desc limit 50',
        userId,
      );
      if (rows.length) return rows;
    } catch {
      // Preview fallback below.
    }

    return [
      {
        id: 'addr-home',
        label: 'Home',
        line: 'Lekki Phase 1',
        city: 'Lagos',
        address: 'Lekki Phase 1, Lagos',
        icon: 'home',
        isDefaultPickup: true,
      },
      {
        id: 'addr-office',
        label: 'Office',
        line: 'Victoria Island',
        city: 'Lagos',
        address: 'Victoria Island, Lagos',
        icon: 'business',
      },
    ];
  }

  async savedAddress(id: string, userId = 'preview-customer') {
    try {
      const rows = await this.prisma.$queryRawUnsafe<SavedAddressRecord[]>(
        'select "id", "label", "line", "city", "address", "icon", "isDefaultPickup" from "SavedAddress" where "id" = $1 and "userId" = $2 limit 1',
        id,
        userId,
      );
      if (rows[0]) return rows[0];
    } catch {
      // Preview fallback below.
    }

    const preview = await this.savedAddresses(userId);
    return preview.find((address: { id: string }) => address.id === id) ?? { id, label: 'Saved address', line: '', city: '' };
  }

  async saveAddress(input: Record<string, unknown>, id?: string, userId = 'preview-customer') {
    const addressId = id ?? `addr-${Date.now()}`;
    try {
      const rows = await this.prisma.$queryRawUnsafe<SavedAddressRecord[]>(
        `insert into "SavedAddress" ("id", "userId", "label", "line", "city", "address", "icon", "isDefaultPickup")
         values ($1, $2, $3, $4, $5, $6, $7, $8)
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
      if (rows[0]) return rows[0];
    } catch {
      // Preview fallback below.
    }

    return { id: addressId, ...input };
  }

  async paymentMethods(userId = 'preview-customer') {
    try {
      const rows = await this.prisma.$queryRawUnsafe<PaymentMethodRecord[]>(
        'select "id", "brand", "maskedNumber", "detail", "type", "isDefault", "expiry", "holderName" from "PaymentMethod" where "userId" = $1 order by "isDefault" desc, "createdAt" desc',
        userId,
      );
      if (rows.length) return rows;
    } catch {
      // Preview fallback below.
    }

    return [
      {
        id: 'pm-preview',
        brand: 'Visa',
        maskedNumber: '**** 4242',
        detail: 'Preview card',
        type: 'CARD',
        isDefault: true,
        expiry: '12/29',
        holderName: 'Tracko Preview User',
      },
    ];
  }

  async paymentMethod(id: string, userId = 'preview-customer') {
    const methods = await this.paymentMethods(userId);
    return methods.find((method: { id: string }) => method.id === id) ?? { ...methods[0], id };
  }

  async billingHistory(userId = 'preview-customer') {
    try {
      const rows = await this.prisma.$queryRawUnsafe<unknown[]>(
        'select "id", "ref", "dateLabel" as "date", "amount" from "BillingCharge" where "userId" = $1 order by "createdAt" desc',
        userId,
      );
      if (rows.length) return rows;
    } catch {
      // Preview fallback below.
    }

    return [
      { id: 'bill-1', ref: 'TRK-1024', date: 'Jul 21, 2026', amount: 'N240,000' },
      { id: 'bill-2', ref: 'TRK-1008', date: 'Jul 18, 2026', amount: 'N180,000' },
    ];
  }

  async bankAccount(userId = 'preview-driver') {
    try {
      const rows = await this.prisma.$queryRawUnsafe<unknown[]>(
        'select "id", "bankName", "maskedNumber", "holderName", "verified", "payoutSchedule", "pendingPayout" from "BankAccount" where "userId" = $1 limit 1',
        userId,
      );
      if (rows[0]) return rows[0];
    } catch {
      // Preview fallback below.
    }

    return {
      id: 'bank-preview',
      bankName: 'Preview Bank',
      maskedNumber: '**** 0012',
      holderName: 'Tracko Driver',
      verified: true,
      payoutSchedule: 'Weekly',
      pendingPayout: 'N0',
    };
  }

  async driverEarnings(userId = 'preview-driver') {
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
        this.prisma.auditLog.findMany({
          where: { actorId: userId, action: 'PAYOUT_WITHDRAWAL_REQUESTED', entity: 'Payout' },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);

      const withdrawals = withdrawalLogs.map((log) => {
        const metadata = (log.metadata ?? {}) as { amountKobo?: number; status?: string; bankLabel?: string };
        return {
          id: log.id,
          title: 'Withdrawal request',
          amount: -(Number(metadata.amountKobo ?? 0)),
          amountLabel: `-${this.formatMoney(Number(metadata.amountKobo ?? 0))}`,
          status: metadata.status ?? 'PENDING',
          date: log.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          method: metadata.bankLabel ?? 'Payout account',
        };
      });

      const releasedTotal = releasedRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
      const pendingTotal = pendingRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
      const withdrawalTotal = withdrawals.reduce((sum, row) => sum + Math.abs(row.amount), 0);
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
    } catch {
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

    const earnings = await this.driverEarnings(userId);
    if (amountKobo > earnings.availableBalance) {
      throw new BadRequestException('Withdrawal amount is higher than available balance.');
    }

    const bank = earnings.bankAccount as { bankName?: string; maskedNumber?: string };
    if (!(earnings.bankAccount as { verified?: boolean }).verified) {
      throw new BadRequestException('Verify your payout account before requesting withdrawal.');
    }

    const log = await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'PAYOUT_WITHDRAWAL_REQUESTED',
        entity: 'Payout',
        entityId: `payout-${Date.now()}`,
        metadata: {
          amountKobo,
          status: 'PENDING',
          note: input.note ?? null,
          bankLabel: [bank?.bankName, bank?.maskedNumber].filter(Boolean).join(' '),
        },
      },
    });

    await this.notifications.create({
      userId,
      title: 'Withdrawal request submitted',
      body: `${this.formatMoney(amountKobo)} is pending Tracko finance review.`,
      tone: 'INFO',
      entity: 'Payout',
      entityId: log.id,
      actionUrl: '/driver/earnings',
    });

    return {
      id: log.id,
      status: 'PENDING',
      amount: amountKobo,
      amountLabel: this.formatMoney(amountKobo),
      message: 'Withdrawal request submitted for finance review.',
    };
  }

  async adminPayoutRequests() {
    try {
      const logs = await this.prisma.auditLog.findMany({
        where: { action: 'PAYOUT_WITHDRAWAL_REQUESTED', entity: 'Payout' },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      const actorIds = [...new Set(logs.map((log) => log.actorId).filter(Boolean) as string[])];
      const actors = await this.prisma.user.findMany({
        where: { id: { in: actorIds } },
        include: { profile: true },
      });
      const actorsById = new Map(actors.map((actor) => [actor.id, actor]));

      return logs.map((log) => {
        const metadata = (log.metadata ?? {}) as PayoutMetadata;
        const actor = log.actorId ? actorsById.get(log.actorId) : null;
        const bankLabel = metadata.bankLabel || 'Payout account pending';
        return {
          id: log.id,
          driverId: log.actorId,
          driverName: actor?.profile?.fullName ?? actor?.email ?? 'Driver',
          driverEmail: actor?.email,
          amount: Number(metadata.amountKobo ?? 0),
          amountLabel: this.formatMoney(Number(metadata.amountKobo ?? 0)),
          status: metadata.status ?? 'PENDING',
          bankLabel,
          note: metadata.note ?? null,
          reviewNote: metadata.reviewNote ?? null,
          requestedAt: log.createdAt.toISOString(),
          requestedAtLabel: log.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        };
      });
    } catch {
      return [
        {
          id: 'payout-preview-1',
          driverId: 'preview-driver',
          driverName: 'Tracko Driver',
          driverEmail: 'driver@tracko.ng',
          amount: 12000000,
          amountLabel: 'N120,000',
          status: 'PENDING',
          bankLabel: 'Preview Bank **** 0012',
          note: null,
          reviewNote: null,
          requestedAt: new Date().toISOString(),
          requestedAtLabel: 'Today',
        },
      ];
    }
  }

  async reviewPayoutRequest(id: string, reviewerId: string, input: { decision?: string; note?: string }) {
    const decision = String(input.decision ?? '').toUpperCase();
    if (!['APPROVED', 'REJECTED', 'PAID'].includes(decision)) {
      throw new BadRequestException('Use APPROVED, REJECTED, or PAID as the payout decision.');
    }

    if (id.startsWith('payout-preview-')) {
      return {
        id,
        status: decision,
        amount: 12000000,
        amountLabel: 'N120,000',
        message: `Preview payout request marked as ${decision.toLowerCase()}.`,
      };
    }

    if (id.startsWith('payout-preview-')) {
      return {
        id,
        status: decision,
        amount: 12000000,
        amountLabel: 'N120,000',
        message: `Preview payout request marked as ${decision.toLowerCase()}.`,
      };
    }

    const log = await this.prisma.auditLog.findUnique({ where: { id } });
    if (!log || log.action !== 'PAYOUT_WITHDRAWAL_REQUESTED') {
      throw new NotFoundException('Payout request not found.');
    }

    const metadata = (log.metadata ?? {}) as PayoutMetadata;
    const updated = await this.prisma.auditLog.update({
      where: { id },
      data: {
        metadata: {
          ...metadata,
          status: decision,
          reviewedAt: new Date().toISOString(),
          reviewedBy: reviewerId,
          reviewNote: input.note ?? null,
        },
      },
    });

    const nextMetadata = (updated.metadata ?? {}) as PayoutMetadata;
    if (updated.actorId) {
      await this.notifications.create({
        userId: updated.actorId,
        title: decision === 'PAID' ? 'Withdrawal paid' : decision === 'APPROVED' ? 'Withdrawal approved' : 'Withdrawal rejected',
        body: `${this.formatMoney(Number(nextMetadata.amountKobo ?? 0))} payout request was marked ${decision.toLowerCase()}.`,
        tone: decision === 'REJECTED' ? 'DANGER' : 'SUCCESS',
        entity: 'Payout',
        entityId: updated.id,
        actionUrl: '/driver/earnings',
      });
    }

    return {
      id: updated.id,
      status: nextMetadata.status ?? decision,
      amount: Number(nextMetadata.amountKobo ?? 0),
      amountLabel: this.formatMoney(Number(nextMetadata.amountKobo ?? 0)),
      message: `Payout request marked as ${decision.toLowerCase()}.`,
    };
  }

  private formatMoney(amountKobo?: number | null) {
    if (!amountKobo) return 'N0';
    return `N${Math.round(Number(amountKobo) / 100).toLocaleString('en-US')}`;
  }

  async driverDocuments(userId = 'preview-driver') {
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        { id: string; title: string; meta: string; state: string; issued?: Date; expires?: Date; number?: string; fileUrl?: string }[]
      >(
        'select "id", "title", "meta", lower("state"::text) as "state", "issued", "expires", "number", "fileUrl" from "DriverDocument" where "userId" = $1 order by "createdAt" desc',
        userId,
      );
      if (rows.length) {
        return rows.map((row) => ({
          ...row,
          issued: row.issued?.toISOString?.(),
          expires: row.expires?.toISOString?.(),
        }));
      }
    } catch {
      // Preview fallback below.
    }

    return [
      { id: 'license', title: 'Driver license', meta: 'Valid until Dec 2027', state: 'verified', expires: '2027-12-31' },
      { id: 'insurance', title: 'Vehicle insurance', meta: 'Upload required', state: 'missing' },
    ];
  }

  async driverDocument(id: string, userId = 'preview-driver') {
    const documents = await this.driverDocuments(userId);
    return documents.find((document: { id: string }) => document.id === id) ?? { id, title: 'Document', meta: 'Preview', state: 'missing' };
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
      const rows = await this.prisma.$queryRawUnsafe<
        { id: string; title: string; meta: string; state: string; issued?: Date; expires?: Date; number?: string; fileUrl?: string }[]
      >(
        `insert into "DriverDocument" ("id", "userId", "title", "meta", "state", "expires", "number", "fileUrl")
         values ($1, $2, $3, $4, 'EXPIRING'::"DriverDocumentState", $5, $6, $7)
         on conflict ("id") do update
         set "meta" = excluded."meta",
             "state" = 'EXPIRING'::"DriverDocumentState",
             "expires" = excluded."expires",
             "number" = excluded."number",
             "fileUrl" = excluded."fileUrl",
             "updatedAt" = current_timestamp
         returning "id", "title", "meta", lower("state"::text) as "state", "issued", "expires", "number", "fileUrl"`,
        id,
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
          entityId: id,
          metadata: { fileUrl, number: input.number ?? null, expires: input.expires ?? null },
        },
      }).catch(() => null);

      await this.notifications.create({
        role: 'ADMIN',
        title: 'Driver document uploaded',
        body: `${title} was uploaded and needs review.`,
        tone: 'WARNING',
        entity: 'DriverDocument',
        entityId: id,
        actionUrl: '/admin/verifications',
      });

      return {
        uploaded: true,
        message: 'Driver document uploaded for review.',
        document: rows[0] ?? { id, title, meta: input.meta ?? 'Uploaded - pending review', state: 'expiring', fileUrl },
      };
    } catch {
      return {
        uploaded: true,
        message: 'Driver document uploaded in preview.',
        document: { id, title, meta: input.meta ?? 'Uploaded - pending review', state: 'expiring', fileUrl },
      };
    }
  }

  async safetySettings(userId = 'preview-driver') {
    try {
      const rows = await this.prisma.$queryRawUnsafe<unknown[]>(
        'select "shareLiveTripLocation", "nightDrivingCheckIns", "emergencyContact" from "SafetySettings" where "userId" = $1 limit 1',
        userId,
      );
      if (rows[0]) return rows[0];
    } catch {
      // Preview fallback below.
    }

    return {
      shareLiveTripLocation: true,
      nightDrivingCheckIns: true,
      emergencyContact: '+234 800 000 0000',
    };
  }

  async updateSafetySetting(input: { key?: string; value?: boolean | string }, userId = 'preview-driver') {
    return { ...(await this.safetySettings(userId)), [String(input.key ?? 'shareLiveTripLocation')]: input.value };
  }

  platformSettings() {
    return [
      {
        key: 'fee',
        title: 'Platform fee',
        description: 'Default platform commission for preview shipments.',
        label: 'Fee',
        value: '7.5',
        displayValue: '7.5%',
        helper: 'Preview only',
        type: 'number',
      },
      {
        key: 'payout',
        title: 'Payout schedule',
        description: 'Driver payout timing.',
        label: 'Schedule',
        value: 'weekly',
        displayValue: 'Weekly',
        helper: 'Preview only',
        type: 'text',
      },
    ];
  }

  platformSetting(key: string) {
    return this.platformSettings().find((setting) => setting.key === key) ?? this.platformSettings()[0];
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
    } catch {
      return this.previewAuditLogs(category);
    }
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
    } catch {
      const log = this.previewAuditLogs().find((entry) => entry.id === id) ?? this.previewAuditLogs()[0];
      return { ...log, role: 'ADMIN', target: 'Tracko preview', ip: '127.0.0.1', result: 'Completed' };
    }
  }

  private previewAuditLogs(category?: string) {
    const logs = [
      { id: 'audit-1', actor: 'System', action: 'Preview backend started', time: 'Today', icon: 'settings', tone: 'success', category: 'System' },
      { id: 'audit-2', actor: 'Admin', action: 'Reviewed demo workflow', time: 'Today', icon: 'verified', tone: 'info', category: 'Accounts' },
      { id: 'audit-3', actor: 'Finance', action: 'Payout request recorded', time: 'Today', icon: 'payments', tone: 'warning', category: 'Finance' },
    ];
    if (category && category !== 'All') return logs.filter((log) => log.category === category);
    return logs;
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
}


