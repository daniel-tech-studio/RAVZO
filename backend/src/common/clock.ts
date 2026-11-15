/** Horloge serveur unique. Les tests peuvent la décaler (jamais l'horloge client : backend.md §4). */
let offsetMs = 0;
export const clock = {
  now: () => new Date(Date.now() + offsetMs),
  /** Réservé aux tests. */
  advance: (ms: number) => { offsetMs += ms; },
  reset: () => { offsetMs = 0; },
};
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);
/** Date économique (AAAA-MM-JJ) dans le fuseau Africa/Porto-Novo (UTC+1, sans heure d'été). */
export function economicToday(now = clock.now()): Date {
  const local = new Date(now.getTime() + HOUR);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}
export function parseDateOnly(s: string, field = 'date'): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${field}: format AAAA-MM-JJ attendu`);
  const d = new Date(`${s}T00:00:00.000Z`);
  if (isNaN(d.getTime())) throw new Error(`${field}: date invalide`);
  return d;
}
export const toDateOnly = (d: Date) => d.toISOString().slice(0, 10);
