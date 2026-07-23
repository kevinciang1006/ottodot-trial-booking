import type { PoolClient } from 'pg'
import {
  DuplicateBookingError,
  IdempotencyKeyReuseError,
  NotFoundError,
  ValidationError,
  isUniqueViolation,
} from '@/lib/booking/errors'
import { authorize, capture, voidAuthorization } from '@/lib/payments/gateway'
import type {
  Booking,
  BookingStatus,
  ParentWithStudents,
  PayResult,
  PaymentOutcome,
  RosterEntry,
  StudentSummary,
  TrialClassSummary,
} from '@/lib/types'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new ValidationError(`${field} must be a UUID.`)
  }
}

interface BookingRow {
  id: string
  trial_class_id: string
  student_id: string
  status: BookingStatus
  created_at: Date
  updated_at: Date
}

const BOOKING_COLUMNS =
  'id, trial_class_id, student_id, status, created_at, updated_at'

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    trialClassId: row.trial_class_id,
    studentId: row.student_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export async function createBooking(
  client: PoolClient,
  input: { studentId: string; trialClassId: string },
): Promise<Booking> {
  assertUuid(input.studentId, 'studentId')
  assertUuid(input.trialClassId, 'trialClassId')

  // Existence checks so a bad id produces a clean 404 rather than a raw
  // foreign-key error. These are NOT the duplicate check — see below.
  const cls = await client.query('SELECT 1 FROM trial_classes WHERE id = $1', [
    input.trialClassId,
  ])
  if (cls.rowCount === 0) throw new NotFoundError('Trial class not found.')

  const student = await client.query('SELECT 1 FROM students WHERE id = $1', [
    input.studentId,
  ])
  if (student.rowCount === 0) throw new NotFoundError('Student not found.')

  try {
    const result = await client.query<BookingRow>(
      `INSERT INTO bookings (trial_class_id, student_id, status)
            VALUES ($1, $2, 'pending_payment')
         RETURNING ${BOOKING_COLUMNS}`,
      [input.trialClassId, input.studentId],
    )
    const row = result.rows[0]
    if (!row) throw new Error('INSERT ... RETURNING produced no row')
    return toBooking(row)
  } catch (error) {
    // The partial unique index decides, not a prior SELECT. A check-then-insert
    // has a TOCTOU window that two concurrent requests can both pass.
    if (isUniqueViolation(error, 'bookings_active_unique')) {
      throw new DuplicateBookingError()
    }
    throw error
  }
}

export async function getBooking(
  client: PoolClient,
  bookingId: string,
): Promise<Booking> {
  assertUuid(bookingId, 'bookingId')
  const result = await client.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`,
    [bookingId],
  )
  const row = result.rows[0]
  if (!row) throw new NotFoundError('Booking not found.')
  return toBooking(row)
}

export async function listTrialClasses(
  client: PoolClient,
): Promise<TrialClassSummary[]> {
  // seats_remaining is DERIVED from confirmed bookings on every read. There is
  // no counter column to drift out of sync.
  const result = await client.query<{
    id: string
    title: string
    subject: string
    starts_at: Date
    capacity: number
    price_cents: number
    confirmed_count: number
  }>(
    `SELECT c.id,
            c.title,
            c.subject,
            c.starts_at,
            c.capacity,
            c.price_cents,
            (count(b.id) FILTER (WHERE b.status = 'confirmed'))::int AS confirmed_count
       FROM trial_classes c
       LEFT JOIN bookings b ON b.trial_class_id = c.id
      GROUP BY c.id
      ORDER BY c.starts_at`,
  )
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    subject: row.subject,
    startsAt: row.starts_at.toISOString(),
    capacity: row.capacity,
    priceCents: row.price_cents,
    confirmedCount: row.confirmed_count,
    seatsRemaining: Math.max(row.capacity - row.confirmed_count, 0),
  }))
}

export async function getRoster(
  client: PoolClient,
  trialClassId: string,
): Promise<RosterEntry[]> {
  assertUuid(trialClassId, 'trialClassId')
  // 'confirmed' ONLY. A payment_failed or cancelled_class_full booking must
  // never appear on a roster — that is the third hazard in the brief.
  const result = await client.query<{
    booking_id: string
    student_id: string
    full_name: string
    grade_level: number
    updated_at: Date
  }>(
    `SELECT b.id AS booking_id,
            s.id AS student_id,
            s.full_name,
            s.grade_level,
            b.updated_at
       FROM bookings b
       JOIN students s ON s.id = b.student_id
      WHERE b.trial_class_id = $1
        AND b.status = 'confirmed'
      ORDER BY b.updated_at, b.id`,
    [trialClassId],
  )
  return result.rows.map((row) => ({
    bookingId: row.booking_id,
    studentId: row.student_id,
    studentName: row.full_name,
    gradeLevel: row.grade_level,
    confirmedAt: row.updated_at.toISOString(),
  }))
}

export async function listParentsWithStudents(
  client: PoolClient,
): Promise<ParentWithStudents[]> {
  const result = await client.query<{
    id: string
    full_name: string
    email: string
    students: StudentSummary[] | null
  }>(
    `SELECT p.id,
            p.full_name,
            p.email,
            coalesce(
              json_agg(
                json_build_object(
                  'id', s.id,
                  'fullName', s.full_name,
                  'gradeLevel', s.grade_level
                ) ORDER BY s.full_name
              ) FILTER (WHERE s.id IS NOT NULL),
              '[]'::json
            ) AS students
       FROM parents p
       LEFT JOIN students s ON s.parent_id = p.id
      GROUP BY p.id
      ORDER BY p.full_name`,
  )
  return result.rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    students: row.students ?? [],
  }))
}

/** One message per terminal status, shared by fresh results and idempotent
 *  replays so a replay can never describe the outcome differently. */
const STATUS_MESSAGES: Record<BookingStatus, string> = {
  pending_payment: 'Awaiting payment.',
  confirmed: 'Payment received. The trial class is confirmed.',
  payment_failed:
    'Payment was declined. No seat was taken and you were not charged. You can try booking again.',
  cancelled_class_full:
    'This class filled up while your payment was being processed. Your card was authorized but never charged, and the authorization has been released.',
  cancelled: 'This booking was cancelled.',
}

function toPayResult(booking: Booking, outcome: PaymentOutcome | null): PayResult {
  return {
    booking,
    outcome,
    charged: booking.status === 'confirmed',
    message: STATUS_MESSAGES[booking.status],
  }
}

async function recordAttempt(
  client: PoolClient,
  input: {
    bookingId: string
    idempotencyKey: string
    outcome: PaymentOutcome
    amountCents: number
    providerRef: string | null
  },
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO payment_attempts
         (booking_id, idempotency_key, outcome, amount_cents, provider_ref)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.bookingId,
        input.idempotencyKey,
        input.outcome,
        input.amountCents,
        input.providerRef,
      ],
    )
  } catch (error) {
    // The lookup SELECT in payForBooking runs under READ COMMITTED and cannot
    // see a peer transaction's uncommitted insert, so two requests reusing the
    // same key on DIFFERENT bookings both pass that check and both land here.
    // The unique index is what actually decides under concurrency: the loser
    // must surface as a typed 409, never a raw SQLSTATE 23505.
    if (isUniqueViolation(error, 'payment_attempts_idem')) {
      throw new IdempotencyKeyReuseError()
    }
    throw error
  }
}

async function setStatus(
  client: PoolClient,
  bookingId: string,
  status: BookingStatus,
): Promise<Booking> {
  const result = await client.query<BookingRow>(
    `UPDATE bookings SET status = $2 WHERE id = $1 RETURNING ${BOOKING_COLUMNS}`,
    [bookingId, status],
  )
  const row = result.rows[0]
  if (!row) throw new NotFoundError('Booking not found.')
  return toBooking(row)
}

async function latestOutcome(
  client: PoolClient,
  bookingId: string,
): Promise<PaymentOutcome | null> {
  // At most one payment_attempts row exists per booking in this design, so
  // this ORDER BY is a safety net rather than a guarantee of determinism: `id`
  // is a random gen_random_uuid() and `created_at` defaults to the enclosing
  // transaction's start time, so two rows written in one transaction would
  // tie on created_at and then order randomly on id anyway.
  const result = await client.query<{ outcome: PaymentOutcome }>(
    `SELECT outcome FROM payment_attempts
      WHERE booking_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [bookingId],
  )
  return result.rows[0]?.outcome ?? null
}

/**
 * Claims a seat and settles payment, in one transaction.
 *
 * LOCK ORDER: booking, then class. Always, in every path. That fixed order is
 * what makes deadlock impossible.
 *
 * The sequence is authorize -> claim -> capture rather than charge -> claim.
 * A payment provider is an external network call and cannot participate in a
 * database transaction, so capturing money before securing the seat would leave
 * the race loser charged for a class they never got, and recovery would become
 * a refund workflow. Splitting authorize from capture moves the money decision
 * after the seat decision, so the loser's authorization is simply voided.
 *
 * Accepted tradeoff: capture() (and, on the race-lost path, voidAuthorization())
 * run while the class row is still locked, so on a hot class every claimant
 * queues behind the current claimant's gateway round-trip, and a hung gateway
 * call pins the seat gate for as long as it hangs. That is inherent to
 * deciding the money outcome inside the seat transaction rather than after it.
 */
export async function payForBooking(
  client: PoolClient,
  input: { bookingId: string; idempotencyKey: string; cardToken: string },
): Promise<PayResult> {
  assertUuid(input.bookingId, 'bookingId')
  if (input.idempotencyKey.trim() === '') {
    throw new ValidationError('An Idempotency-Key is required.')
  }
  if (input.cardToken.trim() === '') {
    throw new ValidationError('A cardToken is required.')
  }

  // ---- Lock 1 of 2: the booking. -----------------------------------------
  // Serializes concurrent retries of the SAME booking against each other.
  const bookingResult = await client.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1 FOR UPDATE`,
    [input.bookingId],
  )
  const bookingRow = bookingResult.rows[0]
  if (!bookingRow) throw new NotFoundError('Booking not found.')

  // Idempotent replay: this booking already reached a terminal state, so return
  // that outcome unchanged rather than charging again.
  if (bookingRow.status !== 'pending_payment') {
    return toPayResult(
      toBooking(bookingRow),
      await latestOutcome(client, bookingRow.id),
    )
  }

  // Idempotency key. The unique index on payment_attempts.idempotency_key is
  // GLOBAL, so a key seen before may belong to another booking entirely. This
  // SELECT distinguishes the two cases under normal sequencing — same-booking
  // replay (return the prior outcome below) vs. cross-booking reuse (a caller
  // bug) — but it runs under READ COMMITTED and cannot see a concurrent peer's
  // uncommitted insert. Two requests racing on one key across different
  // bookings both read no prior row here; the payment_attempts_idem unique
  // index inside recordAttempt is what actually decides who wins.
  const priorResult = await client.query<{
    booking_id: string
    outcome: PaymentOutcome
  }>(
    'SELECT booking_id, outcome FROM payment_attempts WHERE idempotency_key = $1',
    [input.idempotencyKey],
  )
  const prior = priorResult.rows[0]
  if (prior) {
    if (prior.booking_id !== bookingRow.id) {
      // Same key, different booking: the caller has a bug. Returning another
      // booking's outcome would be worse than failing loudly.
      throw new IdempotencyKeyReuseError()
    }
    return toPayResult(toBooking(bookingRow), prior.outcome)
  }

  // Plain read, NO lock. Reading the price must not take the seat gate: a card
  // that is about to be declined has no business contending for the class row.
  const priceResult = await client.query<{ price_cents: number }>(
    'SELECT price_cents FROM trial_classes WHERE id = $1',
    [bookingRow.trial_class_id],
  )
  const priceRow = priceResult.rows[0]
  if (!priceRow) throw new NotFoundError('Trial class not found.')

  const auth = await authorize(priceRow.price_cents, input.cardToken)

  if (!auth.ok) {
    await recordAttempt(client, {
      bookingId: bookingRow.id,
      idempotencyKey: input.idempotencyKey,
      outcome: 'failed',
      amountCents: priceRow.price_cents,
      providerRef: null,
    })
    // NO CLASS ROW IS TOUCHED. A declined card never consumes a seat and never
    // contends for the class lock.
    return toPayResult(await setStatus(client, bookingRow.id, 'payment_failed'), 'failed')
  }

  // ---- Lock 2 of 2: the class. The seat gate. -----------------------------
  // Concurrent claims on the same class serialize HERE. Taken after the booking
  // lock, always.
  const classResult = await client.query<{ capacity: number }>(
    'SELECT capacity FROM trial_classes WHERE id = $1 FOR UPDATE',
    [bookingRow.trial_class_id],
  )
  const classRow = classResult.rows[0]
  if (!classRow) throw new NotFoundError('Trial class not found.')

  // Counted under the lock, from confirmed bookings — the single source of truth.
  const countResult = await client.query<{ confirmed: number }>(
    `SELECT count(*)::int AS confirmed
       FROM bookings
      WHERE trial_class_id = $1 AND status = 'confirmed'`,
    [bookingRow.trial_class_id],
  )
  const confirmed = countResult.rows[0]?.confirmed ?? 0

  if (confirmed >= classRow.capacity) {
    // Lost the race. Void the authorization so no money ever moves.
    await voidAuthorization(auth.providerRef)
    await recordAttempt(client, {
      bookingId: bookingRow.id,
      idempotencyKey: input.idempotencyKey,
      outcome: 'voided',
      amountCents: priceRow.price_cents,
      providerRef: auth.providerRef,
    })
    return toPayResult(
      await setStatus(client, bookingRow.id, 'cancelled_class_full'),
      'voided',
    )
  }

  // Recorded BEFORE capture(), unlike the race-lost path above: if capture()
  // ran first and this insert then failed (e.g. a concurrent cross-booking
  // key reuse hitting payment_attempts_idem), the card would already be
  // charged with no payment_attempts row and the booking stuck in
  // pending_payment. Recording first means a failure here instead leaves an
  // uncaptured authorization, which simply expires.
  try {
    await recordAttempt(client, {
      bookingId: bookingRow.id,
      idempotencyKey: input.idempotencyKey,
      outcome: 'captured',
      amountCents: priceRow.price_cents,
      providerRef: auth.providerRef,
    })
  } catch (error) {
    // The attempt was never recorded, so the authorization is still open —
    // neither captured nor voided. Release it before propagating so nothing
    // is stranded.
    await voidAuthorization(auth.providerRef)
    throw error
  }
  await capture(auth.providerRef)
  return toPayResult(await setStatus(client, bookingRow.id, 'confirmed'), 'captured')
}
