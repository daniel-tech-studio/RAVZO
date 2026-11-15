import { config } from './config';
import { hmac, safeEqual } from './crypto';
import { DomainError } from './errors';

/** Curseur opaque signé (backend.md §4). Ordre déterministe (date, id). */
export function encodeCursor(payload: Record<string, string>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(config.cursorSecret, body)}`;
}
export function decodeCursor(cursor?: string): Record<string, string> | null {
  if (!cursor) return null;
  const [body, sig] = cursor.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(config.cursorSecret, body))) throw new DomainError('VALIDATION_FAILED', 'Curseur invalide');
  return JSON.parse(Buffer.from(body, 'base64url').toString());
}
export function pageSize(limit?: string | number, max = 100, def = 30) {
  const n = Number(limit ?? def);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}
