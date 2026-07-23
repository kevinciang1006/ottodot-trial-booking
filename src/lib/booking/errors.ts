/** Base for every error the service raises deliberately. Each carries the HTTP
 *  status a route handler should map it to, so routes contain no error logic. */
export abstract class DomainError extends Error {
  abstract readonly status: number
  abstract readonly code: string

  /** Extra structured fields to include in the error response body. Defaults to
   *  nothing; subclasses override when they carry data a client can act on. */
  get details(): Record<string, unknown> | undefined {
    return undefined
  }

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

  /** The live booking that blocked the insert, so the UI can redirect the user
   *  to it (pay if pending, view status if confirmed) instead of dead-ending.
   *  Optional: absent if the recovery read found nothing. */
  constructor(readonly existingBookingId?: string) {
    super('This child already has a live booking for this class.')
  }

  get details(): Record<string, unknown> | undefined {
    return this.existingBookingId
      ? { existingBookingId: this.existingBookingId }
      : undefined
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

/** Maps a thrown value to an HTTP response. This is the ONLY error logic in the
 *  API layer — route handlers just call it. */
export function toErrorResponse(error: unknown): Response {
  if (isDomainError(error)) {
    return Response.json(
      { error: { code: error.code, message: error.message, ...(error.details ?? {}) } },
      { status: error.status },
    )
  }
  console.error('Unhandled error in route handler:', error)
  return Response.json(
    { error: { code: 'internal_error', message: 'Something went wrong.' } },
    { status: 500 },
  )
}

/**
 * Narrows a parsed JSON body to an indexable record without a cast.
 * Every property then reads as `unknown`, which forces each route to check the
 * field's type explicitly before use — so a malformed body produces a typed
 * ValidationError (400) rather than a TypeError (500).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
