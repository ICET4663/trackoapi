import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import {
  findLegalDocument,
  LEGAL_DOCUMENTS,
  LEGAL_SUPPORT_EMAIL,
  type LegalDocument,
} from './legal-content';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPage(document: LegalDocument): string {
  const sections = document.sections
    .map((section) => `<h2>${escapeHtml(section.heading)}</h2>\n<p>${escapeHtml(section.body)}</p>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tracko ${escapeHtml(document.title)}</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; max-width: 840px; margin: 40px auto; padding: 0 20px; color: #102033; }
    h1, h2 { color: #0b3558; }
    a { color: #0a67c7; }
  </style>
</head>
<body>
<h1>${escapeHtml(document.title)}</h1>
<p>Last updated: ${escapeHtml(document.updated)}</p>
${sections}
<p>Contact us at <a href="mailto:${LEGAL_SUPPORT_EMAIL}">${LEGAL_SUPPORT_EMAIL}</a>.</p>
</body>
</html>`;
}

@Controller('legal')
export class LegalController {
  // Kept as individual named routes because the app-store data-safety and
  // policy URLs point at these exact paths (see README).
  @Get('privacy')
  @Public()
  @Header('Content-Type', 'text/html; charset=utf-8')
  privacy() {
    return renderPage(findLegalDocument('privacy')!);
  }

  @Get('terms')
  @Public()
  @Header('Content-Type', 'text/html; charset=utf-8')
  terms() {
    return renderPage(findLegalDocument('terms')!);
  }

  @Get('account-deletion')
  @Public()
  @Header('Content-Type', 'text/html; charset=utf-8')
  accountDeletion() {
    return renderPage(findLegalDocument('account-deletion')!);
  }

  // Machine-readable form of the same content, so any client can render the
  // documents natively instead of embedding the HTML page.
  @Get('documents')
  @Public()
  documents() {
    return LEGAL_DOCUMENTS.map(({ id, slug, title, updated, summary }) => ({ id, slug, title, updated, summary }));
  }

  @Get('documents/:id')
  @Public()
  document(@Param('id') id: string) {
    const document = findLegalDocument(id);
    if (!document) throw new NotFoundException('Legal document not found.');
    return document;
  }
}
