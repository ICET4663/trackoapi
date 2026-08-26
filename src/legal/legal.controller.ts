import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';

const companyName = 'Tracko Logistics';
const supportEmail = 'support@tracko.example';

function htmlPage(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; max-width: 840px; margin: 40px auto; padding: 0 20px; color: #102033; }
    h1, h2 { color: #0b3558; }
    a { color: #0a67c7; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

@Controller('legal')
export class LegalController {
  @Get('privacy')
  @Public()
  @Header('Content-Type', 'text/html; charset=utf-8')
  privacy() {
    return htmlPage(
      'Tracko Privacy Policy',
      `<h1>Privacy Policy</h1>
<p>Last updated: July 20, 2026</p>
<p>${companyName} collects only the data needed to create accounts, manage shipments, match drivers and trucks, support communication, prevent fraud, and provide customer support.</p>
<h2>Data we collect</h2>
<p>Account details, contact details, role information, shipment details, location data used for logistics workflows, uploaded documents, messages, voice notes, support requests, and security logs.</p>
<h2>How data is used</h2>
<p>We use data to operate the Tracko logistics service, verify users, assign shipments, process support and disputes, secure accounts, and meet legal or regulatory obligations.</p>
<h2>Deletion and retention</h2>
<p>Users may request account deletion in the app or through the account deletion page. Personal account data is deleted or anonymized. Some operational records may be retained where required for safety, fraud prevention, dispute resolution, tax, accounting, or legal compliance.</p>
<h2>Contact</h2>
<p>Contact us at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>`,
    );
  }

  @Get('terms')
  @Public()
  @Header('Content-Type', 'text/html; charset=utf-8')
  terms() {
    return htmlPage(
      'Tracko Terms of Service',
      `<h1>Terms of Service</h1>
<p>Last updated: July 20, 2026</p>
<p>Tracko is a logistics coordination platform for customers, drivers, truck owners, dispatchers, and administrators.</p>
<h2>User responsibilities</h2>
<p>Users must provide accurate account, shipment, vehicle, driver, and contact information. Users must not upload unlawful, abusive, misleading, or unsafe content.</p>
<h2>Shipments, payments, and verification</h2>
<p>Shipment, escrow, payment, and KYC workflows must be completed through approved Tracko processes. Features marked as preview or demo are not production financial services.</p>
<h2>Messages and content</h2>
<p>Users are responsible for messages, voice notes, documents, photos, and other uploaded content. Tracko may restrict content or accounts that violate safety, legal, or platform rules.</p>
<h2>Contact</h2>
<p>Contact us at <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>`,
    );
  }

  @Get('account-deletion')
  @Public()
  @Header('Content-Type', 'text/html; charset=utf-8')
  accountDeletion() {
    return htmlPage(
      'Tracko Account Deletion',
      `<h1>Account Deletion</h1>
<p>Last updated: July 20, 2026</p>
<p>You can request deletion of your Tracko account from inside the app under Account Settings. You may also request deletion by emailing <a href="mailto:${supportEmail}">${supportEmail}</a> with the subject "Delete my Tracko account".</p>
<h2>What happens next</h2>
<p>We will verify account ownership, delete or anonymize personal account data, revoke active sessions, and confirm completion. Some operational records may be retained where required for safety, fraud prevention, dispute resolution, accounting, or legal compliance.</p>
<h2>Required information</h2>
<p>Include your registered email address, phone number, and account role so we can locate the account.</p>`,
    );
  }
}
