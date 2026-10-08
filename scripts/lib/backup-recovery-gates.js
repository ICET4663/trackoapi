function validateRecoveryEvidence(record, expectedSource, now = Date.now()) {
  const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
  requireValue(typeof expectedSource === 'string' && expectedSource.trim(), 'Set BACKUP_SOURCE_PROJECT_ID.');
  requireValue(record?.sourceProjectId === expectedSource, 'Recovery evidence is for another source project.');
  requireValue(typeof record.targetProjectId === 'string' && record.targetProjectId.trim() &&
    record.targetProjectId !== expectedSource && record.targetIsProduction === false,
  'Recovery target must be a separate non-production project.');
  requireValue(typeof record.testedBy === 'string' && record.testedBy.trim(), 'Record the restore tester.');
  const testedAt = Date.parse(record.testedAt);
  const backupAt = Date.parse(record.backupAt);
  requireValue(Number.isFinite(testedAt) && testedAt <= now && now - testedAt <= 30 * 86400000,
    'Recovery drill must be within the last 30 days.');
  requireValue(Number.isFinite(backupAt) && backupAt <= testedAt, 'Record a backup date before the restore drill.');
  for (const check of ['databaseRestore', 'storageRestore', 'applicationRead', 'outboundProvidersDisabled']) {
    requireValue(record.checks?.[check] === 'passed', `Recovery check ${check} has not passed.`);
  }
  requireValue(record.reconciliationDeltaKobo === 0, 'Restored escrow ledger must reconcile to zero.');
  requireValue(Array.isArray(record.blockers) && record.blockers.length === 0, 'Recovery blockers remain.');
}
module.exports = { validateRecoveryEvidence };
