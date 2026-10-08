import { findLegalDocument, LEGAL_DOCUMENTS } from './legal-content';

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
  it('preserves public legal route identifiers', () => {
    expect(LEGAL_DOCUMENTS.map(document => document.slug)).toEqual(['privacy', 'terms', 'account-deletion']);
    expect(findLegalDocument('privacy-policy')).toBe(privacy);
  });
});
