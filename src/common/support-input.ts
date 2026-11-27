import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';

// Input rules for support requests and safety alerts (25 November 2026). These endpoints take
// loose JSON bodies, so the global ValidationPipe never checks them; the rules live here.

export const SUPPORT_CHANNELS = ['CHAT', 'PHONE', 'EMAIL'] as const;
export const SUPPORT_MESSAGE_MAX = 4000;
export const SUPPORT_TOPIC_MAX = 120;
/** Postgres `integer`: the largest kobo amount an Int column can hold (N21,474,836.47). */
export const MAX_INT_KOBO = 2_147_483_647;

/** A ticket id that cannot collide when two requests arrive in the same millisecond. */
export function ticketId(prefix: string) {
  return `${prefix}-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/** CHAT, PHONE or EMAIL (any case); anything else is refused. Missing means CHAT. */
export function supportChannel(value: unknown) {
  if (value === undefined || value === null || value === '') return 'CHAT';
  const channel = String(value).trim().toUpperCase();
  if (!(SUPPORT_CHANNELS as readonly string[]).includes(channel)) {
    throw new BadRequestException(`Choose a support channel: ${SUPPORT_CHANNELS.join(', ')}.`);
  }
  return channel;
}

/** A topic is a short label: trimmed and cut to length rather than refused. */
export function supportTopic(value: unknown, fallback: string) {
  const topic = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return (topic || fallback).slice(0, SUPPORT_TOPIC_MAX);
}

/** A support message: text only, refused when longer than the limit so nothing is cut silently. */
export function supportMessage(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new BadRequestException('The message must be text.');
  const message = String(value).trim();
  if (message.length > SUPPORT_MESSAGE_MAX) {
    throw new BadRequestException(`Keep the message under ${SUPPORT_MESSAGE_MAX.toLocaleString('en-US')} characters.`);
  }
  return message || null;
}

/**
 * Safety alerts are never refused for their wording: an over-long or odd message is turned into
 * text and cut to the limit, so the alert still reaches operations.
 */
export function safetyMessage(value: unknown, fallback: string) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return (text || fallback).slice(0, SUPPORT_MESSAGE_MAX);
}

/** A real coordinate pair, or null (never refused: a safety alert goes out without it). */
export function safetyLocation(latitude: unknown, longitude: unknown) {
  if (latitude === undefined || latitude === null || latitude === '' || longitude === undefined || longitude === null || longitude === '') return null;
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { latitude: lat, longitude: lng } : null;
}

/** The shipment reference sent with a request, as text, or null. */
export function shipmentRef(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ref = String(value).trim();
  return ref && ref.length <= 64 ? ref : null;
}

export type ShipmentLookup = {
  shipment: { findFirst: (args: unknown) => Promise<{ id: string; customerId: string } | null> };
  driverAssignment: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
};

/**
 * The shipment id a support request or safety alert may be linked to: the user's own booking,
 * a trip they were offered or drove, a trip on one of their trucks, or any shipment for staff.
 * Accepts the shipment id or its TRK reference. Null when it does not exist or is not theirs.
 */
export async function accessibleShipmentId(prisma: ShipmentLookup, userId: string, role: string | undefined, ref: string | null) {
  if (!ref) return null;
  const shipment = await prisma.shipment.findFirst({
    where: { OR: [{ id: ref }, { reference: ref }] },
    select: { id: true, customerId: true },
  }).catch(() => null);
  if (!shipment) return null;
  if (role === 'ADMIN' || role === 'DISPATCHER' || shipment.customerId === userId) return shipment.id;
  const linked = await prisma.driverAssignment.findFirst({
    where: { shipmentId: shipment.id, OR: [{ driverId: userId }, { vehicle: { ownerId: userId } }] },
    select: { id: true },
  }).catch(() => null);
  return linked ? shipment.id : null;
}
