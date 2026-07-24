# AI Usage

## 1. Which AI tools I used

Claude Code (Opus 4.8) in the terminal. Nothing else.

## 2. What I used AI for

- Read the brief myself first and worked out what it was testing.
- Had Claude Code review the brief separately, then compared it against mine.
- Claude Code wrote the design spec (`docs/design.md`) and the implementation plan, cut into nine tasks. I went through each one and agreed or disagreed before anything was built.
- Claude Code wrote the code: schema, service layer, mock payment gateway, route handlers, UI pages, seed data, tests.
- I read the files that carry the requirements — `db/schema.sql`, `src/lib/booking/service.ts`, `src/lib/db.ts`, and the tests — and checked them against the brief.

## 3. One place AI helped me move faster

Every task got a review pass with fresh context before it was committed. On the payment service, that pass found a bug in code the same tool had written minutes earlier. I would not have found it by reading.

The bug: two payment requests using the same idempotency key on different bookings both check whether that key has been used, both see nothing, and both proceed — neither can see the other's uncommitted row. The second then hits the unique index and crashes with a raw database error instead of a clean 409, leaving its card authorization hanging.

Fixes:

- The unique violation is caught and returned as a typed `IdempotencyKeyReuseError`.
- The payment attempt is recorded before `capture()`, so a failure there cannot leave a real charge unrecorded.
- A failed record voids the authorization first.

A test covers it. It holds one transaction open and watches `pg_stat_activity` until the second request is confirmed blocked.

## 4. One place I disagreed with, corrected, or rejected AI output

I found this by using the app, not by reading code.

Clicking "Book trial" for the seeded child showed a red error straight away: this child already has a live booking. No way forward. The logic was right — that child did have one. The cause was that the agent had tested its own work by writing to the database and never reset it.

- An agent that tests by changing data has to reset it after. Otherwise the next person to open the app sees something that looks broken.
- I also disagreed with the UX. A red error on the main button is the wrong answer to a duplicate. If a parent clicks "Book trial" for a child who is already booked, they want to see that booking. It now goes to the booking status page. The API still returns 409 and the unique index still blocks the duplicate. Only the frontend handling changed.

## 5. What I would change about my AI workflow next time

- **Give it my writing conventions up front.** The generated README and this file did not sound like me. I rewrote both. That is time I would rather not spend twice.
- **Put environment details in the spec first.** The plan used Postgres on port 5433, which was already taken by another container. `npm run db:reset` starts with `DROP SCHEMA IF EXISTS public CASCADE`, so pointing it at the wrong database would have wiped another project. Moved to 5434, but only after the scaffold was written.
- **Tell it to reset state after it verifies its own work.** The agent tested by writing to the database and left the data behind, which is why the app looked broken when I first opened it.
- **Decide failure ordering up front.** Whether the payment attempt is recorded before or after `capture()`, and what happens if `capture()` itself fails, were left to the implementation and caught in review. A sentence in the spec would have settled it.

## 6. How I verified the final implementation

- `npm run test` — 16 tests against real Postgres, no mocks: 13 in `tests/booking.test.ts`, 3 in `tests/concurrency.test.ts`. A capacity check runs in `afterEach` after every one of them.
- Removed `FOR UPDATE` from the class lock to check the concurrency tests can actually fail. Both capacity tests failed at 5-of-4 and 6-of-4. Put it back, all green again.
- Did not run the `pool max: 1` version of that check. Dropping the pool to one connection makes the six actors queue and run one after another, so the counting still works out to exactly 4 and the test passes. A test that passes when the thing it tests is broken proves nothing.
- curl over every endpoint on a fresh seed: seats remaining, 409 on a duplicate, 201 on a new booking, `confirmed` on a successful pay, an identical response on a replay with exactly one `payment_attempts` row, empty roster for the class with a failed payment. Also 404 on an unknown booking, 400 on a bad UUID, 400 on a missing `cardToken`.
- Clicked through the UI in a browser: booked a trial, paid, checked the roster. Then booked the last seat of a 3-of-4 class in two tabs and paid both. First confirmed, second returned `cancelled_class_full` with no charge.
- Clean checkout at the end: `docker compose down -v`, `docker compose up -d`, `rm -rf node_modules .next`, `npm install`, `npm run db:reset`, `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build`. All exited 0, suite all green.
