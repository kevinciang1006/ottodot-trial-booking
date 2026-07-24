import { describe, expect, it } from 'vitest'
import { getPool, withTransaction } from '@/lib/db'
import {
  createBooking,
  getBooking,
  getRoster,
  getStudent,
  listParentsWithStudents,
  listTrialClasses,
} from '@/lib/booking/service'
import {
  DuplicateBookingError,
  IdempotencyKeyReuseError,
  NotFoundError,
} from '@/lib/booking/errors'
import { bookAsUser, CLASSES, payAsUser, STUDENTS } from './setup'

describe('reads', () => {
  it('reports seats remaining from confirmed bookings only', async () => {
    const classes = await withTransaction((c) => listTrialClasses(c))
    const lastSeat = classes.find((c) => c.id === CLASSES.lastSeat)
    const failed = classes.find((c) => c.id === CLASSES.paymentFailed)

    expect(lastSeat?.confirmedCount).toBe(3)
    expect(lastSeat?.seatsRemaining).toBe(1)
    // A payment_failed booking must not consume a seat.
    expect(failed?.confirmedCount).toBe(0)
    expect(failed?.seatsRemaining).toBe(4)
  })

  it('excludes non-confirmed bookings from the roster', async () => {
    const roster = await withTransaction((c) => getRoster(c, CLASSES.paymentFailed))
    expect(roster).toEqual([])
  })

  it('lists each parent with their own children', async () => {
    const parents = await withTransaction((c) => listParentsWithStudents(c))
    expect(parents).toHaveLength(3)
    const aisha = parents.find((p) => p.fullName === 'Aisha Rahman')
    expect(aisha?.students.map((s) => s.fullName).sort()).toEqual([
      'Nadia Rahman',
      'Omar Rahman',
    ])
  })

  it('returns a student by id, and 404s on an unknown one', async () => {
    const student = await withTransaction((c) => getStudent(c, STUDENTS.nadia))
    expect(student.fullName).toBe('Nadia Rahman')
    expect(student.gradeLevel).toBe(4)

    await expect(
      withTransaction((c) => getStudent(c, '22222222-2222-2222-2222-2222222222ff')),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('createBooking', () => {
  it('creates a pending_payment booking', async () => {
    const booking = await withTransaction((c) =>
      createBooking(c, { studentId: STUDENTS.ethan, trialClassId: CLASSES.available }),
    )
    expect(booking.status).toBe('pending_payment')

    const fetched = await withTransaction((c) => getBooking(c, booking.id))
    expect(fetched.id).toBe(booking.id)
  })

  it('rejects a second live booking and points at the existing one', async () => {
    // Nadia is already confirmed on the duplicate class in the seed.
    const err = await withTransaction((c) =>
      createBooking(c, { studentId: STUDENTS.nadia, trialClassId: CLASSES.duplicate }),
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DuplicateBookingError)
    if (!(err instanceof DuplicateBookingError)) throw err
    // The 409 carries the blocking booking's id so the UI can redirect to it.
    // Nadia is seeded confirmed on Light and Shadow as booking …405.
    expect(err.existingBookingId).toBe('44444444-4444-4444-4444-444444444405')
  })

  it('allows rebooking after a failed payment', async () => {
    // Omar sits in payment_failed on this class. The partial index excludes
    // that status, so he may book again.
    const booking = await withTransaction((c) =>
      createBooking(c, {
        studentId: STUDENTS.omar,
        trialClassId: CLASSES.paymentFailed,
      }),
    )
    expect(booking.status).toBe('pending_payment')
  })

  it('404s on an unknown class', async () => {
    await expect(
      withTransaction((c) =>
        createBooking(c, {
          studentId: STUDENTS.ethan,
          trialClassId: '33333333-3333-3333-3333-3333333333ff',
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('payForBooking', () => {
  it('confirms the booking and puts the child on the roster', async () => {
    const booking = await bookAsUser(STUDENTS.ethan, CLASSES.available)
    const result = await payAsUser(booking.id, 'happy-1', 'pm_ok')

    expect(result.booking.status).toBe('confirmed')
    expect(result.outcome).toBe('captured')
    expect(result.charged).toBe(true)

    const roster = await withTransaction((c) => getRoster(c, CLASSES.available))
    expect(roster.map((r) => r.studentName)).toContain('Ethan Tan')
  })

  it('leaves a declined booking off the roster and consumes no seat', async () => {
    const booking = await bookAsUser(STUDENTS.ethan, CLASSES.available)
    const result = await payAsUser(booking.id, 'decline-1', 'pm_fail')

    expect(result.booking.status).toBe('payment_failed')
    expect(result.outcome).toBe('failed')
    expect(result.charged).toBe(false)

    const roster = await withTransaction((c) => getRoster(c, CLASSES.available))
    expect(roster.map((r) => r.studentName)).not.toContain('Ethan Tan')

    const classes = await withTransaction((c) => listTrialClasses(c))
    expect(classes.find((c) => c.id === CLASSES.available)?.confirmedCount).toBe(1)

    // And the child may book again — the partial index excludes payment_failed.
    const retry = await bookAsUser(STUDENTS.ethan, CLASSES.available)
    expect(retry.status).toBe('pending_payment')
  })

  it('replaying the same key charges once and returns the same outcome', async () => {
    const booking = await bookAsUser(STUDENTS.ethan, CLASSES.available)
    const first = await payAsUser(booking.id, 'idem-1', 'pm_ok')
    const second = await payAsUser(booking.id, 'idem-1', 'pm_ok')

    expect(first.booking.status).toBe('confirmed')
    expect(second.booking.status).toBe('confirmed')
    expect(second.charged).toBe(true)
    expect(second.outcome).toBe(first.outcome)

    const { rows } = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM payment_attempts WHERE booking_id = $1',
      [booking.id],
    )
    expect(rows[0]?.n).toBe(1)
  })

  it('rejects an idempotency key already used for a different booking', async () => {
    const first = await bookAsUser(STUDENTS.ethan, CLASSES.available)
    const second = await bookAsUser(STUDENTS.daniel, CLASSES.available)

    await payAsUser(first.id, 'shared-key', 'pm_ok')

    // Returning the other booking's outcome would be worse than failing loudly.
    await expect(
      payAsUser(second.id, 'shared-key', 'pm_ok'),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError)
  })

  it('404s on an unknown booking', async () => {
    await expect(
      payAsUser('44444444-4444-4444-4444-4444444444ff', 'missing-1', 'pm_ok'),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})
