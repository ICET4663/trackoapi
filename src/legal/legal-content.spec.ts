import { findLegalDocument, LEGAL_DOCUMENTS, LEGAL_OWNER_NAME, LEGAL_OWNER_PLACEHOLDER } from './legal-content';

describe('privacy processor and media disclosures', () => {
  const privacy = findLegalDocument('privacy')!;
  const text = privacy.sections.map(section => section.body).join(' ');
  it.each(['Paystack', 'Smile ID', 'Resend', 'Google Maps', 'Google Cloud', 'Supabase'])
    ('names the %s processor used by configured integrations', name => {
      expect(text).toContain(name);
    });
  it('explains permission and processing for voice and photos', () => {
    expect(text).toContain('Microphone and camera access require your device permission');
    expect(text).toContain('sends audio for storage');
    expect(text).toContain('Original transcripts and English translations');
  });
  it('does not promise accurate transcription', () => {
    expect(text).toContain('Transcription and translation can be inaccurate');
    expect(text).toContain('confirm important addresses, prices and delivery instructions in writing');
  });
  it('names the owner as data controller and the developer by role only', () => {
    expect(privacy.sections[0].heading).toBe('Who runs Trako');
    expect(text).toContain(`owned and operated by ${LEGAL_OWNER_NAME}, an individual`);
    expect(text).toContain('data controller');
    expect(text).toContain("An independent developer builds and maintains Trako on the owner's instructions");
    expect(text).not.toMatch(/Zango|Elemide/);
  });
  it('names the owner as the party to the terms', () => {
    const terms = findLegalDocument('terms')!.sections.map(section => section.body).join(' ');
    expect(terms).toContain(`owned and operated by ${LEGAL_OWNER_NAME}`);
    expect(terms).toContain('is not a party to these terms');
  });
  // Fails until the owner's legal name is filled in, so the placeholder is never published.
  it("has the owner's real legal name filled in", () => {
    expect(LEGAL_OWNER_NAME).not.toBe(LEGAL_OWNER_PLACEHOLDER);
    expect(LEGAL_OWNER_NAME.trim().length).toBeGreaterThan(3);
  });
  it('preserves public legal route identifiers', () => {
    expect(LEGAL_DOCUMENTS.map(document => document.slug)).toEqual(['privacy', 'terms', 'account-deletion']);
    expect(findLegalDocument('privacy-policy')).toBe(privacy);
  });
});
