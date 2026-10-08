function validatePaymentReadiness(payments, publicReadiness, strictProduction) {
  const configured = payments?.mode === 'configured' || publicReadiness?.paystackReady === true;
  if (!configured) throw new Error('Payment provider is not configured.');
  if (strictProduction) {
    if (!payments || payments.provider !== 'paystack' || payments.mode !== 'configured') {
      throw new Error('Strict production requires authenticated Paystack provider details.');
    }
    if (payments.environment !== 'live' || payments.realChargeEnabled !== true) {
      throw new Error('Strict production requires live Paystack credentials and enabled charges; test mode is only for demos.');
    }
  }
}
module.exports = { validatePaymentReadiness };
