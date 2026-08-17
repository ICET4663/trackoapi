import { randomUUID } from 'crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type KycAction = 'APPROVE' | 'REQUEST_CORRECTION' | 'REJECT';
type KycSubmissionStatus = 'PENDING' | 'CORRECTION_REQUIRED' | 'APPROVED' | 'REJECTED';

type KycSubmitInput = {
  role?: unknown;
  idType?: unknown;
  idNumber?: unknown;
  bvn?: unknown;
  licenceNumber?: unknown;
  licenceExpiry?: unknown;
  note?: unknown;
  documents?: unknown;
};

type KycRow = {
  id: string;
  userId: string;
  role: UserRole;
  status: KycSubmissionStatus;
  idType: string;
  idNumber: string;
  bvn: string | null;
  licenceNumber: string | null;
  licenceExpiry: Date | string | null;
  note: string | null;
  reviewedAt: Date | string | null;
  reviewedBy: string | null;
  submittedAt: Date | string;
  updatedAt: Date | string;
  email?: string;
  phone?: string;
  fullName?: string | null;
  verificationStatus?: VerificationStatus;
  documentCount?: number | bigint;
};

type KycDocumentRow = {
  id: string;
  type: string;
  label: string;
  url: string;
  mediaId: string | null;
};

type KycDocumentInput = {
  type?: unknown;
  label?: unknown;
  url?: unknown;
  mediaId?: unknown;
};

@Injectable()
export class KycService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async myKyc(userId: string) {
    try {
      const [submission] = await this.submissionsForUser(userId);
      if (submission) {
        return {
          verificationStatus: submission.verificationStatus ?? 'PENDING',
          submission: await this.toSubmission(submission),
        };
      }

      const [user] = await this.prisma.$queryRawUnsafe<Array<{ verificationStatus: VerificationStatus }>>(
        'select "verificationStatus" from "User" where "id" = $1 limit 1',
        userId,
      );

      return {
        verificationStatus: user?.verificationStatus ?? 'PENDING',
        submission: null,
      };
    } catch (error) {
      if (!this.previewEnabled()) throw error;
      return { verificationStatus: 'IN_REVIEW', submission: this.previewSubmission(userId, 'CUSTOMER') };
    }
  }

  async submit(input: KycSubmitInput, userId: string, userRole: UserRole) {
    try {
      const role = this.allowedSubmissionRole(input.role, userRole);
      const idType = this.requiredText(input.idType, 'ID type is required.');
      const idNumber = this.requiredText(input.idNumber, 'ID number is required.');
      const submissionId = this.id('kyc');
      const documents = this.documentInputs(input.documents);

      await this.prisma.$executeRawUnsafe(
        `insert into "KycSubmission" (
          "id", "userId", "role", "status", "idType", "idNumber", "bvn",
          "licenceNumber", "licenceExpiry", "note", "submittedAt", "updatedAt"
        ) values (
          $1, $2, $3::"UserRole", 'PENDING'::"KycSubmissionStatus", $4, $5, $6,
          $7, $8, $9, current_timestamp, current_timestamp
        )`,
        submissionId,
        userId,
        role,
        idType,
        idNumber,
        this.optionalText(input.bvn),
        this.optionalText(input.licenceNumber),
        this.optionalDate(input.licenceExpiry),
        this.optionalText(input.note),
      );

      for (const document of documents) {
        await this.prisma.$executeRawUnsafe(
          `insert into "KycSubmissionDocument" ("id", "submissionId", "type", "label", "url", "mediaId", "createdAt")
           values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
          this.id('doc'),
          submissionId,
          document.type,
          document.label,
          document.url,
          document.mediaId,
        );
      }

      await this.prisma.$executeRawUnsafe(
        `update "User" set "verificationStatus" = 'IN_REVIEW'::"VerificationStatus", "updatedAt" = current_timestamp where "id" = $1`,
        userId,
      );

      const [submission] = await this.submissionsForUser(userId);
      return submission ? this.toSubmission(submission) : this.previewSubmission(userId, role);
    } catch (error) {
      if (!this.previewEnabled()) throw error;
      return this.previewSubmission(userId, this.previewRole(input.role));
    }
  }

  async attachDocument(input: KycDocumentInput, userId: string, userRole: UserRole) {
    try {
      if (!['CUSTOMER', 'DRIVER', 'TRUCK_OWNER'].includes(userRole)) {
        throw new BadRequestException('KYC documents are only available for customer, driver, and truck owner accounts.');
      }

      const url = this.requiredText(input.url, 'Document URL is required.');
      const type = this.optionalText(input.type) ?? 'DOCUMENT';
      const label = this.optionalText(input.label) ?? 'KYC document';
      const mediaId = this.optionalText(input.mediaId);

      const [latest] = await this.submissionsForUser(userId);
      const submissionId = latest?.id ?? this.id('kyc');

      if (!latest) {
        await this.prisma.$executeRawUnsafe(
          `insert into "KycSubmission" (
            "id", "userId", "role", "status", "idType", "idNumber", "note", "submittedAt", "updatedAt"
          ) values (
            $1, $2, $3::"UserRole", 'PENDING'::"KycSubmissionStatus", 'DOCUMENT_UPLOAD', 'PENDING', 'Document upload started.',
            current_timestamp, current_timestamp
          )`,
          submissionId,
          userId,
          userRole,
        );
      }

      const documentId = this.id('doc');
      await this.prisma.$executeRawUnsafe(
        `insert into "KycSubmissionDocument" ("id", "submissionId", "type", "label", "url", "mediaId", "createdAt")
         values ($1, $2, $3, $4, $5, $6, current_timestamp)`,
        documentId,
        submissionId,
        type,
        label,
        url,
        mediaId,
      );

      await this.prisma.$executeRawUnsafe(
        `update "KycSubmission"
         set "status" = 'PENDING'::"KycSubmissionStatus", "updatedAt" = current_timestamp
         where "id" = $1`,
        submissionId,
      );

      await this.prisma.$executeRawUnsafe(
        `update "User"
         set "verificationStatus" = 'IN_REVIEW'::"VerificationStatus", "updatedAt" = current_timestamp
         where "id" = $1`,
        userId,
      );

      await this.prisma.auditLog.create({
        data: {
          actorId: userId,
          action: 'KYC_DOCUMENT_ATTACHED',
          entity: 'KycSubmission',
          entityId: submissionId,
          metadata: { documentId, type, label, mediaId },
        },
      }).catch(() => null);

      const [submission] = await this.submissionsForUser(userId);
      return {
        uploaded: true,
        document: { id: documentId, type, label, url, mediaId },
        submission: submission ? await this.toSubmission(submission) : this.previewSubmission(userId, userRole),
      };
    } catch (error) {
      if (!this.previewEnabled()) throw error;
      return {
        uploaded: true,
        document: {
          id: this.id('doc'),
          type: this.optionalText(input.type) ?? 'DOCUMENT',
          label: this.optionalText(input.label) ?? 'KYC document',
          url: this.optionalText(input.url) ?? 'preview://kyc/document',
          mediaId: this.optionalText(input.mediaId),
        },
        submission: this.previewSubmission(userId, userRole),
      };
    }
  }

  async queue() {
    try {
      const submissions = await this.prisma.$queryRawUnsafe<KycRow[]>(
        `select
          ks."id", ks."userId", ks."role", ks."status", ks."idType", ks."idNumber", ks."bvn",
          ks."licenceNumber", ks."licenceExpiry", ks."note", ks."reviewedAt", ks."reviewedBy",
          ks."submittedAt", ks."updatedAt", u."email", u."phone", u."verificationStatus",
          p."fullName", count(ksd."id") as "documentCount"
        from "KycSubmission" ks
        join "User" u on u."id" = ks."userId"
        left join "Profile" p on p."userId" = u."id"
        left join "KycSubmissionDocument" ksd on ksd."submissionId" = ks."id"
        group by ks."id", u."email", u."phone", u."verificationStatus", p."fullName"
        order by ks."submittedAt" desc
        limit 100`,
      );

      const submissionEntries = await Promise.all(
        submissions.map(async (submission) => ({
          ...(await this.toSubmission(submission)),
          documentCount: Number(submission.documentCount ?? 0),
        })),
      );

      const usersWithSubmissions = new Set(submissionEntries.map((submission) => submission.userId));
      const pendingUsers = await this.prisma.$queryRawUnsafe<KycRow[]>(
        `select
          u."id" as "id", u."id" as "userId", u."role",
          'PENDING'::"KycSubmissionStatus" as "status",
          'PROFILE_REVIEW' as "idType", 'PROFILE_ONLY' as "idNumber",
          null as "bvn", null as "licenceNumber", null as "licenceExpiry",
          'Profile requires admin review.' as "note",
          null as "reviewedAt", null as "reviewedBy",
          u."createdAt" as "submittedAt", u."updatedAt" as "updatedAt",
          u."email", u."phone", u."verificationStatus", p."fullName",
          0 as "documentCount"
        from "User" u
        left join "Profile" p on p."userId" = u."id"
        where u."verificationStatus" in ('PENDING'::"VerificationStatus", 'IN_REVIEW'::"VerificationStatus", 'ACTION_NEEDED'::"VerificationStatus")
          and u."role" in ('CUSTOMER'::"UserRole", 'DRIVER'::"UserRole", 'TRUCK_OWNER'::"UserRole")
        order by u."updatedAt" desc
        limit 100`,
      );

      const profileEntries = pendingUsers
        .filter((user) => !usersWithSubmissions.has(user.userId))
        .map((user) => ({
          ...this.profileReviewSubmission(user),
          documentCount: 0,
        }));

      return [...submissionEntries, ...profileEntries];
    } catch (error) {
      if (!this.previewEnabled()) throw error;
      return [this.previewSubmission('preview-customer', 'CUSTOMER')];
    }
  }

  async review(userId: string) {
    try {
      const [submission] = await this.submissionsForUser(userId);
      if (!submission) {
        const profileReview = await this.profileReviewForUser(userId);
        if (profileReview) return profileReview;
        throw new BadRequestException('No KYC submission found for this user.');
      }

      return {
        submission: await this.toSubmission(submission),
        user: {
          id: submission.userId,
          email: submission.email,
          phone: submission.phone,
          role: submission.role,
          fullName: submission.fullName ?? submission.email ?? 'Tracko user',
          verificationStatus: submission.verificationStatus ?? 'PENDING',
        },
      };
    } catch (error) {
      if (!this.previewEnabled()) throw error;
      return {
        submission: this.previewSubmission(userId, 'CUSTOMER'),
        user: {
          id: userId,
          email: 'customer@tracko.ng',
          phone: '+2348012345678',
          role: 'CUSTOMER',
          fullName: 'Preview Customer',
          verificationStatus: 'IN_REVIEW',
        },
      };
    }
  }

  async decide(userId: string, body: { action?: KycAction; note?: string }, reviewerId = 'system') {
    try {
      const action = body.action;
      if (!action || !['APPROVE', 'REQUEST_CORRECTION', 'REJECT'].includes(action)) {
        throw new BadRequestException('A valid KYC decision is required.');
      }

      const [latest] = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
        'select "id" from "KycSubmission" where "userId" = $1 order by "submittedAt" desc limit 1',
        userId,
      );

      const status = this.statusForAction(action);
      const verificationStatus = this.verificationForAction(action);

      if (!latest) {
        await this.prisma.$executeRawUnsafe(
          `update "User" set "verificationStatus" = $1::"VerificationStatus", "updatedAt" = current_timestamp where "id" = $2`,
          verificationStatus,
          userId,
        );
        const profileReview = await this.profileReviewForUser(userId, status, verificationStatus, this.optionalText(body.note), reviewerId);
        if (profileReview) return profileReview.submission;
        throw new BadRequestException('No KYC submission found for this user.');
      }

      await this.prisma.$executeRawUnsafe(
        `update "KycSubmission"
         set "status" = $1::"KycSubmissionStatus", "note" = $2, "reviewedAt" = current_timestamp,
             "reviewedBy" = $3, "updatedAt" = current_timestamp
         where "id" = $4`,
        status,
        this.optionalText(body.note),
        reviewerId,
        latest.id,
      );

      await this.prisma.$executeRawUnsafe(
        `update "User" set "verificationStatus" = $1::"VerificationStatus", "updatedAt" = current_timestamp where "id" = $2`,
        verificationStatus,
        userId,
      );

      const [submission] = await this.submissionsForUser(userId);
      if (!submission) {
        throw new BadRequestException('No KYC submission found for this user.');
      }
      return this.toSubmission(submission);
    } catch (error) {
      if (!this.previewEnabled()) throw error;
      return {
        ...this.previewSubmission(userId, 'CUSTOMER'),
        status: this.statusForAction(body.action ?? 'REQUEST_CORRECTION'),
        note: body.note ?? null,
      };
    }
  }

  private submissionsForUser(userId: string) {
    return this.prisma.$queryRawUnsafe<KycRow[]>(
      `select
        ks."id", ks."userId", ks."role", ks."status", ks."idType", ks."idNumber", ks."bvn",
        ks."licenceNumber", ks."licenceExpiry", ks."note", ks."reviewedAt", ks."reviewedBy",
        ks."submittedAt", ks."updatedAt", u."email", u."phone", u."verificationStatus", p."fullName"
      from "KycSubmission" ks
      join "User" u on u."id" = ks."userId"
      left join "Profile" p on p."userId" = u."id"
      where ks."userId" = $1
      order by ks."submittedAt" desc
      limit 1`,
      userId,
    );
  }

  private async documentsForSubmission(submissionId: string) {
    return this.prisma.$queryRawUnsafe<KycDocumentRow[]>(
      `select "id", "type", "label", "url", "mediaId"
       from "KycSubmissionDocument"
       where "submissionId" = $1
       order by "createdAt" asc`,
      submissionId,
    );
  }

  private async toSubmission(submission: KycRow) {
    const documents = await this.documentsForSubmission(submission.id);
    return {
      id: submission.id,
      userId: submission.userId,
      role: submission.role,
      status: submission.status,
      idType: submission.idType,
      idNumber: submission.idNumber,
      bvn: submission.bvn,
      licenceNumber: submission.licenceNumber,
      licenceExpiry: this.isoDate(submission.licenceExpiry),
      note: submission.note,
      submittedAt: this.isoDate(submission.submittedAt),
      updatedAt: this.isoDate(submission.updatedAt),
      reviewedAt: this.isoDate(submission.reviewedAt),
      reviewedBy: submission.reviewedBy,
      fullName: submission.fullName ?? submission.email ?? 'Tracko user',
      email: submission.email,
      phone: submission.phone,
      verificationStatus: submission.verificationStatus ?? 'PENDING',
      documents,
      history: this.historyForSubmission(submission),
    };
  }

  private async profileReviewForUser(
    userId: string,
    status?: KycSubmissionStatus,
    verificationStatus?: VerificationStatus,
    note?: string | null,
    reviewerId?: string,
  ) {
    const [user] = await this.prisma.$queryRawUnsafe<KycRow[]>(
      `select
        u."id" as "id", u."id" as "userId", u."role",
        'PENDING'::"KycSubmissionStatus" as "status",
        'PROFILE_REVIEW' as "idType", 'PROFILE_ONLY' as "idNumber",
        null as "bvn", null as "licenceNumber", null as "licenceExpiry",
        'Profile requires admin review.' as "note",
        null as "reviewedAt", null as "reviewedBy",
        u."createdAt" as "submittedAt", u."updatedAt" as "updatedAt",
        u."email", u."phone", u."verificationStatus", p."fullName",
        0 as "documentCount"
      from "User" u
      left join "Profile" p on p."userId" = u."id"
      where u."id" = $1
      limit 1`,
      userId,
    );

    if (!user) return null;
    const submission = this.profileReviewSubmission(user, status, verificationStatus, note, reviewerId);
    return {
      submission,
      user: {
        id: user.userId,
        email: user.email,
        phone: user.phone,
        role: user.role,
        fullName: user.fullName ?? user.email ?? 'Tracko user',
        verificationStatus: submission.verificationStatus,
      },
    };
  }

  private profileReviewSubmission(
    user: KycRow,
    status?: KycSubmissionStatus,
    verificationStatus?: VerificationStatus,
    note?: string | null,
    reviewerId?: string,
  ) {
    const resolvedStatus = status ?? user.status ?? 'PENDING';
    const resolvedVerificationStatus = verificationStatus ?? user.verificationStatus ?? 'PENDING';
    const submittedAt = this.isoDate(user.submittedAt) ?? new Date().toISOString();
    const updatedAt = this.isoDate(user.updatedAt) ?? submittedAt;
    const reviewedAt = resolvedStatus === 'PENDING' ? null : new Date().toISOString();
    const resolvedNote = note ?? user.note ?? 'Profile-only account review. No document upload is attached yet.';
    const history = [
      {
        action: 'PROFILE_READY',
        actor: user.email ?? 'Applicant',
        at: submittedAt,
      },
    ];

    if (reviewedAt) {
      history.push({
        action: resolvedStatus,
        actor: reviewerId ?? 'Tracko reviewer',
        at: reviewedAt,
      });
    }

    return {
      id: `profile-${user.userId}`,
      userId: user.userId,
      role: user.role,
      status: resolvedStatus,
      idType: user.idType,
      idNumber: user.idNumber,
      bvn: null,
      licenceNumber: null,
      licenceExpiry: null,
      note: resolvedNote,
      submittedAt,
      updatedAt,
      reviewedAt,
      reviewedBy: reviewedAt ? reviewerId ?? 'Tracko reviewer' : null,
      fullName: user.fullName ?? user.email ?? 'Tracko user',
      email: user.email,
      phone: user.phone,
      verificationStatus: resolvedVerificationStatus,
      documents: [],
      history,
    };
  }

  private documentInputs(documents: unknown) {
    if (!Array.isArray(documents)) return [];
    return documents
      .map((document) => {
        const item = document as Record<string, unknown>;
        return {
          type: this.optionalText(item.type) ?? 'DOCUMENT',
          label: this.optionalText(item.label) ?? 'KYC document',
          url: this.optionalText(item.url),
          mediaId: this.optionalText(item.mediaId),
        };
      })
      .filter((document) => document.url)
      .map((document) => ({
        type: document.type,
        label: document.label,
        url: document.url as string,
        mediaId: document.mediaId,
      }));
  }

  private allowedSubmissionRole(role: unknown, userRole: UserRole) {
    const requestedRole = this.previewRole(role);
    const allowedRoles: UserRole[] = ['CUSTOMER', 'DRIVER', 'TRUCK_OWNER'];
    if (!allowedRoles.includes(requestedRole)) {
      throw new BadRequestException('KYC is only available for customer, driver, and truck owner accounts.');
    }
    if (requestedRole !== userRole) {
      throw new BadRequestException('KYC role must match the signed-in account role.');
    }
    return requestedRole;
  }

  private statusForAction(action: KycAction): KycSubmissionStatus {
    if (action === 'APPROVE') return 'APPROVED';
    if (action === 'REJECT') return 'REJECTED';
    return 'CORRECTION_REQUIRED';
  }

  private verificationForAction(action: KycAction): VerificationStatus {
    if (action === 'APPROVE') return 'VERIFIED';
    if (action === 'REJECT') return 'REJECTED';
    return 'ACTION_NEEDED';
  }

  private requiredText(value: unknown, message: string) {
    const text = this.optionalText(value);
    if (!text) throw new BadRequestException(message);
    return text;
  }

  private optionalText(value: unknown) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text.length ? text : null;
  }

  private optionalDate(value: unknown) {
    const text = this.optionalText(value);
    if (!text) return null;
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  private isoDate(value: Date | string | null) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  private historyForSubmission(submission: KycRow) {
    const history = [
      {
        action: 'SUBMITTED',
        actor: submission.email ?? 'Applicant',
        at: this.isoDate(submission.submittedAt) ?? new Date().toISOString(),
      },
    ];

    if (submission.reviewedAt) {
      history.push({
        action: submission.status,
        actor: submission.reviewedBy ?? 'Tracko reviewer',
        at: this.isoDate(submission.reviewedAt) ?? new Date().toISOString(),
      });
    }

    return history;
  }

  private previewRole(role: unknown): UserRole {
    if (role === 'DRIVER') return 'DRIVER';
    if (role === 'TRUCK_OWNER') return 'TRUCK_OWNER';
    return 'CUSTOMER';
  }

  private id(prefix: string) {
    return `${prefix}_${randomUUID().replace(/-/g, '')}`;
  }

  private previewEnabled() {
    return this.config.get<string>('ENABLE_PREVIEW_AUTH') === 'true' || this.config.get<string>('NODE_ENV') !== 'production';
  }

  private previewSubmission(userId: string, role: UserRole) {
    const now = new Date().toISOString();
    return {
      id: `kyc-${userId}`,
      userId,
      role,
      status: 'PENDING' as KycSubmissionStatus,
      idType: role === 'DRIVER' ? 'DRIVERS_LICENSE' : 'NIN',
      idNumber: role === 'DRIVER' ? 'DRV-000000' : '12345678901',
      bvn: role === 'CUSTOMER' ? '12345678901' : null,
      licenceNumber: role === 'DRIVER' ? 'DRV-000000' : null,
      licenceExpiry: null,
      note: null,
      submittedAt: now,
      updatedAt: now,
      reviewedAt: null,
      reviewedBy: null,
      fullName: 'Preview Customer',
      email: 'customer@tracko.ng',
      phone: '+2348012345678',
      verificationStatus: 'IN_REVIEW' as VerificationStatus,
      documents: [
        {
          id: 'preview-document',
          type: 'ID_FRONT',
          label: 'Government ID',
          url: 'preview://kyc/id-front',
          mediaId: null,
        },
      ],
      history: [
        {
          action: 'SUBMITTED',
          actor: 'Preview Customer',
          at: now,
        },
      ],
    };
  }
}
