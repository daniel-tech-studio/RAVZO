import { Injectable } from '@nestjs/common';
import { LedgerAccountKind } from '@prisma/client';
import { Tx } from '../../common/prisma.service';
import { LedgerService } from './ledger.service';

/** Plan de comptes standard du propriétaire (codes stables). */
export const CORE_ACCOUNTS: Record<string, { name: string; kind: LedgerAccountKind }> = {
  'EQUITY:OPENING': { name: 'Soldes d’ouverture', kind: 'EQUITY' },
  'EQUITY:REVALUATION': { name: 'Écarts de réévaluation (non encaissés)', kind: 'EQUITY' },
  'ALLOC:POOL': { name: 'Réserve d’affectation', kind: 'ALLOCATION_POOL' },
  'EXPENSE:FEES': { name: 'Frais et commissions', kind: 'EXPENSE' },
  'EXPENSE:INTEREST': { name: 'Intérêts payés', kind: 'EXPENSE' },
  'EXPENSE:REALIZED_LOSS': { name: 'Moins-values réalisées', kind: 'EXPENSE' },
  'INCOME:INTEREST': { name: 'Intérêts perçus', kind: 'INCOME' },
  'INCOME:DIVIDENDS': { name: 'Dividendes encaissés', kind: 'INCOME' },
  'INCOME:REALIZED_GAIN': { name: 'Plus-values réalisées', kind: 'INCOME' },
  'CLEARING:PSP_TRANSIT': { name: 'Transit prestataire', kind: 'CLEARING' },
  'EXPENSE:WRITE_OFF': { name: 'Pertes sur créances', kind: 'EXPENSE' },
  'INCOME:DEBT_FORGIVEN': { name: 'Remises de dettes', kind: 'INCOME' },
  'EXPENSE:RECONCILIATION_DIFF': { name: 'Écarts de rapprochement (pertes expliquées)', kind: 'EXPENSE' },
  'INCOME:RECONCILIATION_DIFF': { name: 'Écarts de rapprochement (gains expliqués)', kind: 'INCOME' },
};

@Injectable()
export class BooksService {
  constructor(private ledger: LedgerService) {}

  async core(tx: Tx, ownerId: string, code: keyof typeof CORE_ACCOUNTS | string, currency = 'XOF') {
    const def = CORE_ACCOUNTS[code];
    if (!def) throw new Error(`Compte standard inconnu ${code}`);
    return this.ledger.ensureAccount(tx, { ownerId, code: `${code}:${currency}`, name: def.name, kind: def.kind, currency });
  }
  async forCategory(tx: Tx, ownerId: string, categoryId: string, type: 'EXPENSE' | 'INCOME', name: string, currency = 'XOF') {
    return this.ledger.ensureAccount(tx, { ownerId, code: `${type}:CAT:${categoryId}:${currency}`, name, kind: type, currency });
  }
}
