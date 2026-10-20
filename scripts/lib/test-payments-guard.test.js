const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertTestPayments } = require('./test-payments-guard');

test('runs against Paystack test mode', () => assert.equal(assertTestPayments({ payments: { environment: 'test' } }), 'test'));
test('runs against the local mock provider', () => assert.equal(assertTestPayments({ payments: { environment: 'mock' } }), 'mock'));
test('refuses live payments', () => assert.throws(() => assertTestPayments({ payments: { environment: 'live' } }), /"live" mode/));
test('refuses when the mode cannot be confirmed', () => {
  assert.throws(() => assertTestPayments(undefined), /"unknown" mode/);
  assert.throws(() => assertTestPayments({ payments: {} }), /"unknown" mode/);
});
