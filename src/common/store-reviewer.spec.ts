import { isStoreReviewerAccount } from './store-reviewer';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { testerAccounts, parseArgs, generatePassword } = require('../../scripts/create-tester-accounts');

describe('isStoreReviewerAccount (sandbox accounts)', () => {
  it('matches the store review and closed-test logins', () => {
    for (const email of [
      'apple.review.customer@trako.com.ng',
      'google.review.driver@trako.com.ng',
      'tester01.customer@trako.com.ng',
      'TESTER12.Driver@trako.com.ng',
      'tester100.driver@trako.com.ng',
    ]) {
      expect(isStoreReviewerAccount(email)).toBe(true);
    }
  });

  it('does not match real or look-alike addresses', () => {
    for (const email of [
      'customer@tracko.ng',
      'driver@tracko.ng',
      'tester01.customer@gmail.com',
      'apple.review.customer@trako.com.ng.evil.com',
      'my.apple.review.customer@trako.com.ng',
      'tester1.customer@trako.com.ng',
      'tester01.owner@trako.com.ng',
      'tester@trako.com.ng',
      '',
      null,
      undefined,
    ]) {
      expect(isStoreReviewerAccount(email)).toBe(false);
    }
  });

  it('covers every account the tester script creates', () => {
    for (let number = 1; number <= 99; number += 1) {
      const tester = testerAccounts(number);
      expect(isStoreReviewerAccount(tester.customer.email)).toBe(true);
      expect(isStoreReviewerAccount(tester.driver.email)).toBe(true);
      expect(tester.customer.phone).toMatch(/^\+234\d{10}$/);
      expect(tester.driver.phone).toMatch(/^\+234\d{10}$/);
      expect(tester.customer.phone).not.toBe(tester.driver.phone);
    }
  });
});

describe('create-tester-accounts options', () => {
  it('refuses to write the login sheet inside the repo', () => {
    expect(() => parseArgs(['--out', 'tester-logins.csv'])).toThrow('outside this repo');
  });

  it('needs an output path unless it is a dry run', () => {
    expect(() => parseArgs([])).toThrow('--out');
    expect(parseArgs(['--dry-run']).count).toBe(12);
  });

  it('stays within the tester number range', () => {
    expect(() => parseArgs(['--dry-run', '--start', '95', '--count', '10'])).toThrow('up to 99');
  });

  it('makes 12-character passwords without look-alike characters', () => {
    const password = generatePassword();
    expect(password).toHaveLength(12);
    expect(password).not.toMatch(/[01lIoO]/);
  });
});
