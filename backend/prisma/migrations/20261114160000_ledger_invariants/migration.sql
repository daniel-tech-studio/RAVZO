-- Invariants comptables et append-only (backend.md §7.2, §14.2 : « une simple contrainte CHECK par ligne ne suffit pas »).

-- 1) Équilibre par devise et par transaction, vérifié en fin de transaction SQL (contrainte différée).
CREATE OR REPLACE FUNCTION ravzo_check_tx_balanced() RETURNS trigger AS $$
DECLARE
  tx uuid := COALESCE(NEW."transactionId", OLD."transactionId");
  bad record;
  n int;
BEGIN
  SELECT count(*) INTO n FROM "LedgerPosting" WHERE "transactionId" = tx;
  IF n < 2 THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: transaction % has % posting(s), minimum 2', tx, n;
  END IF;
  SELECT currency, sum("signedAmountMinor") AS s INTO bad
    FROM "LedgerPosting" WHERE "transactionId" = tx
    GROUP BY currency HAVING sum("signedAmountMinor") <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: transaction % currency % sum %', tx, bad.currency, bad.s;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_posting_balanced
  AFTER INSERT ON "LedgerPosting"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ravzo_check_tx_balanced();

-- 2) Postings : montant non nul, devise cohérente avec le compte.
ALTER TABLE "LedgerPosting" ADD CONSTRAINT posting_nonzero CHECK ("signedAmountMinor" <> 0);

CREATE OR REPLACE FUNCTION ravzo_check_posting_currency() RETURNS trigger AS $$
DECLARE acc_cur text;
BEGIN
  SELECT currency INTO acc_cur FROM "LedgerAccount" WHERE id = NEW."ledgerAccountId";
  IF acc_cur IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'LEDGER_CURRENCY_MISMATCH: account % is %, posting is %', NEW."ledgerAccountId", acc_cur, NEW.currency;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_posting_currency BEFORE INSERT ON "LedgerPosting" FOR EACH ROW EXECUTE FUNCTION ravzo_check_posting_currency();

-- 3) Append-only : registre, audit, historiques de paiement, preuves.
CREATE OR REPLACE FUNCTION ravzo_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY: % on % is forbidden', TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_tx_append_only BEFORE UPDATE OR DELETE ON "LedgerTransaction" FOR EACH ROW EXECUTE FUNCTION ravzo_append_only();
CREATE TRIGGER ledger_posting_append_only BEFORE UPDATE OR DELETE ON "LedgerPosting" FOR EACH ROW EXECUTE FUNCTION ravzo_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION ravzo_append_only();
CREATE TRIGGER security_event_append_only BEFORE UPDATE OR DELETE ON "SecurityEvent" FOR EACH ROW EXECUTE FUNCTION ravzo_append_only();
CREATE TRIGGER payment_history_append_only BEFORE UPDATE OR DELETE ON "PaymentStateHistory" FOR EACH ROW EXECUTE FUNCTION ravzo_append_only();
CREATE TRIGGER provider_snapshot_append_only BEFORE UPDATE OR DELETE ON "ProviderBalanceSnapshot" FOR EACH ROW EXECUTE FUNCTION ravzo_append_only();
CREATE TRIGGER recon_evidence_append_only BEFORE UPDATE OR DELETE ON "ReconciliationEvidence" FOR EACH ROW EXECUTE FUNCTION ravzo_append_only();

-- 4) Montants de commande strictement positifs.
ALTER TABLE "PaymentIntent" ADD CONSTRAINT intent_amounts_positive CHECK ("amountNetMinor" > 0 AND "feeQuoteMinor" >= 0 AND "totalDebitMinor" = "amountNetMinor" + "feeQuoteMinor");
ALTER TABLE "Expense" ADD CONSTRAINT expense_positive CHECK ("amountMinor" > 0);
ALTER TABLE "Income" ADD CONSTRAINT income_positive CHECK ("grossMinor" > 0);
ALTER TABLE "IncomeAllocation" ADD CONSTRAINT income_alloc_positive CHECK ("amountMinor" > 0);
ALTER TABLE "SavingsGoal" ADD CONSTRAINT goal_target_positive CHECK ("targetMinor" > 0);
ALTER TABLE "SavingsWithdrawalRequest" ADD CONSTRAINT withdrawal_positive CHECK ("requestedMinor" > 0);
ALTER TABLE "Liability" ADD CONSTRAINT liability_positive CHECK ("principalMinor" > 0);
ALTER TABLE "Repayment" ADD CONSTRAINT repayment_nonneg CHECK ("principalMinor" >= 0 AND "interestMinor" >= 0 AND "feeMinor" >= 0 AND ("principalMinor" + "interestMinor" + "feeMinor") > 0);
ALTER TABLE "LimitPolicy" ADD CONSTRAINT limit_positive CHECK ("perOperationMinor" > 0 AND "rolling24hMinor" >= "perOperationMinor");
ALTER TABLE "Budget" ADD CONSTRAINT budget_nonneg CHECK ("plannedMinor" >= 0);
ALTER TABLE "Trade" ADD CONSTRAINT trade_positive CHECK ("quantity" > 0 AND "unitPrice" >= 0 AND "feesMinor" >= 0 AND "taxesMinor" >= 0);
ALTER TABLE "AssetValuation" ADD CONSTRAINT valuation_nonneg CHECK ("valueMinor" >= 0);

-- 5) Une seule politique ACTIVE par propriétaire ; un seul utilisateur en V1.
CREATE UNIQUE INDEX limit_policy_one_active ON "LimitPolicy" ("ownerId") WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX single_owner_v1 ON "User" ((true));
-- Un seul cycle budgétaire ouvert à la fois.
CREATE UNIQUE INDEX one_open_cycle ON "BudgetCycle" ("ownerId") WHERE state = 'OPEN';
