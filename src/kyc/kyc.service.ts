import { Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type KycAction = 'APPROVE' | 'REQUEST_CORRECTION' | 'REJECT';
type KycSubmissionRow = {
  id: string;
  userId: string;
  role: string;
  status: string;
  idType: string;
  idNumber: string;
  bvn?: string;
  licenceNumber?: string;
  licenceExpiry?: Date;
  note?: string;
  submittedAt: Date;
  updatedAt: Date;
  reviewedAt?: Date;
  reviewedBy?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  verificationStatus?: string;
};
type KycDocumentRow = { type: string; label: string; url: string; mediaId?: string };

const now = () => new Date().toISOString();

@Injectable()
export class KycService {
  constructor(private readonly prisma: PrismaService) {}

  async myKyc(userId = 'preview-customer') {
    try {
      const rows = await this.prisma.$queryRawUnsafe<KycSubmissionRow[]>(
        `select ks.*, p."fullName", u."email", u."phone", u."verificationStatus"::text as "verificationStatus"
         from "KycSubmission" ks
         join "User" u on u."id" = ks."userId"
         left join "Profile" p on p."userId" = u."id"
         where ks."userId" = $1
         order by ks."submittedAt" desc
         limit 1`,
        userId,
      );
      if (rows[0]) {
        return {
          verificationStatus: rows[0].verificationStatus ?? 'PENDING',
          submission: await this.toSubmission(rows[0]),
        };
      }
    } catch {
      // Preview fallback below.
    }

    return {
      verificationStatus: 'PENDING',
      submission: this.previewSubmission(),
    };
  }

  async submit(input: Record<string, unknown>, userId = 'preview-customer', role: UserRole = 'CUSTOMER') {
    try {
      const rows = await this.prisma.$queryRawUnsafe<KycSubmissionRow[]>(
        `insert into "KycSubmission" ("userId", "role", "status", "idType", "idNumber", "bvn", "licenceNumber", "licenceExpiry", "note")
         values (
           $1,
           cast($2 as "UserRole"),
           'PENDING'::"KycSubmissionStatus",
           $3,
           $4,
           $5,
           $6,
           case when $7::text is null or $7::text = '' then null else $7::timestamp end,
           'KYC submitted from app.'
         )
         returning *`,
        userId,
        String(input.role ?? role),
        String(input.idType ?? 'NIN'),
        String(input.idNumber ?? '00000000000'),
        input.bvn ? String(input.bvn) : null,
        input.licenceNumber ? String(input.licenceNumber) : null,
        input.licenceExpiry ? String(input.licenceExpiry) : null,
      );

      const submission = rows[0];
      if (submission && Array.isArray(input.documents)) {
        for (const document of input.documents as Record<string, unknown>[]) {
          await this.prisma.$executeRawUnsafe(
            `insert into "KycSubmissionDocument" ("submissionId", "type", "label", "url", "mediaId")
             values ($1, $2, $3, $4, $5)`,
            submission.id,
            String(document.type ?? 'ID_FRONT'),
            String(document.label ?? 'KYC document'),
            String(document.url ?? document.mediaId ?? 'preview://document'),
            document.mediaId ? String(document.mediaId) : null,
          );
        }
        return this.toSubmission(submission);
      }
    } catch {
      // Preview fallback below.
    }

    return this.previewSubmission({
      idType: String(input.idType ?? 'NIN'),
      idNumber: String(input.idNumber ?? '00000000000'),
      bvn: input.bvn ? String(input.bvn) : undefined,
      licenceNumber: input.licenceNumber ? String(input.licenceNumber) : undefined,
      licenceExpiry: input.licenceExpiry ? String(input.licenceExpiry) : undefined,
      documents: Array.isArray(input.documents) ? input.documents : [],
      status: 'PENDING',
      note: 'Preview KYC submission received.',
    });
  }

  async queue() {
    try {
      const rows = await this.prisma.$queryRawUnsafe<KycSubmissionRow[]>(
        `select ks.*, p."fullName", u."email"
         from "KycSubmission" ks
         join "User" u on u."id" = ks."userId"
         left join "Profile" p on p."userId" = u."id"
         order by ks."submittedAt" desc
         limit 100`,
      );
      if (rows.length) {
        return rows.map((row) => ({
          userId: row.userId,
          fullName: row.fullName ?? 'Tracko user',
          email: row.email,
          role: row.role,
          status: row.status,
          idType: row.idType,
          documentCount: 0,
          submittedAt: row.submittedAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }));
      }
    } catch {
      // Preview fallback below.
    }

    const submission = this.previewSubmission();
    return [
      {
        userId: submission.userId,
        fullName: 'Tracko Preview User',
        email: 'customer@tracko.ng',
        role: submission.role,
        status: submission.status,
        idType: submission.idType,
        documentCount: submission.documents.length,
        submittedAt: submission.submittedAt,
        updatedAt: submission.updatedAt,
      },
    ];
  }

  async review(userId: string) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<KycSubmissionRow[]>(
        `select ks.*, p."fullName", u."email", u."phone", u."verificationStatus"::text as "verificationStatus"
         from "KycSubmission" ks
         join "User" u on u."id" = ks."userId"
         left join "Profile" p on p."userId" = u."id"
         where ks."userId" = $1
         order by ks."submittedAt" desc
         limit 1`,
        userId,
      );
      if (rows[0]) {
        return {
          submission: await this.toSubmission(rows[0]),
          user: {
            id: rows[0].userId,
            fullName: rows[0].fullName ?? 'Tracko user',
            email: rows[0].email,
            phone: rows[0].phone,
            role: rows[0].role,
            verificationStatus: rows[0].verificationStatus ?? 'PENDING',
          },
        };
      }
    } catch {
      // Preview fallback below.
    }

    return {
      submission: this.previewSubmission({ userId }),
      user: {
        id: userId,
        fullName: 'Tracko Preview User',
        email: 'customer@tracko.ng',
        phone: '+234 800 000 0000',
        role: 'CUSTOMER',
        verificationStatus: 'PENDING',
      },
    };
  }

  async decide(userId: string, body: { action?: KycAction; note?: string }) {
    const status =
      body.action === 'APPROVE' ? 'APPROVED' : body.action === 'REJECT' ? 'REJECTED' : 'CORRECTION_REQUIRED';

    try {
      const rows = await this.prisma.$queryRawUnsafe<KycSubmissionRow[]>(
        `update "KycSubmission"
         set "status" = cast($1 as "KycSubmissionStatus"),
             "note" = $2,
             "reviewedAt" = current_timestamp,
             "reviewedBy" = 'preview-admin',
             "updatedAt" = current_timestamp
         where "userId" = $3
         returning *`,
        status,
        body.note ?? 'Decision recorded.',
        userId,
      );
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          verificationStatus:
            body.action === 'APPROVE'
              ? 'VERIFIED'
              : body.action === 'REJECT'
                ? 'REJECTED'
                : 'ACTION_NEEDED',
        },
      });
      if (rows[0]) return this.toSubmission(rows[0]);
    } catch {
      // Preview fallback below.
    }

    return this.previewSubmission({
      userId,
      status,
      note: body.note ?? 'Preview decision recorded.',
      reviewedAt: now(),
      reviewedBy: 'preview-admin',
    });
  }

  private async toSubmission(row: KycSubmissionRow) {
    let documents: KycDocumentRow[] = [];
    try {
      documents = await this.prisma.$queryRawUnsafe<KycDocumentRow[]>(
        'select "type", "label", "url", "mediaId" from "KycSubmissionDocument" where "submissionId" = $1 order by "createdAt" asc',
        row.id,
      );
    } catch {
      documents = [];
    }

    return {
      id: row.id,
      userId: row.userId,
      role: row.role,
      status: row.status,
      idType: row.idType,
      idNumber: row.idNumber,
      bvn: row.bvn,
      licenceNumber: row.licenceNumber,
      licenceExpiry: row.licenceExpiry?.toISOString?.(),
      documents,
      note: row.note,
      submittedAt: row.submittedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      reviewedAt: row.reviewedAt?.toISOString?.(),
      reviewedBy: row.reviewedBy,
      history: [
        {
          action: 'SUBMITTED',
          note: row.note,
          actor: row.fullName ?? 'Tracko user',
          at: row.submittedAt.toISOString(),
        },
      ],
    };
  }

  private previewSubmission(overrides: Record<string, unknown> = {}) {
    const timestamp = now();
    const documents = (overrides.documents as unknown[]) ?? [
      { type: 'ID_FRONT', label: 'Government ID', url: 'preview://id-front' },
      { type: 'SELFIE', label: 'Selfie', url: 'preview://selfie' },
    ];

    return {
      id: String(overrides.id ?? 'kyc-preview'),
      userId: String(overrides.userId ?? 'preview-customer'),
      role: String(overrides.role ?? 'CUSTOMER'),
      status: String(overrides.status ?? 'PENDING'),
      idType: String(overrides.idType ?? 'NIN'),
      idNumber: String(overrides.idNumber ?? '00000000000'),
      bvn: overrides.bvn ? String(overrides.bvn) : undefined,
      licenceNumber: overrides.licenceNumber ? String(overrides.licenceNumber) : undefined,
      licenceExpiry: overrides.licenceExpiry ? String(overrides.licenceExpiry) : undefined,
      documents,
      note: overrides.note ? String(overrides.note) : 'Preview KYC is awaiting review.',
      submittedAt: String(overrides.submittedAt ?? timestamp),
      updatedAt: String(overrides.updatedAt ?? timestamp),
      reviewedAt: overrides.reviewedAt ? String(overrides.reviewedAt) : undefined,
      reviewedBy: overrides.reviewedBy ? String(overrides.reviewedBy) : undefined,
      history: [
        {
          action: 'SUBMITTED',
          note: 'Preview KYC submission created.',
          actor: 'Tracko Preview User',
          at: timestamp,
        },
      ],
    };
  }
}
