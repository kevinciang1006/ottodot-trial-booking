import { describe, expect, it } from 'vitest'
import { getPool } from '@/lib/db'
import type { BookingStatus } from '@/lib/types'
import { IdempotencyKeyReuseError } from '@/lib/booking/errors'
import { bookAsUser, CLASSES, payAsUser, STUDENTS } from './setup'

function tally(statuses: BookingStatus[]): Record<string, number> {
  return statuses.reduce<Record<string, number>>((acc, status) => {
    acc[status] = (acc[status] ?? 0) + 1
    return acc
  }, {})
}

describe('the last-seat race', () => {
  it('lets exactly one of two simultaneous payments confirm', async () => {
    // The seeded race class holds 3 of 4 confirmed. One seat remains.
    const [bookingA, bookingB] = await Promise.all([
      bookAsUser(STUDENTS.ethan, CLASSES.lastSeat),
      bookAsUser(STUDENTS.priya, CLASSES.lastSeat),
    ])

    // Both now hold pending_payment. PENDING DOES NOT RESERVE A SEAT — this is
    // exactly the brief's scenario, where B can select the slot A is already
    // paying for.
    const results = await Promise.all([
      payAsUser(bookingA.id, 'race-a', 'pm_ok'),
      payAsUser(bookingB.id, 'race-b', 'pm_ok'),
    ])

    // Sorted comparison, never positional. Which actor wins is genuinely
    // nondeterministic; asserting "A wins" would be a flaky test that also
    // misstates the guarantee being made.
    const statuses = results.map((r) => r.booking.status).sort()
    expect(statuses).toEqual(['cancelled_class_full', 'confirmed'])

    // And the loser is not charged.
    expect(results.filter((r) => r.charged)).toHaveLength(1)
    const loser = results.find((r) => r.booking.status === 'cancelled_class_full')
    expect(loser?.outcome).toBe('voided')
    expect(loser?.charged).toBe(false)
  })
})

describe('overbooking under load', () => {
  it('confirms exactly four of six simultaneous payments on a 4-seat class', async () => {
    const studentIds = Object.values(STUDENTS)
    expect(studentIds).toHaveLength(6)

    const bookings = await Promise.all(
      studentIds.map((studentId) => bookAsUser(studentId, CLASSES.empty)),
    )

    const results = await Promise.all(
      bookings.map((booking, index) => payAsUser(booking.id, `load-${index}`, 'pm_ok')),
    )

    expect(tally(results.map((r) => r.booking.status))).toEqual({
      confirmed: 4,
      cancelled_class_full: 2,
    })
    expect(results.filter((r) => r.charged)).toHaveLength(4)
  })
})

describe('cross-booking idempotency-key reuse under concurrency', () => {
  it('translates a concurrent duplicate-key INSERT into IdempotencyKeyReuseError, not a raw Postgres error', async () => {
    // Two different students, two different bookings, on a class with spare
    // capacity — capacity contention is not what this test is about.
    const booking1 = await bookAsUser(STUDENTS.nadia, CLASSES.available)
    const booking2 = await bookAsUser(STUDENTS.omar, CLASSES.available)

    const sharedKey = 'cross-booking-race-key'

    // Connection A: check out a client DIRECTLY from the pool (not through
    // withTransaction/payAsUser), so we control exactly when it commits. It
    // inserts booking1's payment_attempts row for the shared key and then
    // holds the transaction open — simulating "authorized, about to record,
    // not yet committed".
    const clientA = await getPool().connect()
    try {
      await clientA.query('BEGIN')
      await clientA.query(
        `INSERT INTO payment_attempts
           (booking_id, idempotency_key, outcome, amount_cents, provider_ref)
         VALUES ($1, $2, 'captured', 500, 'prov-a')`,
        [booking1.id, sharedKey],
      )

      // Start payAsUser for booking2 on its OWN connection, reusing the same
      // key. Its lookup SELECT runs under READ COMMITTED and cannot see A's
      // uncommitted insert, so it passes that check, authorizes against the
      // gateway, and then blocks trying to insert its own payment_attempts row
      // with the same idempotency_key — behind A's still-open transaction.
      const pending = payAsUser(booking2.id, sharedKey, 'pm_ok')

      // Give the second call a moment to reach and block on the insert before
      // we commit A. This is not required for correctness (the assertion
      // below holds regardless of interleaving), but it keeps the scenario
      // honest to the brief: B must have already passed its SELECT before A
      // commits.
      await new Promise((resolve) => setTimeout(resolve, 50))

      await clientA.query('COMMIT')

      // Now that A has committed, B's insert fails on payment_attempts_idem.
      // That violation must surface as the typed domain error, never as a raw
      // SQLSTATE 23505.
      await expect(pending).rejects.toBeInstanceOf(IdempotencyKeyReuseError)
    } finally {
      // Always release, even if the assertion above throws — a leaked client
      // would starve the pool (max 10) for every later test.
      clientA.release()
    }
  }, 15_000)
})
