// Single source of truth for Tracko's legal documents. Both the public HTML
// pages (LegalController - used for the app-store data-safety / policy URLs) and
// the in-app document viewer (SettingsService.legalDocument) render from here so
// they can never drift.
//
// This is product/legal copy for a preview build; counsel should review before a
// production store submission. It is written to be NDPR-aware (Nigeria Data
// Protection Act 2023) and to satisfy the Play/App Store location-disclosure
// requirement, since drivers share live location during active deliveries.

export const LEGAL_COMPANY_NAME = 'Tracko Logistics';
export const LEGAL_SUPPORT_EMAIL = 'support@tracko.example';
export const LEGAL_LAST_UPDATED = 'September 10, 2026';

export type LegalSection = { heading: string; body: string };

export type LegalDocument = {
  id: string;
  title: string;
  updated: string;
  /** Short one-line route name used by the public HTML controller. */
  slug: string;
  summary: string;
  sections: LegalSection[];
};

export const LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    id: 'privacy-policy',
    slug: 'privacy',
    title: 'Privacy Policy',
    updated: LEGAL_LAST_UPDATED,
    summary: 'What Tracko collects, why, how long it is kept, and your rights.',
    sections: [
      {
        heading: 'Overview',
        body: `${LEGAL_COMPANY_NAME} collects only the data needed to create accounts, price and manage shipments, match drivers and trucks, hold and release escrow, support communication between parties, prevent fraud, and provide customer support. We do not sell personal data.`,
      },
      {
        heading: 'Data we collect',
        body: 'Account and contact details (name, email, phone, role); identity-verification data you submit for KYC (government ID type and number, optional BVN, driver licence, vehicle documents) and the document images; shipment details (pickup and destination addresses and coordinates, cargo description, weight, photos); payment metadata from our payment processor (never full card numbers); in-app messages, voice notes and their transcripts; support requests; device push tokens; and security and audit logs.',
      },
      {
        heading: 'Location data',
        body: 'When a driver has an active accepted trip, the app shares the device location with Tracko so the customer, the truck owner and dispatch can follow the shipment and so we can confirm pickup and delivery. Location is collected only while a trip is active and the app is in use (foreground); Tracko does not collect background location. Customers and dispatch see the driver location only for shipments they are party to. A driver can stop sharing by ending or declining trips and by revoking the location permission in the device settings; doing so prevents accepting new trips. Location points attached to a completed shipment are retained with that shipment record.',
      },
      {
        heading: 'How data is used',
        body: 'To operate the Tracko logistics service, verify users, price quotes, assign and track shipments, move funds through escrow, translate messages into a recipient\'s preferred language, process support and disputes, secure accounts, and meet legal, tax or regulatory obligations. Automated matching ranks eligible drivers by capacity, rating, proximity and availability; a dispatcher or admin can always override it.',
      },
      {
        heading: 'Sharing',
        body: 'Shipment and contact details are shared between the customer, the assigned driver, the truck owner and Tracko operations for that shipment only. We use third-party processors for payments (Paystack), email delivery, maps and geocoding, push delivery and, where enabled, speech-to-text and translation. Processors receive only what they need for their function. We may disclose data where required by law or to protect safety and prevent fraud.',
      },
      {
        heading: 'Retention and deletion',
        body: 'You can request account deletion in the app (Account → Legal & policies → Request account deletion) or by email. On approval we delete or anonymize personal account data and revoke active sessions. Operational records - shipment, escrow, payout, dispute, KYC decision and audit logs - may be retained where required for safety, fraud prevention, dispute resolution, accounting, tax or legal compliance, for as long as that purpose requires.',
      },
      {
        heading: 'Your rights',
        body: 'Subject to applicable law (including the Nigeria Data Protection Act, 2023), you may request access to, correction of, or deletion of your personal data, and may object to or restrict certain processing. Contact us to exercise these rights; we may need to verify your identity first.',
      },
      {
        heading: 'Contact',
        body: `Questions or requests: ${LEGAL_SUPPORT_EMAIL}.`,
      },
    ],
  },
  {
    id: 'terms-of-service',
    slug: 'terms',
    title: 'Terms of Service',
    updated: LEGAL_LAST_UPDATED,
    summary: 'The rules for using the Tracko platform.',
    sections: [
      {
        heading: 'The service',
        body: 'Tracko is a logistics coordination platform connecting customers, drivers, truck owners, dispatchers and administrators. Tracko facilitates matching, tracking, communication and escrow; the transport itself is performed by independent drivers and truck owners.',
      },
      {
        heading: 'Eligibility and accounts',
        body: 'You must provide accurate account, shipment, vehicle, driver and contact information and keep it current. Customer, driver and truck-owner accounts self-register with email verification; dispatcher and administrator accounts are created by Tracko. You are responsible for activity under your account and for keeping your credentials secure.',
      },
      {
        heading: 'Verification (KYC)',
        body: 'Customers must complete identity verification before creating a shipment or funding escrow. Drivers and truck owners must additionally verify a driver licence and vehicle documents before accepting or being assigned loads. Tracko may pause or reject verification and may re-review it at any time.',
      },
      {
        heading: 'Shipments, payments and escrow',
        body: 'Quotes are calculated by Tracko from route, vehicle class and load, and are valid for a limited window. Escrow must be funded through the in-app Paystack flow before a shipment is dispatched. Funds are released to the truck owner/driver after delivery is confirmed and the dispute window passes, or refunded where a dispute is resolved in the customer\'s favour. Features labelled preview or demo are not production financial services.',
      },
      {
        heading: 'Conduct and content',
        body: 'You are responsible for the messages, voice notes, documents and photos you upload. Do not upload unlawful, abusive, misleading, infringing or unsafe content, and do not misuse the platform (spoofing location, circumventing escrow, harassment). Tracko may restrict content, shipments or accounts that break these rules or platform safety policies.',
      },
      {
        heading: 'Disclaimers and liability',
        body: 'The service is provided on an "as is" basis. Tracko is not the carrier and does not guarantee the acts of independent drivers or truck owners. To the extent permitted by law, Tracko is not liable for indirect or consequential loss; nothing limits liability that cannot be limited by law.',
      },
      {
        heading: 'Changes and contact',
        body: `Tracko may update these terms; material changes will be notified in the app. Continued use after an update means you accept it. Contact: ${LEGAL_SUPPORT_EMAIL}.`,
      },
    ],
  },
  {
    id: 'account-deletion',
    slug: 'account-deletion',
    title: 'Account Deletion',
    updated: LEGAL_LAST_UPDATED,
    summary: 'How to delete your Tracko account and what happens to your data.',
    sections: [
      {
        heading: 'How to request',
        body: `In the app: Account → Legal & policies → Request account deletion. By email: message ${LEGAL_SUPPORT_EMAIL} with the subject "Delete my Tracko account". Include your registered email, phone number and account role so we can locate the account.`,
      },
      {
        heading: 'What happens next',
        body: 'We verify account ownership, then delete or anonymize your personal account data (profile, contact details, saved addresses, payout account, device tokens) and revoke all active sessions. We confirm when this is complete.',
      },
      {
        heading: 'What may be retained',
        body: 'Records tied to completed logistics and money movement - shipment history, escrow and payout ledgers, dispute outcomes, KYC decisions and audit logs - may be retained in de-identified or restricted form where required for safety, fraud prevention, dispute resolution, accounting, tax or legal compliance.',
      },
      {
        heading: 'Open requests and balances',
        body: 'An account with an in-progress shipment, an unreleased escrow balance or an open dispute cannot be fully deleted until those are resolved. We will tell you what is blocking the request.',
      },
    ],
  },
];

export function findLegalDocument(idOrSlug: string): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((document) => document.id === idOrSlug || document.slug === idOrSlug);
}
