const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRecoveryEvidence } = require('./backup-recovery-gates');
const now = Date.UTC(2026, 9, 8);
function valid() { return { sourceProjectId: 'source', targetProjectId: 'restore-test', targetIsProduction: false,
  testedBy: 'QA', testedAt: '2026-10-07', backupAt: '2026-10-06', reconciliationDeltaKobo: 0,
  checks: { databaseRestore: 'passed', storageRestore: 'passed', applicationRead: 'passed', outboundProvidersDisabled: 'passed' }, blockers: [] }; }
test('accepts a complete recent isolated restore record', () => validateRecoveryEvidence(valid(), 'source', now));
test('rejects missing record', () => assert.throws(() => validateRecoveryEvidence(undefined, 'source', now)));
test('rejects same-project restore', () => { const r = valid(); r.targetProjectId = 'source'; assert.throws(() => validateRecoveryEvidence(r, 'source', now)); });
test('rejects a stale drill', () => { const r = valid(); r.testedAt = '2026-08-01'; assert.throws(() => validateRecoveryEvidence(r, 'source', now)); });
test('rejects missing storage recovery', () => { const r = valid(); r.checks.storageRestore = 'pending'; assert.throws(() => validateRecoveryEvidence(r, 'source', now)); });
test('rejects a ledger difference', () => { const r = valid(); r.reconciliationDeltaKobo = 1; assert.throws(() => validateRecoveryEvidence(r, 'source', now)); });
test('rejects unresolved blockers', () => { const r = valid(); r.blockers = ['missing photos']; assert.throws(() => validateRecoveryEvidence(r, 'source', now)); });
test('rejects an unisolated provider setup', () => { const r = valid(); r.checks.outboundProvidersDisabled = 'pending'; assert.throws(() => validateRecoveryEvidence(r, 'source', now)); });
