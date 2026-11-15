/** Argent en unités mineures exactes (BigInt). Jamais de float (backend.md §3). */
export type Minor = bigint;

const INT_RE = /^-?\d{1,18}$/;

export function parseMinor(v: unknown, field = 'amountMinor'): Minor {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && INT_RE.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new MoneyFormatError(field);
}
export function parsePositiveMinor(v: unknown, field = 'amountMinor'): Minor {
  const m = parseMinor(v, field);
  if (m <= 0n) throw new MoneyFormatError(field, 'doit être strictement positif');
  return m;
}
export class MoneyFormatError extends Error {
  constructor(public field: string, detail = 'montant invalide (chaîne entière en unités mineures attendue)') {
    super(`${field}: ${detail}`);
  }
}
export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
export const sumBig = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
/** floor(x * bp / 10000) pour x >= 0 — arrondi conservateur. */
export const percentBpFloor = (x: bigint, bp: bigint) => (x <= 0n ? 0n : (x * bp) / 10000n);
