import { HttpStatus } from '@nestjs/common';

/** Catalogue des erreurs métier normalisées (backend.md §18.2) + quelques codes techniques. */
export const ERROR_STATUS: Record<string, number> = {
  AUTH_REQUIRED: 401,
  SESSION_REVOKED: 401,
  INVALID_CREDENTIALS: 401,
  UNTRUSTED_DEVICE: 403,
  FORBIDDEN: 403,
  RECOVERY_READ_ONLY: 403,
  STEP_UP_REQUIRED: 403,
  SIGNED_APPROVAL_INVALID: 403,
  SIGNED_APPROVAL_EXPIRED: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  RESOURCE_VERSION_CONFLICT: 409,
  IDEMPOTENCY_PAYLOAD_MISMATCH: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  PAYMENT_STATE_CONFLICT: 409,
  STATE_CONFLICT: 409,
  SYNC_CONFLICT: 409,
  ALREADY_EXISTS: 409,
  INSUFFICIENT_CONFIRMED_FUNDS: 422,
  INSUFFICIENT_ALLOCATABLE_FUNDS: 422,
  LIMIT_PER_OPERATION_EXCEEDED: 422,
  LIMIT_ROLLING_WINDOW_EXCEEDED: 422,
  LIMIT_CHANGE_PENDING: 409,
  EXCEPTION_NOT_ACTIVE: 422,
  EXCEPTION_EXPIRED: 422,
  EXCEPTION_CONSUMED: 422,
  BENEFICIARY_UNVERIFIED_CONFIRMATION_REQUIRED: 422,
  BENEFICIARY_NOT_SUPPORTED: 422,
  SAVINGS_WITHDRAWAL_DELAY: 422,
  SAVINGS_CAP_EXCEEDED: 422,
  SAVINGS_TARGET_NOT_REACHED: 422,
  BUSINESS_RULE_VIOLATION: 422,
  BALANCE_RECONCILIATION_BLOCK: 423,
  PSP_NOT_AUTHORIZED: 422,
  PSP_UNAVAILABLE: 503,
  PAYMENT_RESULT_UNKNOWN: 202,
  IMPORT_DUPLICATE_SUSPECTED: 409,
  SYNC_CONFIRMATION_REQUIRED: 409,
  MARKET_DATA_STALE: 200,
  DOCUMENT_ACCESS_DENIED: 403,
  DOCUMENT_STORAGE_NOT_CONFIGURED: 503,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly retryable = false,
  ) {
    super(message);
  }
  get status(): number {
    return ERROR_STATUS[this.code] ?? HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

export const notFound = (what = 'Ressource') => new DomainError('NOT_FOUND', `${what} introuvable`);
export const conflict = (msg: string, details: Record<string, unknown> = {}) =>
  new DomainError('STATE_CONFLICT', msg, details);
export const rule = (msg: string, details: Record<string, unknown> = {}) =>
  new DomainError('BUSINESS_RULE_VIOLATION', msg, details);
