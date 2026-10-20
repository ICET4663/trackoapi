// The journey and exception checks release or refund the escrow of the shipment they are
// given. Against live Paystack that would move real money, so they refuse to run unless the
// API reports test (or local mock) payments. acceptance-live.js has the same rule.
function assertTestPayments(integrationStatus) {
  const payments = integrationStatus?.payments ?? integrationStatus?.payment;
  const environment = payments?.environment;
  if (environment !== 'test' && environment !== 'mock') {
    throw new Error(`Payments are in "${environment ?? 'unknown'}" mode. This check releases or refunds escrow, so it only runs against Paystack test mode.`);
  }
  return environment;
}
module.exports = { assertTestPayments };
