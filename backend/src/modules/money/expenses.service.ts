import { Injectable } from '@nestjs/common';
import { AuthContext } from '../../common/auth';
import { economicToday, parseDateOnly } from '../../common/clock';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { BudgetsService } from '../budgets/budgets.service';
import { BooksService } from '../ledger/books.service';
import { LedgerService } from '../ledger/ledger.service';

@Injectable()
export class ExpensesService {
  constructor(private prisma: PrismaService, private ledger: LedgerService, private books: BooksService, private accounts: AccountsService, private budgets: BudgetsService, private events: EventsService) {}

  async list(auth: AuthContext, q: { from?: string; to?: string; categoryId?: string; accountId?: string; cycleId?: string; limit?: number }) {
    return this.prisma.expense.findMany({
      where: {
        ownerId: auth.ownerId, ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.accountId ? { accountId: q.accountId } : {}), ...(q.cycleId ? { cycleId: q.cycleId } : {}),
        ...(q.from || q.to ? { economicDate: { ...(q.from ? { gte: parseDateOnly(q.from) } : {}), ...(q.to ? { lte: parseDateOnly(q.to) } : {}) } } : {}),
      },
      orderBy: [{ economicDate: 'desc' }, { createdAt: 'desc' }], take: Math.min(q.limit ?? 100, 500),
    });
  }

  /** Dépense : trésorerie −, charge + ; une seule écriture par achat ; jamais bloquée par un budget (llm §6.3). */
  async create(tx: Tx, auth: AuthContext, businessId: string, dto: { accountId: string; categoryId?: string; amountMinor: bigint; economicDate?: string; label: string; merchant?: string; externalRef?: string; obligationOccurrenceId?: string; source?: string }) {
    const acc = await this.accounts.getOwned(tx, auth.ownerId, dto.accountId);
    if (acc.type === 'CONTROLLED_PSP') throw new DomainError('PSP_NOT_AUTHORIZED', 'Une sortie d’un compte prestataire passe par un paiement autorisé');
    if (dto.externalRef) {
      const dup = await tx.expense.findFirst({ where: { ownerId: auth.ownerId, accountId: acc.id, externalRef: dto.externalRef } });
      if (dup) throw new DomainError('IMPORT_DUPLICATE_SUSPECTED', 'Une dépense avec cette référence existe déjà', { expenseId: dup.id });
    }
    const categoryId = dto.categoryId ?? (await this.budgets.suggestCategory(tx, auth.ownerId, dto.label, dto.merchant)).categoryId;
    const cat = categoryId ? await tx.category.findUnique({ where: { id: categoryId } }) : null;
    if (!cat || cat.ownerId !== auth.ownerId || cat.type !== 'EXPENSE') throw notFound('Catégorie de dépense');
    const date = dto.economicDate ? parseDateOnly(dto.economicDate) : economicToday();
    const cycle = await this.budgets.cycleFor(tx, auth.ownerId, date);
    let occurrence = null;
    if (dto.obligationOccurrenceId) {
      occurrence = await tx.obligationOccurrence.findUnique({ where: { id: dto.obligationOccurrenceId }, include: { obligation: true } });
      if (!occurrence || occurrence.obligation.ownerId !== auth.ownerId) throw notFound('Échéance');
      if (occurrence.state === 'SETTLED') throw new DomainError('STATE_CONFLICT', 'Échéance déjà réglée');
    }
    const e = await tx.expense.create({
      data: { id: businessId, ownerId: auth.ownerId, accountId: acc.id, categoryId: cat.id, economicDate: date, amountMinor: dto.amountMinor, currency: acc.currency, label: dto.label, merchant: dto.merchant, source: dto.source ?? (occurrence ? 'OBLIGATION' : 'MANUAL'), externalRef: dto.externalRef, cycleId: cycle?.id ?? null, offCycle: !cycle },
    });
    const expAcc = await this.books.forCategory(tx, auth.ownerId, cat.id, 'EXPENSE', cat.name, acc.currency);
    const { transaction } = await this.ledger.post(tx, {
      ownerId: auth.ownerId, businessType: 'EXPENSE', businessId: e.id, economicDate: date, memo: dto.label, actorDeviceId: auth.deviceId,
      postings: [{ accountId: acc.ledgerAccountId, amount: -dto.amountMinor }, { accountId: expAcc.id, amount: dto.amountMinor }],
    });
    const r = await tx.expense.update({ where: { id: e.id }, data: { ledgerTransactionId: transaction.id } });
    if (occurrence) await tx.obligationOccurrence.update({ where: { id: occurrence.id }, data: { state: 'SETTLED', settledExpenseId: e.id } });
    const warnings = await this.budgets.budgetWarnings(tx, auth.ownerId, cycle?.id ?? null, cat.id, e.id);
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'balance.updated', aggregateType: 'Expense', aggregateId: e.id, version: 1 });
    return { ...r, warnings, offCycle: !cycle };
  }

  /** Métadonnées et reclassement de catégorie (écriture de reclassement traçable, pas d'écrasement). */
  async update(tx: Tx, auth: AuthContext, id: string, dto: { label?: string; merchant?: string; categoryId?: string; expectedVersion?: number }) {
    const e = await tx.expense.findUnique({ where: { id } });
    if (!e || e.ownerId !== auth.ownerId) throw notFound('Dépense');
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== e.version) throw new DomainError('RESOURCE_VERSION_CONFLICT', 'Dépense modifiée ailleurs', { current: e });
    if (e.status !== 'POSTED') throw new DomainError('STATE_CONFLICT', 'Dépense contrepassée');
    if (dto.categoryId && dto.categoryId !== e.categoryId) {
      const cycle = e.cycleId ? await tx.budgetCycle.findUnique({ where: { id: e.cycleId } }) : null;
      if (cycle?.state === 'CLOSED') throw new DomainError('BUSINESS_RULE_VIOLATION', 'Dépense d’un cycle clôturé : reclassement interdit');
      const [oldCat, newCat] = await Promise.all([tx.category.findUnique({ where: { id: e.categoryId } }), tx.category.findUnique({ where: { id: dto.categoryId } })]);
      if (!newCat || newCat.ownerId !== auth.ownerId || newCat.type !== 'EXPENSE') throw notFound('Catégorie');
      const from = await this.books.forCategory(tx, auth.ownerId, oldCat!.id, 'EXPENSE', oldCat!.name, e.currency);
      const to = await this.books.forCategory(tx, auth.ownerId, newCat.id, 'EXPENSE', newCat.name, e.currency);
      await this.ledger.post(tx, { ownerId: auth.ownerId, businessType: 'EXPENSE_RECLASS', businessId: `${e.id}:v${e.version}`, economicDate: e.economicDate, memo: `Reclassement ${oldCat!.name} → ${newCat.name}`, actorDeviceId: auth.deviceId, postings: [{ accountId: from.id, amount: -e.amountMinor }, { accountId: to.id, amount: e.amountMinor }] });
    }
    const { expectedVersion, ...data } = dto;
    const r = await tx.expense.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'expense.updated', aggregateType: 'Expense', aggregateId: id, version: r.version });
    return r;
  }

  /** Correction de montant/compte/date = contrepassation (step-up vérifiée par le contrôleur) puis nouvelle saisie. */
  async reverse(tx: Tx, auth: AuthContext, id: string, reason: string) {
    const e = await tx.expense.findUnique({ where: { id } });
    if (!e || e.ownerId !== auth.ownerId) throw notFound('Dépense');
    if (e.status !== 'POSTED' || !e.ledgerTransactionId) throw new DomainError('STATE_CONFLICT', 'Dépense déjà contrepassée');
    const { transaction } = await this.ledger.reverse(tx, auth.ownerId, e.ledgerTransactionId, reason, auth.deviceId);
    await tx.obligationOccurrence.updateMany({ where: { settledExpenseId: e.id }, data: { state: 'DUE', settledExpenseId: null } });
    const r = await tx.expense.update({ where: { id }, data: { status: 'REVERSED', version: { increment: 1 } } });
    await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'EXPENSE_REVERSED', resource: `Expense:${id}`, context: { reason, reversalTransactionId: transaction.id } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'balance.updated', aggregateType: 'Expense', aggregateId: id, version: r.version });
    return r;
  }
}
