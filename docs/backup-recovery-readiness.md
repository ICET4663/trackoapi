# Backup recovery readiness

An enabled backup schedule is not evidence of a successful restore. No production restore is performed by the preflight script.

1. Identify the production source project and confirm backup retention and access with its administrator.
2. Restore the database into a separate non-production project. Do not overwrite production. Disable Paystack transfers, KYC submissions, email, push delivery, scheduled jobs and public access in the recovery environment before starting it.
3. Restore uploaded-media objects separately and verify authorised access to representative pickup photos, delivery proofs and audio files. Database rows alone do not demonstrate recovery of storage objects.
4. Check accounts, shipment status/history, assignments, escrow and payout records in the restored environment. Confirm the finance reconciliation delta is zero. Never use a test transfer to disguise a ledger difference.
5. Record tester, backup timestamp, drill timestamp, source and target project identifiers, completed checks and unresolved blockers. Keep evidence private; do not include passwords, connection strings, keys or user data.
6. Set BACKUP_SOURCE_PROJECT_ID and BACKUP_RECOVERY_EVIDENCE_FILE, then run strict production preflight. Missing or incomplete evidence fails strict preflight. A JSON record is a human attestation, not automated proof that a restore occurred.

Record fields: sourceProjectId, targetProjectId, targetIsProduction (false), testedBy, testedAt, backupAt, reconciliationDeltaKobo (0), blockers ([] after resolution), and checks with databaseRestore, storageRestore, applicationRead and outboundProvidersDisabled set to passed only after verified.

Repeat the drill within 30 days of launch and after material storage/schema changes. Platform administrators must approve actual restore operations. Recovery-time and data-loss targets require business agreement; this gate does not certify those targets.
