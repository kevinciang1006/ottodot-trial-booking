# AI Usage

## Which AI tools I used

Claude Code (Opus 4.8) in the terminal. No other AI tools.

## What I used AI for

The whole build, driven through a fixed workflow rather than ad-hoc prompting:

1. **Brainstorm** — pulling apart the take-home brief to work out what it is actually
   grading (four hazards that are one question asked four times: *where do you enforce
   correctness?*) and what would count as scope creep.
2. **Design spec** — `docs/design.md`:
   stack, data model, the seat-claim sequence, idempotency semantics, the test
   architecture, and the list of alternatives to reject and why. Written and argued over
   before any code existed.
3. **Implementation plan** — the spec cut into nine tasks with explicit interfaces between
   them, so each could be built and checked independently.
4. **Task-by-task execution** — each task implemented, then handed to a **separate reviewer
   pass with fresh context** before being committed. Findings were adjudicated against the
   spec rather than accepted or dismissed wholesale.

Concretely, AI drafted the schema and its invariant comments, the service layer, the mock
payment gateway, the five route handlers, the three UI pages, the seed data, the test
suite, and this file and the README.

## One place AI helped me move faster

The per-task reviewer pass, on the payment service. It found a real correctness hole in
code the same tool had written minutes earlier: two concurrent requests reusing one
idempotency key against *different* bookings both pass the lookup `SELECT`, because
`READ COMMITTED` cannot see a peer transaction's uncommitted `INSERT`. The loser therefore
hit the unique index and surfaced a raw SQLSTATE `23505` as a 500, with an authorization
left stranded.

Three changes came out of that: `recordAttempt` translates the unique violation into a
typed `IdempotencyKeyReuseError`, the confirmed path records the attempt *before*
`capture()` so a failure there cannot leave a real charge unrecorded, and a failing record
voids the authorization before propagating. A dedicated test then pinned the behaviour —
it holds one transaction open and polls `pg_stat_activity` until the second request is
observably blocked on the index, rather than sleeping and hoping.

Finding that by hand would have meant reasoning carefully about `READ COMMITTED` visibility
under a global unique index. Finding it by accident in production would have meant a 500
and a stranded authorization.

## One place I disagreed with, corrected, or rejected AI output

> ⚠️ **TO BE FILLED IN BEFORE SUBMITTING.**
<!-- HUMAN: describe the real instance here, in your own words, and delete this notice. -->

## What I would change about my AI workflow next time

- **Put the environment facts in the spec before generating any code.** The plan specified
  Postgres on host port 5433. That port was already held by an unrelated container on this
  machine, and `npm run db:reset` applies a schema file whose first statement is
  `DROP SCHEMA IF EXISTS public CASCADE` — pointing that at another project's database is a
  cheap mistake to prevent and an expensive one to make. It was caught and moved to 5434,
  but only after the scaffold had been written.
- **Specify the failure-ordering decisions up front.** Whether the payment attempt is
  recorded before or after `capture()`, and what happens if `capture()` itself throws, were
  left to the implementation and caught by the reviewer. That worked, but it spent a review
  cycle on something a sentence in the spec would have settled.
- **Track test coverage as it is written, not at the end.** The spec predicted six named
  cases; the suite landed at 15 because several cases split naturally and a third
  concurrency test was added. That is a good outcome, but it meant re-deriving what was
  actually covered at the end instead of knowing continuously.

## How I verified the final implementation

- **Test suite against real Postgres, not mocks.** `npm run test` → 15 tests, 12 in
  `tests/booking.test.ts` and 3 in `tests/concurrency.test.ts`, plus a capacity invariant
  asserted in an `afterEach` that runs after every one of them. The concurrency is genuine:
  `withTransaction` checks out its own pooled client per call, and the pool `max` is 10
  against a peak of 6 simultaneous actors, so no actor is silently queued behind another.
- **A mutation check to prove the concurrency tests are falsifiable.** `FOR UPDATE` was
  temporarily removed from the class lock. Both capacity tests then failed with 5-of-4 and
  6-of-4 confirmed, and the shared invariant `afterEach` failed alongside them — totals
  that are unreachable without genuine transaction overlap. `FOR UPDATE` was restored
  immediately and the suite went back to 15/15. The `pool max: 1` variant of the same check
  was deliberately *not* run: six actors serialized onto one connection still total
  correctly, so it would produce a false green and prove nothing.
- **A curl walkthrough of every endpoint** against a running `npm run dev`, from a freshly
  seeded database: seats remaining on the race class (`1`), a duplicate booking returning
  409 `duplicate_booking`, a new booking returning 201 `pending_payment`, a successful pay
  returning `confirmed` / `captured` / `charged: true`, an identical replay returning a
  byte-for-byte identical response (including `updatedAt`, proving no re-write) with
  exactly one `payment_attempts` row confirmed via `psql`, and an empty roster for the class
  holding a `payment_failed` booking. Plus 404 on an unknown booking, 400 on a malformed
  UUID, and 400 on a body missing `cardToken`.
- **A curl-driven pass over the UI flow** — book, pay with a declined card, rebook, pay
  successfully, check the roster — driven with curl against a running dev server and
  verified against the server-rendered HTML. No browser was available in this environment,
  so the client-only behaviour in `booking-form.tsx` and `pay-buttons.tsx` was verified by
  reading the code rather than by clicking. That is the one gap in this verification and it
  is stated rather than glossed over.
- **A clean-checkout run at the end**: `docker compose down -v`, `docker compose up -d`,
  `rm -rf node_modules .next`, `npm install`, `npm run db:reset`, `npm run test`,
  `npm run typecheck`, `npm run lint`, `npm run build`. Every command exited 0 and the
  suite was 15/15 — so a reviewer cloning this repo hits no state that only exists on the
  machine it was built on.
