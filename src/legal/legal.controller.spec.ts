import { NotFoundException } from '@nestjs/common';
import { LegalController } from './legal.controller';
import { LEGAL_DOCUMENTS } from './legal-content';

describe('LegalController', () => {
  const controller = new LegalController();

  // The policy must match what the apps actually do. Both ask only for "while using the app"
  // access and keep sharing in the background during an active delivery (Android through a
  // foreground-service notification, iOS with the blue indicator). If a build ever asks for
  // "all the time" access or collects location outside an active trip, this wording (and the
  // store privacy declarations) must change first.
  it('serves an HTML privacy policy that discloses in-use permission, background sharing during a delivery on both platforms, and the retention period', () => {
    const html = controller.privacy();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<h1>Privacy Policy</h1>');
    const text = html.toLowerCase();
    expect(text).toContain('only during an active accepted trip');
    expect(text).toContain('asks only for permission to use location while the app is in use');
    expect(text).toContain('persistent notification (android)');
    expect(text).toContain('blue location indicator (iphone)');
    expect(text).toContain('stops when the delivery ends');
    // Android blocks ACCESS_BACKGROUND_LOCATION (app.json), so the policy must not offer it.
    expect(text).not.toContain('allow all the time');
    expect(text).not.toContain('only while the app is open');
    expect(text).toContain('deleted automatically after the retention period');
    expect(text).toContain('open dispute');
    expect(text).not.toContain('does not collect background location');
    expect(text).not.toContain('retained with that shipment record');
  });

  it('names Smile ID and the identity fields used for automated KYC checks', () => {
    const html = controller.privacy();
    expect(html).toContain('Smile ID');
    expect(html).toContain('Nigerian ID type and number');
    expect(html).toContain('BVN when supplied');
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

