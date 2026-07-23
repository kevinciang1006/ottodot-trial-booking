import type { PoolClient } from 'pg'
import {
  DuplicateBookingError,
  NotFoundError,
  ValidationError,
  isUniqueViolation,
} from '@/lib/booking/errors'
import type {
  Booking,
  BookingStatus,
  ParentWithStudents,
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
