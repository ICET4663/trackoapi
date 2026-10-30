// App Store and Play review accounts (scripts/create-review-accounts.js): apple.review.* and
// google.review.* emails. Their loads stay among themselves and they always pay in Paystack
// test mode, so a store reviewer never moves real money.
export const isStoreReviewerAccount = (email?: string | null) => /^(apple|google)\.review\./i.test(email ?? '');
