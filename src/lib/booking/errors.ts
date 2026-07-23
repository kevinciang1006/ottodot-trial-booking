/** Base for every error the service raises deliberately. Each carries the HTTP
 *  status a route handler should map it to, so routes contain no error logic. */
export abstract class DomainError extends Error {
  abstract readonly status: number
  abstract readonly code: string

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class ValidationError extends DomainError {
  readonly status = 400
  readonly code = 'validation_error'
}

export class NotFoundError extends DomainError {
  readonly status = 404
  readonly code = 'not_found'
}

export class DuplicateBookingError extends DomainError {
  readonly status = 409
  readonly code = 'duplicate_booking'

  constructor() {
    super('This child already has a live booking for this class.')
  }
}

export class IdempotencyKeyReuseError extends DomainError {
  readonly status = 409
  readonly code = 'idempotency_key_reuse'

  constructor() {
    super('This Idempotency-Key was already used for a different booking.')
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError
}

const PG_UNIQUE_VIOLATION = '23505'

/**
 * True when `error` is a Postgres unique-violation raised by a named index.
 * Written without `any`: pg errors are untyped at the boundary, so the shape is
 * narrowed explicitly.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  return candidate.code === PG_UNIQUE_VIOLATION && candidate.constraint === constraint
}
