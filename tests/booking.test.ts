import { describe, expect, it } from 'vitest'
import { withTransaction } from '@/lib/db'
import {
  createBooking,
  getBooking,
  getRoster,
  listParentsWithStudents,
  listTrialClasses,
} from '@/lib/booking/service'
import { DuplicateBookingError, NotFoundError } from '@/lib/booking/errors'
import { CLASSES, STUDENTS } from './setup'

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

  it('rejects a second live booking for the same child and class', async () => {
    // Nadia is already confirmed on the duplicate class in the seed.
    await expect(
      withTransaction((c) =>
        createBooking(c, { studentId: STUDENTS.nadia, trialClassId: CLASSES.duplicate }),
      ),
    ).rejects.toBeInstanceOf(DuplicateBookingError)
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
