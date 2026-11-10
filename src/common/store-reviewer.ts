// Sandbox accounts: the App Store and Play review accounts (scripts/create-review-accounts.js,
// apple.review.* and google.review.*) and the Play closed-test accounts
// (scripts/create-tester-accounts.js, tester01.customer@trako.com.ng and so on). They always pay
// in Paystack test mode, so they never move real money, and their loads stay among sandbox
// drivers in both directions: a real customer's load never waits on a sandbox driver, and a
// real driver is never offered a load paid with test money.
const SANDBOX_EMAIL = /^((apple|google)\.review|tester\d{2,3})\.(customer|driver)@trako\.com\.ng$/i;

export const isStoreReviewerAccount = (email?: string | null) => SANDBOX_EMAIL.test(email ?? '');
