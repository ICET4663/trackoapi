import { Injectable, NotFoundException } from '@nestjs/common';
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
  constructor(private readonly prisma: PrismaService) {}

  accountOverview(role: Role) {
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

  profile() {
    return {
      id: 'preview-user',
      fullName: 'Tracko Preview User',
      email: 'customer@tracko.ng',
      phone: '+234 800 000 0000',
      verificationStatus: 'VERIFIED',
    };
  }

  updateProfile(input: Record<string, unknown>) {
    return { ...this.profile(), ...input };
  }

  notificationPreferences() {
    return notificationPreferences;
  }

  updateNotificationPreference(input: { key?: PreferenceKey; value?: boolean }) {
    if (!input.key) return notificationPreferences;
    return { ...notificationPreferences, [input.key]: Boolean(input.value) };
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

  createSupportContact(input: { channel?: string; role?: string }) {
    return {
      message: `${input.channel ?? 'Support'} request received for ${input.role ?? 'user'} preview.`,
      conversationId: 'preview-support-thread',
    };
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

  auditLogs() {
    return [
      { id: 'audit-1', actor: 'System', action: 'Preview backend started', time: 'Today', icon: 'settings', tone: 'success', category: 'System' },
      { id: 'audit-2', actor: 'Admin', action: 'Reviewed demo workflow', time: 'Today', icon: 'verified', tone: 'info', category: 'Admin' },
    ];
  }

  auditLog(id: string) {
    const log = this.auditLogs().find((entry) => entry.id === id) ?? this.auditLogs()[0];
    return { ...log, role: 'ADMIN', target: 'Tracko preview', ip: '127.0.0.1', result: 'Completed' };
  }
}
