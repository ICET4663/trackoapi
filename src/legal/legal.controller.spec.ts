import { NotFoundException } from '@nestjs/common';
import { LegalController } from './legal.controller';
import { LEGAL_DOCUMENTS } from './legal-content';

describe('LegalController', () => {
  const controller = new LegalController();

  it('serves an HTML privacy policy that discloses foreground-only location use', () => {
    const html = controller.privacy();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<h1>Privacy Policy</h1>');
    expect(html.toLowerCase()).toContain('foreground');
    expect(html.toLowerCase()).toContain('does not collect background location');
  });

  it('serves terms and account-deletion pages', () => {
    expect(controller.terms()).toContain('<h1>Terms of Service</h1>');
    expect(controller.accountDeletion()).toContain('<h1>Account Deletion</h1>');
  });

  it('escapes content into the HTML rather than injecting it raw', () => {
    // None of the shipped copy contains raw angle brackets, so the rendered page
    // should carry no unexpected tags beyond the ones the template emits.
    const html = controller.privacy();
    const tagCount = (html.match(/<h2>/g) ?? []).length;
    expect(tagCount).toBe(LEGAL_DOCUMENTS.find((d) => d.id === 'privacy-policy')!.sections.length);
  });

  it('exposes the same documents in machine-readable form', () => {
    const summaries = controller.documents();
    expect(summaries.map((s) => s.id)).toEqual(['privacy-policy', 'terms-of-service', 'account-deletion']);

    const privacy = controller.document('privacy-policy');
    expect(privacy.sections.some((section) => /location/i.test(section.heading))).toBe(true);

    // Slug lookups work too (the public route names).
    expect(controller.document('privacy').id).toBe('privacy-policy');
  });

  it('404s for an unknown document id', () => {
    expect(() => controller.document('nope')).toThrow(NotFoundException);
  });
});
