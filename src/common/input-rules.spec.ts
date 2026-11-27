import { BadRequestException, InternalServerErrorException, Logger } from '@nestjs/common';
import { internalError, isUniqueClash, koboAmount, mediaLink, oneOf, optionalText, requiredText } from './input-rules';

describe('input rules', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterAll(() => jest.restoreAllMocks());

  describe('internalError', () => {
    it('keeps the database text out of the message the user sees', () => {
      const error = internalError('Could not save this address.', new Error('relation "SavedAddress" does not exist'));
      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect(error.message).toBe('Could not save this address. Please try again.');
      expect(error.message).not.toContain('relation');
    });

    it('adds a full stop and does not repeat "try again"', () => {
      expect(internalError('Could not load audit logs', 'x').message).toBe('Could not load audit logs. Please try again.');
      expect(internalError('Could not save. Please try again.', 'x').message).toBe('Could not save. Please try again.');
    });
  });

  describe('optionalText / requiredText', () => {
    const rule = { label: 'Note', max: 10 };
    it('returns trimmed text, or null when missing or blank', () => {
      expect(optionalText('  hello ', rule)).toBe('hello');
      expect(optionalText(42, rule)).toBe('42');
      expect(optionalText(undefined, rule)).toBeNull();
      expect(optionalText(null, rule)).toBeNull();
      expect(optionalText('   ', rule)).toBeNull();
    });
    it('refuses objects and over-long text instead of cutting it', () => {
      expect(() => optionalText({ a: 1 }, rule)).toThrow('Note must be text.');
      expect(() => optionalText('12345678901', rule)).toThrow('Note must be 10 characters or fewer.');
    });
    it('applies a minimum and requires a value', () => {
      expect(() => requiredText('a', { label: 'Full name', min: 2, max: 120 })).toThrow('Full name must be at least 2 characters.');
      expect(() => requiredText('  ', { label: 'Address', max: 300 })).toThrow('Address is required.');
      expect(requiredText('Ada', { label: 'Full name', min: 2, max: 120 })).toBe('Ada');
    });
  });

  describe('koboAmount', () => {
    it('rounds to whole kobo', () => {
      expect(koboAmount(150.6, 'amount')).toBe(151);
      expect(koboAmount('2000', 'amount')).toBe(2000);
    });
    it('refuses zero, negatives, text and empty values', () => {
      for (const value of [0, -5, 'abc', '', null, undefined, 0.4, Number.NaN, Infinity]) {
        expect(() => koboAmount(value, 'withdrawal amount')).toThrow('Enter a valid withdrawal amount.');
      }
    });
    it('refuses amounts the Int column cannot hold', () => {
      expect(koboAmount(2_147_483_647, 'amount')).toBe(2_147_483_647);
      expect(() => koboAmount(2_147_483_648, 'proposed amount')).toThrow('That proposed amount is too large.');
    });
  });

  describe('mediaLink', () => {
    it('accepts https, http and image or PDF data URLs', () => {
      expect(mediaLink('https://x.supabase.co/storage/v1/object/public/media/a.jpg', 'Photo')).toContain('https://');
      expect(mediaLink('http://localhost:4000/a.png', 'Photo')).toContain('http://');
      expect(mediaLink('data:image/jpeg;base64,/9j/4AAQ', 'Photo')).toBe('data:image/jpeg;base64,/9j/4AAQ');
      expect(mediaLink('data:application/pdf;base64,JVBERi0=', 'Photo')).toBe('data:application/pdf;base64,JVBERi0=');
    });
    it('treats missing as null', () => {
      expect(mediaLink(undefined, 'Photo')).toBeNull();
      expect(mediaLink(null, 'Photo')).toBeNull();
      expect(mediaLink('', 'Photo')).toBeNull();
    });
    it('refuses scripts, other data types, plain text and non-strings', () => {
      expect(() => mediaLink('javascript:alert(1)', 'Profile photo')).toThrow('Profile photo is not a valid link.');
      expect(() => mediaLink('data:text/html;base64,PHNjcmlwdD4=', 'Photo')).toThrow('Photo is not a valid image.');
      expect(() => mediaLink('my photo', 'Photo')).toThrow('Photo is not a valid link.');
      expect(() => mediaLink(`https://a.com/${'x'.repeat(2100)}`, 'Photo')).toThrow('Photo is not a valid link.');
      expect(() => mediaLink(123, 'Photo')).toThrow('Photo must be a link.');
    });
  });

  describe('oneOf', () => {
    const priorities = ['LOW', 'MEDIUM', 'HIGH'] as const;
    it('accepts any case and falls back when missing', () => {
      expect(oneOf('high', priorities, 'MEDIUM', 'Priority')).toBe('HIGH');
      expect(oneOf(undefined, priorities, 'MEDIUM', 'Priority')).toBe('MEDIUM');
    });
    it('refuses anything else', () => {
      expect(() => oneOf('CRITICAL', priorities, 'MEDIUM', 'Priority')).toThrow(BadRequestException);
    });
  });

  describe('isUniqueClash', () => {
    it('matches a Prisma unique error on the field', () => {
      expect(isUniqueClash({ code: 'P2002', meta: { target: ['reference'] } }, 'reference')).toBe(true);
      expect(isUniqueClash({ code: 'P2002', meta: { target: 'Vehicle_plateNumber_key' } }, 'plateNumber')).toBe(true);
      expect(isUniqueClash({ code: 'P2002', meta: { target: ['email'] } }, 'reference')).toBe(false);
      expect(isUniqueClash({ code: 'P2025' }, 'reference')).toBe(false);
      expect(isUniqueClash(new Error('x'), 'reference')).toBe(false);
    });
  });
});
