import { Injectable } from '@nestjs/common';
import { AuthContext } from '../../common/auth';
import { clock, DAY, parseDateOnly, toDateOnly } from '../../common/clock';
import { canonicalJson, sha256 } from '../../common/crypto';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService } from '../../common/prisma.service';
import { BudgetsService } from '../budgets/budgets.service';
import { ExpensesService } from '../money/expenses.service';
import { IncomeService } from '../money/income.service';
import { InvestmentsService } from '../wealth/investments.service';
import { DocumentsService } from './documents.service';

/** CSV défensif : séparateur , ou ;, guillemets, pas d'évaluation de formules (préfixes =+-@ neutralisés). */
export function parseCsv(text: string): string[][] {
  const sep = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim())).map((r) => r.map((c) => c.trim().replace(/^[=+@]/, "'")));
}
const normAmount = (s: string) => s.replace(/[\s ]/g, '').replace(/FCFA|XOF/gi, '');

/**
 * Imports (backend.md §11, §20.7) : UPLOADED → VALIDATING → PREVIEW_READY → COMMITTED/REJECTED.
 * Déduplication par identifiant source fort puis empreinte ; rien n'est comptabilisé sans décision ligne par ligne ; rejouable sans doublon (T14).
 * Formats : BANK_CSV (date;libelle;montant;reference) — montant négatif = dépense. SGI_TRADES_CSV (date;sens;symbole;quantite;prix;frais;taxes;reference).
 */
@Injectable()
export class ImportsService {
  constructor(private prisma: PrismaService, private docs: DocumentsService, private expenses: ExpensesService, private incomes: IncomeService, private investments: InvestmentsService, private budgets: BudgetsService, private events: EventsService) {}

  async create(auth: AuthContext, dto: { documentId: string; sourceType: 'BANK_CSV' | 'SGI_TRADES_CSV'; targetAccountId: string }) {
    const { doc, content } = await this.docs.readDecrypted(auth.ownerId, dto.documentId);
    if (doc.mimeDetected !== 'text/csv') throw new DomainError('VALIDATION_FAILED', 'Seuls les CSV sont importables');
    const fileDigest = sha256(content);
    const batch = await this.prisma.importBatch.create({ data: { ownerId: auth.ownerId, documentId: doc.id, sourceType: dto.sourceType, targetAccountId: dto.targetAccountId, status: 'VALIDATING', fileDigest } });
    try {
      const rows = parseCsv(content.toString('utf8').replace(/^﻿/, ''));
      if (rows.length > 5001) throw new Error('Fichier trop long (5000 lignes max)');
      const body = /date/i.test(rows[0]?.[0] ?? '') ? rows.slice(1) : rows;
      let n = 0;
      for (const r of body) {
        n++;
        const { normalized, errors } = this.normalize(dto.sourceType, r);
        const digest = sha256(canonicalJson({ t: dto.sourceType, a: dto.targetAccountId, ...normalized, ref: normalized.reference ?? null }));
        let classification = errors.length ? 'INVALID' : 'NEW', matched: string | null = null;
        if (!errors.length) {
          const m = await this.findMatch(auth.ownerId, dto, normalized, digest);
          if (m) { classification = m.kind; matched = m.id; }
        }
        await this.prisma.importRow.create({ data: { batchId: batch.id, rowNumber: n, canonicalDigest: digest, normalizedData: normalized, classification, validationErrors: errors.join('; ') || null, matchedResourceId: matched } });
      }
      await this.prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'PREVIEW_READY', rowCount: n } });
    } catch (e: any) {
      await this.prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'REJECTED', errorSummary: String(e.message).slice(0, 300) } });
    }
    await this.prisma.tx((tx) => this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'import.progress', aggregateType: 'ImportBatch', aggregateId: batch.id, outbox: false }));
    return this.get(auth, batch.id);
  }

  private normalize(type: string, r: string[]) {
    const errors: string[] = [];
    const dateOk = (s: string) => { const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); const iso = m ? `${m[3]}-${m[2]}-${m[1]}` : s; try { parseDateOnly(iso); return iso; } catch { errors.push('DATE_INVALIDE'); return s; } };
    if (type === 'BANK_CSV') {
      const [date, label, amount, reference] = r;
      const a = normAmount(amount ?? '');
      if (!/^-?\d+$/.test(a) || a === '0' || a === '-0') errors.push('MONTANT_INVALIDE');
      if (!label) errors.push('LIBELLE_MANQUANT');
      return { normalized: { date: dateOk(date ?? ''), label: (label ?? '').slice(0, 160), amountMinor: a, reference: reference || null }, errors };
    }
    const [date, side, symbol, quantity, price, fees, taxes, reference] = r;
    if (!['BUY', 'SELL', 'ACHAT', 'VENTE'].includes((side ?? '').toUpperCase())) errors.push('SENS_INVALIDE');
    if (!/^\d+(\.\d+)?$/.test(quantity ?? '')) errors.push('QUANTITE_INVALIDE');
    if (!/^\d+(\.\d+)?$/.test((price ?? '').replace(',', '.'))) errors.push('PRIX_INVALIDE');
    if (!reference) errors.push('REFERENCE_AVIS_REQUISE');
    return { normalized: { date: dateOk(date ?? ''), side: ['ACHAT', 'BUY'].includes((side ?? '').toUpperCase()) ? 'BUY' : 'SELL', symbol: (symbol ?? '').toUpperCase(), quantity, unitPrice: (price ?? '').replace(',', '.'), feesMinor: normAmount(fees || '0'), taxesMinor: normAmount(taxes || '0'), reference }, errors };
  }

  private async findMatch(ownerId: string, dto: { sourceType: string; targetAccountId: string }, n: any, digest: string) {
    const prior = await this.prisma.importRow.findFirst({ where: { canonicalDigest: digest, postedResourceId: { not: null }, batch: { ownerId } } });
    if (prior) return { kind: 'MATCHED', id: prior.postedResourceId! };
    if (dto.sourceType === 'BANK_CSV') {
      const amt = BigInt(n.amountMinor);
      const ref = n.reference ? `IMP:${n.reference}` : null;
      if (ref) {
        const byRef = amt < 0n ? await this.prisma.expense.findFirst({ where: { ownerId, accountId: dto.targetAccountId, externalRef: ref } }) : await this.prisma.income.findFirst({ where: { ownerId, accountId: dto.targetAccountId, externalRef: ref } });
        if (byRef) return { kind: 'MATCHED', id: byRef.id };
      }
      const d = parseDateOnly(n.date);
      const near = { gte: new Date(d.getTime() - 2 * DAY), lte: new Date(d.getTime() + 2 * DAY) };
      const sim = amt < 0n ? await this.prisma.expense.findFirst({ where: { ownerId, accountId: dto.targetAccountId, amountMinor: -amt, economicDate: near, status: 'POSTED' } }) : await this.prisma.income.findFirst({ where: { ownerId, accountId: dto.targetAccountId, grossMinor: amt, economicDate: near } });
      if (sim) return { kind: 'POSSIBLE_DUPLICATE', id: sim.id };
    } else {
      const t = await this.prisma.trade.findFirst({ where: { ownerId, brokerageAccountId: dto.targetAccountId, externalRef: n.reference } });
      if (t) return { kind: 'MATCHED', id: t.id };
    }
    return null;
  }

  async get(auth: AuthContext, id: string) {
    const b = await this.prisma.importBatch.findUnique({ where: { id } });
    if (!b || b.ownerId !== auth.ownerId) throw notFound('Import');
    const counts = await this.prisma.importRow.groupBy({ by: ['classification'], where: { batchId: id }, _count: true });
    return { ...b, summary: Object.fromEntries(counts.map((c) => [c.classification, c._count])) };
  }
  async rows(auth: AuthContext, id: string) {
    await this.get(auth, id);
    return this.prisma.importRow.findMany({ where: { batchId: id }, orderBy: { rowNumber: 'asc' } });
  }
  async list(auth: AuthContext) { return this.prisma.importBatch.findMany({ where: { ownerId: auth.ownerId }, orderBy: { createdAt: 'desc' }, take: 50 }); }

  /** Décision ligne par ligne ; chaque ligne engagée l'est une seule fois (identifiant métier = id de ligne). */
  async confirm(auth: AuthContext, id: string, decisions: { rowNumber: number; decision: 'COMMIT' | 'SKIP'; categoryId?: string }[]) {
    const b = await this.prisma.importBatch.findUnique({ where: { id } });
    if (!b || b.ownerId !== auth.ownerId) throw notFound('Import');
    if (b.status === 'COMMITTED') return this.get(auth, id);
    if (b.status !== 'PREVIEW_READY') throw new DomainError('STATE_CONFLICT', 'Import non prêt');
    const rows = await this.prisma.importRow.findMany({ where: { batchId: id } });
    let committed = 0;
    for (const d of decisions) {
      const r = rows.find((x) => x.rowNumber === d.rowNumber);
      if (!r || r.postedResourceId) continue;
      if (d.decision === 'SKIP' || r.classification === 'INVALID' || r.classification === 'MATCHED') { await this.prisma.importRow.update({ where: { id: r.id }, data: { decision: 'SKIP' } }); continue; }
      const n = r.normalizedData as any;
      await this.prisma.tx(async (tx) => {
        const fresh = await tx.importRow.findUniqueOrThrow({ where: { id: r.id } });
        if (fresh.postedResourceId) return;
        let resId: string;
        if (b.sourceType === 'BANK_CSV') {
          const amt = BigInt(n.amountMinor);
          const ref = n.reference ? `IMP:${n.reference}` : `IMPD:${r.canonicalDigest.slice(0, 32)}`;
          resId = amt < 0n
            ? (await this.expenses.create(tx, auth, r.id, { accountId: b.targetAccountId!, categoryId: d.categoryId, amountMinor: -amt, economicDate: n.date, label: n.label, externalRef: ref, source: 'IMPORT' })).id
            : (await this.incomes.create(tx, auth, r.id, { accountId: b.targetAccountId!, source: n.label, grossMinor: amt, economicDate: n.date, categoryId: d.categoryId, externalRef: ref, nature: 'OTHER' })).id;
        } else {
          const sec = await tx.security.findUnique({ where: { symbol: n.symbol } }) ?? await tx.security.create({ data: { symbol: n.symbol, name: n.symbol, source: 'IMPORT' } });
          resId = (await this.investments.recordTrade(tx, auth, { brokerageAccountId: b.targetAccountId!, securityId: sec.id, side: n.side, quantity: n.quantity, unitPrice: n.unitPrice, feesMinor: BigInt(n.feesMinor || 0), taxesMinor: BigInt(n.taxesMinor || 0), executedAt: `${n.date}T12:00:00Z`, externalRef: n.reference, importRowId: r.id })).id;
        }
        await tx.importRow.update({ where: { id: r.id }, data: { decision: 'COMMIT', postedResourceId: resId } });
        committed++;
      });
    }
    await this.prisma.importBatch.update({ where: { id }, data: { status: 'COMMITTED', confirmedAt: clock.now() } });
    await this.prisma.tx((tx) => this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'IMPORT_COMMITTED', resource: `ImportBatch:${id}`, context: { committed } }));
    return { ...(await this.get(auth, id)), committedNow: committed };
  }
}
