import { describe, expect, it } from 'vitest'
import { getPool } from '@/lib/db'
import type { BookingStatus } from '@/lib/types'
import { IdempotencyKeyReuseError } from '@/lib/booking/errors'
import { bookAsUser, CLASSES, payAsUser, STUDENTS } from './setup'

/** Tallies any string-like field (booking status, payment outcome, ...) by its
 *  stringified value. Widened beyond BookingStatus so the same helper can also
 *  tally PaymentOutcome | null without a second, near-duplicate function. */
function tally(values: readonly (string | null)[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    const key = String(value)
    acc[key] = (acc[key] ?? 0) + 1
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

    // The `charged` assertion above is tautological: toPayResult derives
    // `charged` straight from `booking.status === 'confirmed'`, so it merely
    // restates the status tally two lines up rather than proving no money
    // moved for the losers. Pin the actual payment outcomes too.
    expect(tally(results.map((r) => r.outcome))).toEqual({
      captured: 4,
      voided: 2,
    })
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

      // A is idle-in-transaction, not itself waiting on anything, but its pid
      // is known and excluded below so the poll can never mistake A for the
      // blocked party it is trying to observe.
      const pidResult = await clientA.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )
      const pidA = pidResult.rows[0]?.pid
      if (pidA === undefined) {
        throw new Error('could not read pg_backend_pid() for connection A')
      }

      // Start payAsUser for booking2 on its OWN connection, reusing the same
      // key. Its lookup SELECT runs under READ COMMITTED and cannot see A's
      // uncommitted insert, so it passes that check, authorizes against the
      // gateway, and then blocks trying to insert its own payment_attempts row
      // with the same idempotency_key — behind A's still-open transaction.
      const pending = payAsUser(booking2.id, sharedKey, 'pm_ok')

      // Attach the rejection expectation immediately, before any further
      // await. If B ever rejects early for a reason other than the intended
      // one (see the polling wait below), Node fires `unhandledRejection`
      // before a handler exists whenever the handler is attached late, and
      // Vitest reports suite-level noise on top of the real assertion
      // failure — turning one clean failure into a confusing one.
      const assertion = expect(pending).rejects.toBeInstanceOf(IdempotencyKeyReuseError)

      // Wait until B is actually parked on A's uncommitted index entry,
      // rather than sleeping and hoping. `payForBooking` can throw
      // IdempotencyKeyReuseError from TWO places: its lookup SELECT (the
      // sequential path, already covered by tests/booking.test.ts) and
      // recordAttempt's INSERT catch (the concurrent path, which is the only
      // reason this test exists) — and both throw the identical error. If B
      // is slow to reach its INSERT (a loaded machine, a cold pool) and a
      // fixed sleep elapses first, A commits before B blocks, B's SELECT then
      // sees A's committed row, and B throws from the SELECT branch instead.
      // The assertion above would still pass, but the test would have gone
      // green while covering nothing new. Poll pg_stat_activity for the
      // observable state instead: B waits with wait_event_type = 'Lock' and
      // wait_event = 'transactionid'.
      //
      // Scoped to sessions other than A (pidA, known above) and other than
      // this polling connection itself (pg_backend_pid(), evaluated fresh on
      // whichever pooled connection runs this specific query). Without that
      // scoping, "any session waiting on a transactionid lock" is only safe
      // because fileParallelism: false keeps exactly these connections alive;
      // scoping by pid makes the observation precise rather than relying on
      // that global invariant holding.
      const deadline = Date.now() + 5_000
      let blocked = false
      while (Date.now() < deadline && !blocked) {
        const { rows } = await getPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid NOT IN ($1, pg_backend_pid())
              AND wait_event_type = 'Lock' AND wait_event = 'transactionid'`,
          [pidA],
        )
        blocked = (rows[0]?.n ?? 0) > 0
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(blocked, 'B must block on the unique index before A commits').toBe(true)

      // Now that B is genuinely blocked on A's uncommitted row, commit A.
      // B's insert then fails on payment_attempts_idem. That violation must
      // surface as the typed domain error, never as a raw SQLSTATE 23505.
      await clientA.query('COMMIT')

      await assertion

      // The rejection alone doesn't prove the rollback actually happened —
      // pin the resulting state: booking2 must still be pending_payment, and
      // payment_attempts must hold exactly one row for the shared key, owned
      // by booking1.
      const bookingResult = await getPool().query<{ status: BookingStatus }>(
        'SELECT status FROM bookings WHERE id = $1',
        [booking2.id],
      )
      expect(bookingResult.rows[0]?.status).toBe('pending_payment')

      const attemptsResult = await getPool().query<{ booking_id: string }>(
        'SELECT booking_id FROM payment_attempts WHERE idempotency_key = $1',
        [sharedKey],
      )
      expect(attemptsResult.rows.map((row) => row.booking_id)).toEqual([booking1.id])
    } finally {
      // `pg` does not reset transaction state on release. If BEGIN or the
      // INSERT above throws before COMMIT is reached, releasing clientA
      // without rolling back first would return it to the pool still inside
      // a transaction, and a later checkout would either warn "there is
      // already a transaction in progress" or fail with "current transaction
      // is aborted" — one failure cascading into unrelated tests. Attempt a
      // rollback first; on the happy path A already committed, so this is
      // expected to error as a no-op, and that error is deliberately
      // swallowed.
      await clientA.query('ROLLBACK').catch(() => {})
      clientA.release()
    }
  }, 15_000)
})
