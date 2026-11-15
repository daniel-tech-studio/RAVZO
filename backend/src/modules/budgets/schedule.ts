import { DAY } from '../../common/clock';

/** Règles de récurrence : MONTHLY:<1-28|31=fin de mois> | WEEKLY:<1-7 lundi=1> | EVERY_N_DAYS:<n>. */
export function validateRule(rule: string): boolean {
  const [k, v] = rule.split(':');
  const n = Number(v);
  if (!Number.isInteger(n)) return false;
  if (k === 'MONTHLY') return n >= 1 && n <= 31;
  if (k === 'WEEKLY') return n >= 1 && n <= 7;
  if (k === 'EVERY_N_DAYS') return n >= 1 && n <= 366;
  return false;
}
export function nextOccurrence(rule: string, after: Date): Date {
  const [k, v] = rule.split(':');
  const n = Number(v);
  if (k === 'EVERY_N_DAYS') return new Date(after.getTime() + n * DAY);
  if (k === 'WEEKLY') {
    const dow = ((after.getUTCDay() + 6) % 7) + 1;
    let diff = (n - dow + 7) % 7;
    if (diff === 0) diff = 7;
    return new Date(after.getTime() + diff * DAY);
  }
  // MONTHLY
  let y = after.getUTCFullYear();
  let m = after.getUTCMonth();
  const dayIn = (yy: number, mm: number) => Math.min(n, new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate());
  let cand = new Date(Date.UTC(y, m, dayIn(y, m)));
  if (cand <= after) { m += 1; if (m > 11) { m = 0; y += 1; } cand = new Date(Date.UTC(y, m, dayIn(y, m))); }
  return cand;
}
/** Occurrences dans [from, to] incluant `first` si dans l'intervalle. */
export function occurrencesBetween(rule: string, first: Date, from: Date, to: Date, max = 60): Date[] {
  const out: Date[] = [];
  let d = first;
  let guard = 0;
  while (d <= to && guard++ < 1000 && out.length < max) {
    if (d >= from) out.push(d);
    d = nextOccurrence(rule, d);
  }
  return out;
}
