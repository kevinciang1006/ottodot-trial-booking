import 'dotenv/config'
import { afterAll, afterEach, beforeEach, expect } from 'vitest'
import { closePool, getPool } from '@/lib/db'
import { resetDatabase } from '../scripts/reset-db'

/** Seeded IDs, fixed in db/seed.sql. */
export const PARENTS = {
  aisha: '11111111-1111-1111-1111-111111111101',
  weiLing: '11111111-1111-1111-1111-111111111102',
  marcus: '11111111-1111-1111-1111-111111111103',
} as const

export const STUDENTS = {
  nadia: '22222222-2222-2222-2222-222222222201',
  omar: '22222222-2222-2222-2222-222222222202',
  sophie: '22222222-2222-2222-2222-222222222203',
  ethan: '22222222-2222-2222-2222-222222222204',
  priya: '22222222-2222-2222-2222-222222222205',
  daniel: '22222222-2222-2222-2222-222222222206',
} as const

export const CLASSES = {
  /** 1 of 4 confirmed — plain availability. */
  available: '33333333-3333-3333-3333-333333333301',
  /** 3 of 4 confirmed — the last-seat race class. */
  lastSeat: '33333333-3333-3333-3333-333333333302',
  /** Nadia already confirmed — the duplicate-attempt class. */
  duplicate: '33333333-3333-3333-3333-333333333303',
  /** Omar sits in payment_failed — the payment-failure class. */
  paymentFailed: '33333333-3333-3333-3333-333333333304',
  /** Empty — reserved for the overbooking-under-load test. */
  empty: '33333333-3333-3333-3333-333333333305',
} as const

beforeEach(async () => {
  await resetDatabase()
})

/**
 * THE global invariant, asserted after EVERY test in EVERY file — not as a
 * single test case. Written this way it guards all six tests, not just the two
 * concurrency cases that were designed to stress it.
 */
afterEach(async () => {
  const { rows } = await getPool().query<{
    title: string
    capacity: number
    confirmed: number
  }>(
    `SELECT c.title,
            c.capacity,
            (count(b.id) FILTER (WHERE b.status = 'confirmed'))::int AS confirmed
       FROM trial_classes c
       LEFT JOIN bookings b ON b.trial_class_id = c.id
      GROUP BY c.id, c.title, c.capacity`,
  )
  const overbooked = rows.filter((row) => row.confirmed > row.capacity)
  expect(
    overbooked,
    'no class may hold more confirmed bookings than its capacity',
  ).toEqual([])
})

afterAll(async () => {
  await closePool()
})
