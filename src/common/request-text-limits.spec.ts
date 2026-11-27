import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MessageKind } from '@prisma/client';
import { CreateShipmentDto } from '../shipments/dto/create-shipment.dto';
import { SendMessageDto } from '../communication/dto/send-message.dto';

// The global ValidationPipe runs these same decorators on every booking and chat message.
async function errorsFor<T extends object>(cls: new () => T, body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(cls, body) as object);
  return errors.map((error) => ({ property: error.property, messages: Object.values(error.constraints ?? {}) }));
}

describe('request text limits (28 Nov)', () => {
  const booking = {
    origin: '14 Admiralty Way, Lekki Phase 1, Lagos',
    destination: 'Kano Central Market, Kano',
    cargoType: 'Bags of rice',
    quantity: '120 bags',
    truckType: 'Flatbed',
    pickupContactPhone: '+234 803 000 0000',
    cargoPhotoUri: `data:image/jpeg;base64,${'A'.repeat(200_000)}`,
    quoteToken: 'q'.repeat(3000),
  };

  it('accepts a normal booking, including a photo sent as a data link', async () => {
    expect(await errorsFor(CreateShipmentDto, booking)).toEqual([]);
  });

  it.each([
    ['origin', 501],
    ['destination', 501],
    ['pickupAddress', 501],
    ['destinationAddress', 501],
    ['pickupLabel', 201],
    ['destinationLabel', 201],
    ['cargoType', 201],
    ['cargoDescription', 1001],
    ['quantity', 101],
    ['truckType', 101],
    ['pickupContactPhone', 31],
    ['quoteToken', 8193],
  ])('refuses a booking whose %s is %i characters', async (field, length) => {
    const errors = await errorsFor(CreateShipmentDto, { ...booking, [field]: 'x'.repeat(length) });
    expect(errors.map((error) => error.property)).toEqual([field]);
  });

  it('explains the commodity limit in plain words', async () => {
    const errors = await errorsFor(CreateShipmentDto, { ...booking, cargoType: 'x'.repeat(201) });
    expect(errors[0].messages).toEqual(['Keep the commodity under 200 characters.']);
  });

  const message = { id: 'local_1795800000000', kind: MessageKind.TEXT, body: 'On my way to pickup.' };

  it('accepts a normal text message and a voice note with transcripts', async () => {
    expect(await errorsFor(SendMessageDto, message)).toEqual([]);
    expect(await errorsFor(SendMessageDto, {
      kind: MessageKind.VOICE,
      attachmentUrl: 'https://example.supabase.co/storage/v1/object/public/media/voice.m4a',
      transcript: 'w '.repeat(2500),
      sourceTranscript: 'w '.repeat(2500),
      englishTranscript: 'w '.repeat(2500),
      sourceLanguage: 'yo',
      durationSeconds: 95,
    })).toEqual([]);
  });

  it.each([
    ['id', 101],
    ['senderId', 101],
    ['body', 4001],
    ['transcript', 10001],
    ['sourceTranscript', 10001],
    ['englishTranscript', 10001],
    ['sourceLanguage', 21],
  ])('refuses a message whose %s is %i characters', async (field, length) => {
    const errors = await errorsFor(SendMessageDto, { ...message, [field]: 'x'.repeat(length) });
    expect(errors.map((error) => error.property)).toEqual([field]);
  });

  it('explains the message limit in plain words', async () => {
    const errors = await errorsFor(SendMessageDto, { ...message, body: 'x'.repeat(4001) });
    expect(errors[0].messages).toEqual(['Keep the message under 4,000 characters.']);
  });

  it.each([-1, 3601])('refuses a voice note length of %i seconds', async (durationSeconds) => {
    const errors = await errorsFor(SendMessageDto, { ...message, kind: MessageKind.VOICE, durationSeconds });
    expect(errors.map((error) => error.property)).toEqual(['durationSeconds']);
  });
});
