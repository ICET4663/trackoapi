import { BadRequestException } from '@nestjs/common';
import { CommunicationService } from './communication.service';
import type { PrismaService } from '../prisma/prisma.service';

// The stored file is served with the type the client claims, so accepting any type let
// a signed-in user host HTML or script in Trako's public storage.
describe('CommunicationService upload file types', () => {
  it('accepts what the apps actually send: photos, voice notes, video and PDFs', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'audio/m4a', 'audio/webm', 'audio/ogg', 'video/mp4', 'application/pdf', 'application/octet-stream']) {
      expect(CommunicationService.isAllowedUploadType(type)).toBe(true);
    }
  });

  it('refuses types a browser would run', () => {
    for (const type of ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/javascript', 'application/javascript', 'application/json', 'text/plain']) {
      expect(CommunicationService.isAllowedUploadType(type)).toBe(false);
    }
  });

  it('rejects an HTML upload before storing anything', async () => {
    const queryRawUnsafe = jest.fn();
    const service = new CommunicationService({ get: () => undefined } as never, { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService, {} as never, {} as never);

    await expect(service.uploadMedia({ mimeType: 'text/html; charset=utf-8', base64: Buffer.from('<script>x</script>').toString('base64') }, 'user-1'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });
});
