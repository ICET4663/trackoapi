import { BadRequestException, InternalServerErrorException, Logger } from '@nestjs/common';
import { MAX_INT_KOBO } from './support-input';

// Shared input rules (27 November 2026) for endpoints whose bodies are plain object types,
// which the global ValidationPipe never checks. Each rule refuses bad input with a 400 that
// says what to fix, instead of letting the database refuse it with a 500.

const logger = new Logger('InputRules');

/**
 * A 500 whose message is safe to show: the database's own error text goes to the server log
 * only. `message` should read as a full sentence ("Could not save this address.").
 */
export function internalError(message: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  logger.error(`${message} ${detail}`);
  const sentence = /[.!?]$/.test(message.trim()) ? message.trim() : `${message.trim()}.`;
  return new InternalServerErrorException(/try again/i.test(sentence) ? sentence : `${sentence} Please try again.`);
}

type TextRule = { label: string; max: number; min?: number };

/** Optional text: null when missing or blank, refused when not text or too long (never cut silently). */
export function optionalText(value: unknown, rule: TextRule): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new BadRequestException(`${rule.label} must be text.`);
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > rule.max) {
    throw new BadRequestException(`${rule.label} must be ${rule.max.toLocaleString('en-US')} characters or fewer.`);
  }
  if (rule.min && text.length < rule.min) {
    throw new BadRequestException(`${rule.label} must be at least ${rule.min} characters.`);
  }
  return text;
}

/** Required text with the same rules as optionalText. */
export function requiredText(value: unknown, rule: TextRule): string {
  const text = optionalText(value, rule);
  if (!text) throw new BadRequestException(`${rule.label} is required.`);
  return text;
}

/** A positive money amount in kobo, rounded to a whole kobo and small enough for an Int column. */
export function koboAmount(value: unknown, label: string): number {
  const amount = typeof value === 'string' && value.trim() ? Number(value) : typeof value === 'number' ? value : NaN;
  const kobo = Math.round(amount);
  if (!Number.isFinite(amount) || kobo <= 0) throw new BadRequestException(`Enter a valid ${label}.`);
  if (kobo > MAX_INT_KOBO) throw new BadRequestException(`That ${label} is too large.`);
  return kobo;
}

export const MEDIA_LINK_MAX = 2048;
/** A data: URL is the upload fallback when storage is not configured; 4 MB is the body limit. */
export const DATA_URL_MAX = 4 * 1024 * 1024;

/**
 * A photo or document link: an http(s) URL, or a base64 data: URL of an image or PDF.
 * Anything else (javascript:, file paths, plain text) is refused.
 */
export function mediaLink(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestException(`${label} must be a link.`);
  const link = value.trim();
  if (/^data:/i.test(link)) {
    if (!/^data:(image\/[a-z0-9.+-]+|application\/pdf);base64,[A-Za-z0-9+/=\s]+$/i.test(link) || link.length > DATA_URL_MAX) {
      throw new BadRequestException(`${label} is not a valid image.`);
    }
    return link;
  }
  if (link.length > MEDIA_LINK_MAX) throw new BadRequestException(`${label} is not a valid link.`);
  try {
    const url = new URL(link);
    if (url.protocol === 'https:' || url.protocol === 'http:') return link;
  } catch {
    // fall through
  }
  throw new BadRequestException(`${label} is not a valid link.`);
}

/** One of the listed values (any case); missing means the fallback. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string): T {
  if (value === undefined || value === null || value === '') return fallback;
  const choice = String(value).trim().toUpperCase();
  if (!(allowed as readonly string[]).includes(choice)) throw new BadRequestException(`${label} must be one of: ${allowed.join(', ')}.`);
  return choice as T;
}

/** True when a Prisma error is a unique-constraint clash on the given field. */
export function isUniqueClash(error: unknown, field: string) {
  const err = error as { code?: string; meta?: { target?: unknown } } | null;
  if (err?.code !== 'P2002') return false;
  const target = err.meta?.target;
  return Array.isArray(target) ? target.includes(field) : typeof target === 'string' ? target.includes(field) : true;
}
