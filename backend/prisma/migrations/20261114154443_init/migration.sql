-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('STARTED', 'VERIFIED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "LimitChangeStatus" AS ENUM ('PENDING', 'APPLIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExceptionState" AS ENUM ('WAITING', 'ACTIVE', 'CONSUMED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LedgerAccountKind" AS ENUM ('ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'EQUITY', 'ALLOCATION', 'ALLOCATION_POOL', 'CLEARING');

-- CreateEnum
CREATE TYPE "LedgerBook" AS ENUM ('REAL', 'ALLOCATION');

-- CreateEnum
CREATE TYPE "FinancialAccountType" AS ENUM ('CONTROLLED_PSP', 'EXTERNAL_TRACKED', 'BROKER_CASH', 'CASH_MANUAL');

-- CreateEnum
CREATE TYPE "BalanceVerification" AS ENUM ('PROVIDER_VERIFIED', 'DOCUMENT_VERIFIED', 'USER_DECLARED', 'STALE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RealBalanceStatus" AS ENUM ('ACTIVE', 'BLOCKED_OUTBOUND');

-- CreateEnum
CREATE TYPE "WalletKind" AS ENUM ('CURRENT', 'SAVINGS', 'RESERVE');

-- CreateEnum
CREATE TYPE "ReservationState" AS ENUM ('ACTIVE', 'SETTLED', 'RELEASED');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('PAYIN', 'PAYOUT');

-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('DRAFT', 'AWAITING_CONFIRMATION', 'AUTHORIZED', 'RESERVED', 'SUBMITTING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN', 'REFUNDED_AFTER_SUCCESS');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED_WITH_EVIDENCE');

-- CreateEnum
CREATE TYPE "CycleState" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "locale" TEXT NOT NULL DEFAULT 'fr',
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Porto-Novo',
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustedDevice" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "keyAlgorithm" TEXT NOT NULL DEFAULT 'Ed25519',
    "fingerprint" TEXT NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceApproval" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "candidateDeviceId" UUID NOT NULL,
    "approverDeviceId" UUID,
    "challengeHash" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'TRUSTED_DEVICE',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "deviceId" UUID,
    "refreshTokenHash" TEXT NOT NULL,
    "familyId" UUID NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "rotatedAt" TIMESTAMPTZ(3),
    "revokeReason" TEXT,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "generatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCase" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMPTZ(3),
    "financialReadOnlyUntil" TIMESTAMPTZ(3),
    "revokedSessionsAt" TIMESTAMPTZ(3),
    "status" "RecoveryStatus" NOT NULL DEFAULT 'STARTED',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" UUID NOT NULL,
    "ownerId" UUID,
    "actorDeviceId" UUID,
    "type" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "ipMetadata" TEXT,
    "decision" TEXT NOT NULL,
    "evidenceHash" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "ownerId" UUID,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "decision" TEXT NOT NULL,
    "contextRedacted" JSONB NOT NULL DEFAULT '{}',
    "correlationId" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LimitPolicy" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "perOperationMinor" BIGINT NOT NULL,
    "rolling24hMinor" BIGINT NOT NULL,
    "referencePerOperationMinor" BIGINT NOT NULL,
    "referenceRolling24hMinor" BIGINT NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "status" "PolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "policyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LimitPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LimitChangeRequest" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "oldPolicyId" UUID NOT NULL,
    "proposedPerOperation" BIGINT NOT NULL,
    "proposedRolling24h" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "LimitChangeStatus" NOT NULL DEFAULT 'PENDING',
    "authorizationId" UUID,
    "appliedPolicyId" UUID,

    CONSTRAINT "LimitChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExceptionAuthorization" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "maxDebitMinor" BIGINT NOT NULL,
    "beneficiaryBinding" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "activeFrom" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "state" "ExceptionState" NOT NULL DEFAULT 'WAITING',
    "proofRef" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ExceptionAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignedApproval" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "operationDigest" TEXT NOT NULL,
    "challengeNonceHash" TEXT NOT NULL,
    "signatureDigest" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "policySnapshot" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignedApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LedgerAccountKind" NOT NULL,
    "book" "LedgerBook" NOT NULL DEFAULT 'REAL',
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "parentId" UUID,
    "isPostingAllowed" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerTransaction" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "book" "LedgerBook" NOT NULL DEFAULT 'REAL',
    "businessType" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "postingPurpose" TEXT NOT NULL DEFAULT 'MAIN',
    "externalCorrelationId" TEXT,
    "postedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "economicDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "reversalOfId" UUID,
    "memo" TEXT,
    "source" TEXT NOT NULL DEFAULT 'OWNER',
    "actorDeviceId" UUID,
    "sequence" BIGSERIAL NOT NULL,

    CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerPosting" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "ledgerAccountId" UUID NOT NULL,
    "signedAmountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "postingOrdinal" INTEGER NOT NULL,

    CONSTRAINT "LedgerPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountBalance" (
    "ledgerAccountId" UUID NOT NULL,
    "balanceMinor" BIGINT NOT NULL DEFAULT 0,
    "ledgerSequence" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccountBalance_pkey" PRIMARY KEY ("ledgerAccountId")
);

-- CreateTable
CREATE TABLE "FinancialAccount" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "ledgerAccountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "institution" TEXT,
    "type" "FinancialAccountType" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "providerAccountId" TEXT,
    "realBalanceGroupId" UUID,
    "ownership" TEXT NOT NULL DEFAULT 'OWNER',
    "verificationLevel" "BalanceVerification" NOT NULL DEFAULT 'USER_DECLARED',
    "lastVerifiedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "includeInSpendable" BOOLEAN NOT NULL DEFAULT true,
    "colorHint" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "FinancialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RealBalanceGroup" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "providerId" TEXT,
    "providerBalanceRef" TEXT,
    "verifiedBalanceMinor" BIGINT,
    "verifiedAt" TIMESTAMPTZ(3),
    "status" "RealBalanceStatus" NOT NULL DEFAULT 'ACTIVE',
    "blockReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealBalanceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderBalanceSnapshot" (
    "id" UUID NOT NULL,
    "realBalanceGroupId" UUID NOT NULL,
    "providerRef" TEXT NOT NULL,
    "balanceMinor" BIGINT NOT NULL,
    "asOf" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "rawDigest" TEXT NOT NULL,

    CONSTRAINT "ProviderBalanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "WalletKind" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "realBalanceGroupId" UUID,
    "allocationAccountId" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationReservation" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "walletId" UUID,
    "purposeType" TEXT NOT NULL,
    "purposeId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "state" "ReservationState" NOT NULL DEFAULT 'ACTIVE',
    "releasedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllocationReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundsHold" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "paymentIntentId" UUID NOT NULL,
    "realBalanceGroupId" UUID,
    "financialAccountId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "state" "ReservationState" NOT NULL DEFAULT 'ACTIVE',
    "settledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundsHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LimitHold" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "paymentIntentId" UUID NOT NULL,
    "amountDebitMinor" BIGINT NOT NULL,
    "windowAnchoredAt" TIMESTAMPTZ(3) NOT NULL,
    "state" "ReservationState" NOT NULL DEFAULT 'ACTIVE',
    "settledAt" TIMESTAMPTZ(3),
    "releasedAt" TIMESTAMPTZ(3),

    CONSTRAINT "LimitHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "sourceAccountId" UUID,
    "sourceWalletId" UUID,
    "destinationWalletId" UUID,
    "destinationAccountId" UUID,
    "beneficiaryId" UUID,
    "amountMode" TEXT NOT NULL,
    "amountNetMinor" BIGINT NOT NULL,
    "feeQuoteMinor" BIGINT NOT NULL,
    "totalDebitMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "state" "PaymentState" NOT NULL DEFAULT 'DRAFT',
    "executable" BOOLEAN NOT NULL DEFAULT false,
    "nonExecutableReason" TEXT,
    "currentAttemptId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "operationDigest" TEXT,
    "policyVersion" INTEGER,
    "exceptionId" UUID,
    "fundingStepId" UUID,
    "quoteExpiresAt" TIMESTAMPTZ(3),
    "authorizedAt" TIMESTAMPTZ(3),
    "executedAt" TIMESTAMPTZ(3),
    "purposeCategoryId" UUID,
    "clientReference" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "merchantRef" TEXT NOT NULL,
    "providerRef" TEXT,
    "state" TEXT NOT NULL,
    "submittedAt" TIMESTAMPTZ(3),
    "lastStatusCheckedAt" TIMESTAMPTZ(3),
    "statusCheckCount" INTEGER NOT NULL DEFAULT 0,
    "resultEvidenceRef" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderEvent" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "attemptId" UUID,
    "payloadDigest" TEXT NOT NULL,
    "payloadRedacted" JSONB NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "eventAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),
    "processState" TEXT NOT NULL DEFAULT 'RECEIVED',
    "processNote" TEXT,

    CONSTRAINT "ProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentStateHistory" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "from" "PaymentState",
    "to" "PaymentState" NOT NULL,
    "cause" TEXT NOT NULL,
    "evidenceRef" TEXT,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentStateHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Beneficiary" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "officialName" TEXT,
    "officialVerificationAt" TIMESTAMPTZ(3),
    "verificationSource" TEXT NOT NULL DEFAULT 'NONE',
    "isOwnAccount" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Beneficiary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PspAvailability" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL,
    "nextProbeAt" TIMESTAMPTZ(3) NOT NULL,
    "failureCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PspAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationCase" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "realBalanceGroupId" UUID,
    "financialAccountId" UUID,
    "expectedMinor" BIGINT NOT NULL,
    "observedMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'OPEN',
    "reason" TEXT NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolutionNote" TEXT,
    "resolutionPostingId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ReconciliationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationEvidence" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "providerRef" TEXT,
    "documentId" UUID,
    "note" TEXT,
    "digest" TEXT NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomeFundingPlan" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "incomeId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "lastCompletedStep" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncomeFundingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomeFundingStep" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "destinationWalletId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "paymentIntentId" UUID,
    "state" TEXT NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "IncomeFundingStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Income" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "nature" TEXT NOT NULL DEFAULT 'SALARY',
    "economicDate" DATE NOT NULL,
    "grossMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "mode" TEXT NOT NULL DEFAULT 'EXTERNAL_TRACKING',
    "recordingStatus" TEXT NOT NULL DEFAULT 'RECORDED',
    "categoryId" UUID,
    "cycleId" UUID,
    "externalRef" TEXT,
    "note" TEXT,
    "ledgerTransactionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Income_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomeAllocation" (
    "id" UUID NOT NULL,
    "incomeId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "suggestedBy" TEXT NOT NULL DEFAULT 'OWNER',

    CONSTRAINT "IncomeAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "ledgerTransactionId" UUID,
    "categoryId" UUID NOT NULL,
    "economicDate" DATE NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "label" TEXT NOT NULL,
    "merchant" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "externalRef" TEXT,
    "cycleId" UUID,
    "offCycle" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "parentId" UUID,
    "icon" TEXT,
    "essential" BOOLEAN NOT NULL DEFAULT false,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetCycle" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "startsAt" DATE NOT NULL,
    "plannedEndAt" DATE NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "state" "CycleState" NOT NULL DEFAULT 'OPEN',
    "openedManually" BOOLEAN NOT NULL DEFAULT true,
    "anchorIncomeId" UUID,
    "closingSnapshot" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "plannedMinor" BIGINT NOT NULL,
    "alertThreshold" INTEGER NOT NULL DEFAULT 80,
    "essential" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringObligation" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "scheduleRule" TEXT NOT NULL,
    "nextDueDate" DATE NOT NULL,
    "categoryId" UUID NOT NULL,
    "essential" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObligationOccurrence" (
    "id" UUID NOT NULL,
    "obligationId" UUID NOT NULL,
    "dueDate" DATE NOT NULL,
    "expectedMinor" BIGINT NOT NULL,
    "settledExpenseId" UUID,
    "state" TEXT NOT NULL DEFAULT 'FORECAST',

    CONSTRAINT "ObligationOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsGoal" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "targetMinor" BIGINT NOT NULL,
    "deadline" DATE NOT NULL,
    "protectionMode" TEXT NOT NULL DEFAULT 'ADVISORY',
    "protectionEvidenceRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deadlineHistory" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SavingsGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsContributionPlan" (
    "id" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "triggerType" TEXT NOT NULL,
    "amountRule" TEXT NOT NULL,
    "scheduleRule" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SavingsContributionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlannedContribution" (
    "id" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "dueAt" DATE NOT NULL,
    "plannedMinor" BIGINT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PLANNED',
    "kind" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "sourceIncomeId" UUID,
    "actualAllocationTxId" UUID,
    "confirmedMinor" BIGINT,
    "confirmedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PlannedContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsWithdrawalRequest" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "requestedMinor" BIGINT NOT NULL,
    "reason" TEXT,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "eligibleAt" TIMESTAMPTZ(3) NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "executedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "baseSnapshotMinor" BIGINT NOT NULL,
    "holdMinor" BIGINT NOT NULL,
    "allocationTxId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SavingsWithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Liability" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "counterpartyName" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "principalMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "interestTerms" TEXT,
    "startDate" DATE NOT NULL,
    "initialDueDate" DATE,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "ledgerAccountId" UUID,
    "cashAccountId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Liability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiabilityInstallment" (
    "id" UUID NOT NULL,
    "liabilityId" UUID NOT NULL,
    "dueDate" DATE NOT NULL,
    "principalDueMinor" BIGINT NOT NULL,
    "interestDueMinor" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "rescheduledFrom" UUID,
    "note" TEXT,

    CONSTRAINT "LiabilityInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repayment" (
    "id" UUID NOT NULL,
    "liabilityId" UUID NOT NULL,
    "paymentOrLedgerRef" TEXT,
    "cashAccountId" UUID NOT NULL,
    "principalMinor" BIGINT NOT NULL,
    "interestMinor" BIGINT NOT NULL DEFAULT 0,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "confirmedByOwner" BOOLEAN NOT NULL DEFAULT true,
    "at" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Repayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhysicalAsset" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "acquiredAt" DATE,
    "acquisitionCostMinor" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "ledgerAccountId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhysicalAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetValuation" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "valueMinor" BIGINT NOT NULL,
    "valuationDate" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "evidenceDocumentId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetValuation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broker" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "officialId" TEXT,
    "costBasisMethod" TEXT NOT NULL DEFAULT 'FALLBACK_WEIGHTED_AVERAGE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Broker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerageAccount" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "brokerId" UUID NOT NULL,
    "cashFinancialAccountId" UUID NOT NULL,
    "securitiesLedgerAccountId" UUID NOT NULL,
    "accountAlias" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',

    CONSTRAINT "BrokerageAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Security" (
    "id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "isin" TEXT,
    "market" TEXT NOT NULL DEFAULT 'BRVM',
    "name" TEXT NOT NULL,
    "sector" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "status" TEXT NOT NULL DEFAULT 'LISTED',
    "source" TEXT NOT NULL DEFAULT 'OWNER_ENTERED',
    "favoriteOwnerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Security_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "brokerageAccountId" UUID NOT NULL,
    "securityId" UUID NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" DECIMAL(28,10) NOT NULL,
    "unitPrice" DECIMAL(28,10) NOT NULL,
    "grossMinor" BIGINT NOT NULL,
    "feesMinor" BIGINT NOT NULL DEFAULT 0,
    "taxesMinor" BIGINT NOT NULL DEFAULT 0,
    "executedAt" TIMESTAMPTZ(3) NOT NULL,
    "settledAt" TIMESTAMPTZ(3),
    "evidenceRef" TEXT,
    "importRowId" UUID,
    "externalRef" TEXT,
    "realizedPnlMinor" BIGINT,
    "costMethod" TEXT NOT NULL,
    "ledgerTransactionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostBasisLot" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "tradeId" UUID NOT NULL,
    "brokerageAccountId" UUID NOT NULL,
    "securityId" UUID NOT NULL,
    "quantityRemaining" DECIMAL(28,10) NOT NULL,
    "costMinor" BIGINT NOT NULL,
    "method" TEXT NOT NULL,
    "officialStatus" TEXT NOT NULL,

    CONSTRAINT "CostBasisLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DividendAnnouncement" (
    "id" UUID NOT NULL,
    "securityId" UUID NOT NULL,
    "declaredPerShare" DECIMAL(28,10) NOT NULL,
    "exDate" DATE,
    "recordDate" DATE,
    "paymentDate" DATE,
    "source" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'OWNER_ENTERED',
    "status" TEXT NOT NULL DEFAULT 'ANNOUNCED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DividendAnnouncement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DividendEntitlement" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "announcementId" UUID NOT NULL,
    "brokerageAccountId" UUID NOT NULL,
    "quantityEligible" DECIMAL(28,10),
    "expectedMinor" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'ENTITLEMENT_EVALUATED',

    CONSTRAINT "DividendEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DividendReceipt" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "entitlementId" UUID,
    "cashLedgerTransactionId" UUID NOT NULL,
    "receivedMinor" BIGINT NOT NULL,
    "receivedAt" DATE NOT NULL,

    CONSTRAINT "DividendReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketQuote" (
    "id" UUID NOT NULL,
    "securityId" UUID NOT NULL,
    "price" DECIMAL(28,10) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XOF',
    "asOf" TIMESTAMPTZ(3) NOT NULL,
    "sessionDate" DATE NOT NULL,
    "sourceId" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchasePlan" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "securityId" UUID NOT NULL,
    "quantityTarget" DECIMAL(28,10),
    "budgetReservedMinor" BIGINT NOT NULL,
    "allocationReservationId" UUID,
    "targetDate" DATE,
    "note" TEXT,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchasePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceAlert" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "securityId" UUID NOT NULL,
    "triggerType" TEXT NOT NULL,
    "threshold" DECIMAL(28,10) NOT NULL,
    "lastTriggeredAt" TIMESTAMPTZ(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PriceAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAttachment" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "cipherKeyRef" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeDeclared" TEXT NOT NULL,
    "mimeDetected" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT,
    "linkedResource" TEXT,
    "retentionClass" TEXT NOT NULL DEFAULT 'DOCUMENT',
    "state" TEXT NOT NULL DEFAULT 'PENDING_UPLOAD',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAccessGrant" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DocumentAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "documentId" UUID,
    "sourceType" TEXT NOT NULL,
    "targetAccountId" UUID,
    "formatVersion" TEXT NOT NULL DEFAULT '1',
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "fileDigest" TEXT NOT NULL,
    "errorSummary" TEXT,
    "confirmedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "canonicalDigest" TEXT NOT NULL,
    "normalizedData" JSONB NOT NULL,
    "classification" TEXT NOT NULL,
    "validationErrors" TEXT,
    "matchedResourceId" TEXT,
    "decision" TEXT,
    "postedResourceId" TEXT,
    "postedTransactionId" UUID,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineDraftRecord" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "deviceId" UUID,
    "sessionFamilyId" UUID NOT NULL,
    "clientDraftId" TEXT NOT NULL,
    "targetResource" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "targetId" TEXT,
    "baseVersion" INTEGER,
    "payload" JSONB NOT NULL,
    "canonicalPayloadHash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "validation" JSONB NOT NULL DEFAULT '[]',
    "resultResourceId" TEXT,
    "confirmedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineDraftRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncEvent" (
    "sequence" BIGSERIAL NOT NULL,
    "ownerId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'OWNER',
    "version" INTEGER,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payloadDigest" TEXT NOT NULL,

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("sequence")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "titleKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "metadataSafe" JSONB NOT NULL DEFAULT '{}',
    "link" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMPTZ(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "deliveryIdempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMPTZ(3),

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "ownerId" UUID,
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "claimedAt" TIMESTAMPTZ(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "consumerName" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resultDigest" TEXT,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("consumerName","eventId")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" UUID NOT NULL,
    "job" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDevice_fingerprint_key" ON "TrustedDevice"("fingerprint");

-- CreateIndex
CREATE INDEX "TrustedDevice_ownerId_status_idx" ON "TrustedDevice"("ownerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceApproval_challengeHash_key" ON "DeviceApproval"("challengeHash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_ownerId_revokedAt_idx" ON "Session"("ownerId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_familyId_idx" ON "Session"("familyId");

-- CreateIndex
CREATE INDEX "RecoveryCode_ownerId_idx" ON "RecoveryCode"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCase_challengeHash_key" ON "RecoveryCase"("challengeHash");

-- CreateIndex
CREATE INDEX "SecurityEvent_ownerId_at_idx" ON "SecurityEvent"("ownerId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_ownerId_at_idx" ON "AuditEvent"("ownerId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "LimitPolicy_ownerId_policyVersion_key" ON "LimitPolicy"("ownerId", "policyVersion");

-- CreateIndex
CREATE INDEX "ExceptionAuthorization_ownerId_state_idx" ON "ExceptionAuthorization"("ownerId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "SignedApproval_challengeNonceHash_key" ON "SignedApproval"("challengeNonceHash");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_ownerId_code_key" ON "LedgerAccount"("ownerId", "code");

-- CreateIndex
CREATE INDEX "LedgerTransaction_ownerId_postedAt_id_idx" ON "LedgerTransaction"("ownerId", "postedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_businessType_businessId_postingPurpose_key" ON "LedgerTransaction"("businessType", "businessId", "postingPurpose");

-- CreateIndex
CREATE INDEX "LedgerPosting_ledgerAccountId_idx" ON "LedgerPosting"("ledgerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerPosting_transactionId_postingOrdinal_key" ON "LedgerPosting"("transactionId", "postingOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialAccount_ledgerAccountId_key" ON "FinancialAccount"("ledgerAccountId");

-- CreateIndex
CREATE INDEX "FinancialAccount_ownerId_status_idx" ON "FinancialAccount"("ownerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_allocationAccountId_key" ON "Wallet"("allocationAccountId");

-- CreateIndex
CREATE INDEX "Wallet_ownerId_kind_idx" ON "Wallet"("ownerId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationReservation_purposeType_purposeId_key" ON "AllocationReservation"("purposeType", "purposeId");

-- CreateIndex
CREATE UNIQUE INDEX "FundsHold_paymentIntentId_key" ON "FundsHold"("paymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "LimitHold_paymentIntentId_key" ON "LimitHold"("paymentIntentId");

-- CreateIndex
CREATE INDEX "LimitHold_ownerId_windowAnchoredAt_state_idx" ON "LimitHold"("ownerId", "windowAnchoredAt", "state");

-- CreateIndex
CREATE INDEX "PaymentIntent_ownerId_state_idx" ON "PaymentIntent"("ownerId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_ownerId_direction_idempotencyKey_key" ON "PaymentIntent"("ownerId", "direction", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_merchantRef_key" ON "PaymentAttempt"("merchantRef");

-- CreateIndex
CREATE INDEX "PaymentAttempt_provider_state_lastStatusCheckedAt_idx" ON "PaymentAttempt"("provider", "state", "lastStatusCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_provider_providerRef_key" ON "PaymentAttempt"("provider", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderEvent_provider_providerEventId_key" ON "ProviderEvent"("provider", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "Beneficiary_ownerId_phoneE164_operator_key" ON "Beneficiary"("ownerId", "phoneE164", "operator");

-- CreateIndex
CREATE UNIQUE INDEX "PspAvailability_provider_capability_key" ON "PspAvailability"("provider", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "IncomeFundingStep_planId_ordinal_key" ON "IncomeFundingStep"("planId", "ordinal");

-- CreateIndex
CREATE INDEX "Income_ownerId_economicDate_idx" ON "Income"("ownerId", "economicDate");

-- CreateIndex
CREATE INDEX "Expense_ownerId_economicDate_idx" ON "Expense"("ownerId", "economicDate");

-- CreateIndex
CREATE UNIQUE INDEX "Category_ownerId_type_name_key" ON "Category"("ownerId", "type", "name");

-- CreateIndex
CREATE INDEX "BudgetCycle_ownerId_state_idx" ON "BudgetCycle"("ownerId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_cycleId_categoryId_key" ON "Budget"("cycleId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ObligationOccurrence_settledExpenseId_key" ON "ObligationOccurrence"("settledExpenseId");

-- CreateIndex
CREATE UNIQUE INDEX "ObligationOccurrence_obligationId_dueDate_key" ON "ObligationOccurrence"("obligationId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "SavingsGoal_walletId_key" ON "SavingsGoal"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "SavingsContributionPlan_goalId_key" ON "SavingsContributionPlan"("goalId");

-- CreateIndex
CREATE UNIQUE INDEX "PlannedContribution_goalId_dueAt_kind_key" ON "PlannedContribution"("goalId", "dueAt", "kind");

-- CreateIndex
CREATE INDEX "SavingsWithdrawalRequest_goalId_requestedAt_status_idx" ON "SavingsWithdrawalRequest"("goalId", "requestedAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BrokerageAccount_cashFinancialAccountId_key" ON "BrokerageAccount"("cashFinancialAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "BrokerageAccount_securitiesLedgerAccountId_key" ON "BrokerageAccount"("securitiesLedgerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Security_symbol_key" ON "Security"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_importRowId_key" ON "Trade"("importRowId");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_brokerageAccountId_externalRef_key" ON "Trade"("brokerageAccountId", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "CostBasisLot_tradeId_key" ON "CostBasisLot"("tradeId");

-- CreateIndex
CREATE UNIQUE INDEX "DividendEntitlement_announcementId_brokerageAccountId_key" ON "DividendEntitlement"("announcementId", "brokerageAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "DividendReceipt_entitlementId_key" ON "DividendReceipt"("entitlementId");

-- CreateIndex
CREATE UNIQUE INDEX "DividendReceipt_cashLedgerTransactionId_key" ON "DividendReceipt"("cashLedgerTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketQuote_securityId_sessionDate_sourceId_key" ON "MarketQuote"("securityId", "sessionDate", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAttachment_storageKey_key" ON "DocumentAttachment"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAccessGrant_tokenHash_key" ON "DocumentAccessGrant"("tokenHash");

-- CreateIndex
CREATE INDEX "ImportRow_canonicalDigest_idx" ON "ImportRow"("canonicalDigest");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_batchId_rowNumber_key" ON "ImportRow"("batchId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineDraftRecord_sessionFamilyId_clientDraftId_key" ON "OfflineDraftRecord"("sessionFamilyId", "clientDraftId");

-- CreateIndex
CREATE INDEX "SyncEvent_ownerId_sequence_idx" ON "SyncEvent"("ownerId", "sequence");

-- CreateIndex
CREATE INDEX "Notification_ownerId_createdAt_idx" ON "Notification"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_ownerId_sourceEventId_key" ON "Notification"("ownerId", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_deliveryIdempotencyKey_key" ON "NotificationDelivery"("deliveryIdempotencyKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_createdAt_idx" ON "OutboxEvent"("publishedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_ownerId_operation_key_key" ON "IdempotencyRecord"("ownerId", "operation", "key");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_job_runKey_key" ON "JobRun"("job", "runKey");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "TrustedDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerPosting" ADD CONSTRAINT "LedgerPosting_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerPosting" ADD CONSTRAINT "LedgerPosting_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBalance" ADD CONSTRAINT "AccountBalance_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentStateHistory" ADD CONSTRAINT "PaymentStateHistory_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationEvidence" ADD CONSTRAINT "ReconciliationEvidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ReconciliationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomeFundingStep" ADD CONSTRAINT "IncomeFundingStep_planId_fkey" FOREIGN KEY ("planId") REFERENCES "IncomeFundingPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomeAllocation" ADD CONSTRAINT "IncomeAllocation_incomeId_fkey" FOREIGN KEY ("incomeId") REFERENCES "Income"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "BudgetCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObligationOccurrence" ADD CONSTRAINT "ObligationOccurrence_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "RecurringObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsContributionPlan" ADD CONSTRAINT "SavingsContributionPlan_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "SavingsGoal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedContribution" ADD CONSTRAINT "PlannedContribution_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "SavingsGoal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsWithdrawalRequest" ADD CONSTRAINT "SavingsWithdrawalRequest_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "SavingsGoal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiabilityInstallment" ADD CONSTRAINT "LiabilityInstallment_liabilityId_fkey" FOREIGN KEY ("liabilityId") REFERENCES "Liability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repayment" ADD CONSTRAINT "Repayment_liabilityId_fkey" FOREIGN KEY ("liabilityId") REFERENCES "Liability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetValuation" ADD CONSTRAINT "AssetValuation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PhysicalAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerageAccount" ADD CONSTRAINT "BrokerageAccount_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
