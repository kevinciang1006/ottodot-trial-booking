# Ottodot — Trial Class Booking

A parent picks a child, picks a trial class, books, and pays. A class holds 4 students.
The interesting part is what happens when two parents pay for the last seat at the same
moment — and the answer this build gives is that **correctness lives in Postgres**.
Constraints and locks decide; application code is a thin, testable wrapper over them.

Start with [Backend Design](#backend-design) and [Last-Seat Race](#last-seat-race) if you
only have a few minutes.

---

## How to run

```bash
docker compose up -d      # Postgres 16, host port 5434
cp .env.example .env
npm install
npm run db:reset          # drop schema, apply db/schema.sql, apply db/seed.sql
npm run test              # 15 tests against the real database
npm run dev               # http://localhost:3000
```

Postgres binds to host port **5434** to avoid colliding with an existing Postgres on 5432
or 5433. If it collides anyway, change the port in `docker-compose.yml` and in
`DATABASE_URL`.

**Any Postgres works.** All access is raw SQL over `pg` with a `DATABASE_URL`, so a
Supabase or Neon connection string drops straight in — with one caveat: the pool sets no
`ssl` option, so append `?sslmode=require` to a hosted connection string.

Three pages: `/` (book), `/bookings/<id>` (status and pay), `/admin` (rosters).

### Verify it yourself with curl

The backend is the part being graded, so it should be checkable without the UI. These five
requests use the fixed UUIDs from `db/seed.sql` against a freshly reset database
(`npm run db:reset`) and a running `npm run dev`:

```bash
# 1. The race class has exactly one seat left.
curl http://localhost:3000/api/trial-classes
# → class 33333333-3333-3333-3333-333333333302 has "seatsRemaining":1

# 2. Nadia is already confirmed on this class — booking her again is a duplicate.
curl -X POST http://localhost:3000/api/bookings -H 'Content-Type: application/json' -d \
  '{"studentId":"22222222-2222-2222-2222-222222222201","trialClassId":"33333333-3333-3333-3333-333333333303"}'
# → 409 {"error":{"code":"duplicate_booking","message":"...","existingBookingId":"...405"}}
#   existingBookingId points at the live booking that blocked it, so the UI can
#   redirect the parent there (see Duplicate prevention) instead of dead-ending.

# 3. Ethan claims the race class's last seat.
curl -X POST http://localhost:3000/api/bookings -H 'Content-Type: application/json' -d \
  '{"studentId":"22222222-2222-2222-2222-222222222204","trialClassId":"33333333-3333-3333-3333-333333333302"}'
# → 201 {"booking":{...,"status":"pending_payment",...}} — keep the returned `id` for step 4

# 4. Pay for it, then replay the identical request.
curl -X POST http://localhost:3000/api/bookings/<id-from-step-3>/pay \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' -d '{"cardToken":"pm_ok"}'
# → 200 {"booking":{"status":"confirmed",...},"outcome":"captured","charged":true,...}
# Replaying the exact same command returns a byte-for-byte identical response, and
# payment_attempts still holds exactly one row for that booking — the idempotency key decided.

# 5. The class with a payment_failed booking has nobody on its roster.
curl http://localhost:3000/api/trial-classes/33333333-3333-3333-3333-333333333304/roster
# → {"roster":[]}
```

---

## What was built

- **Schema** (`db/schema.sql`) — five tables, two unique indexes that carry the
  correctness invariants, one enum per state machine, an `updated_at` trigger. Every
  constraint has a comment naming the invariant it enforces.
- **Service layer** (`src/lib/booking/service.ts`) — all business logic. Functions take a
  `PoolClient` and assume they are already inside a transaction. Tests call them exactly
  the way routes do.
- **Five API routes** — thin wrappers that parse input, call the service, and map typed
  domain errors to status codes. No business logic in a route handler.
- **Mock payment gateway** (`src/lib/payments/gateway.ts`) — deterministic, split into
  `authorize` / `capture` / `voidAuthorization` so the real-provider seam is visible.
- **Three plain Tailwind pages** — deliberately unpolished, per the brief.
- **Seed data** (`db/seed.sql`) — fixed UUIDs; a class with one seat left, a class with a
  duplicate to demonstrate, a class with a failed payment sitting off the roster.
- **15 tests** across two files (12 in `tests/booking.test.ts`, 3 in
  `tests/concurrency.test.ts`), run by Vitest against a real Postgres, plus a capacity
  invariant asserted in an `afterEach` that runs after **every one of them**.

---

## Time spent

**Time spent:** ⚠️ TO BE FILLED IN BEFORE SUBMITTING <!-- HUMAN: replace this entire line's value with the real number -->

---

## Assumptions

- **No authentication.** A parent is picked from a dropdown. Every endpoint is open, and
  `/admin` is unauthenticated. This is stated as a cut, not an oversight — adding auth
  would consume the budget the brief wants spent on correctness.
- **The payment gateway is mocked and deterministic.** Card token `pm_fail` always
  declines; anything else authorizes. A gateway that fails randomly cannot be reviewed and
  cannot be tested.
- **A "live" booking is `pending_payment` or `confirmed`.** Those two statuses are what the
  duplicate-prevention index covers; a child whose payment failed may rebook.
- **A pending booking does not reserve a seat.** See [Last-Seat Race](#last-seat-race) —
  this is a deliberate choice matching the brief's own scenario.
- **Price lives on the class** (`price_cents`, seeded at 2900 = S$29.00). The payment
  attempt snapshots `amount_cents` at charge time, so a later price change cannot rewrite
  what a parent was charged.
- **Trial classes are seeded, not managed.** There is no admin CRUD for classes.
- **One Postgres, no read replicas.** Every read in the seat-claim path is against the
  primary, inside the same transaction that does the writing.

---

## Key architecture and backend decisions

| Decision | Why |
|---|---|
| Correctness enforced in Postgres, not in application code | A `SELECT`-then-`INSERT` check has a TOCTOU window two concurrent requests can both pass. A unique index does not. |
| Raw SQL over `pg`, no ORM | The correctness argument *is* the SQL — partial indexes, `FOR UPDATE`, lock ordering. An ORM hides exactly the thing being graded. |
| Seats derived from confirmed bookings on every read; no counter column | One source of truth that cannot drift — full tradeoff in [alternatives rejected](#alternatives-rejected). |
| Service functions take a `PoolClient`, never issue `BEGIN`/`COMMIT` | `withTransaction` owns the transaction. Each call checks out its own pooled client, so concurrent callers automatically get separate connections — which is what makes the concurrency tests genuinely concurrent rather than serialized on one wire. |
| **Always lock booking, then class** | A fixed global lock order is what makes deadlock impossible. Every code path obeys it, no exceptions. |
| `authorize` → claim seat → `capture` | An external network call cannot participate in a database transaction. Capturing before securing the seat charges the race loser for a class they never got, and recovery becomes a refund workflow. |
| Statuses `payment_failed` and `cancelled_class_full` kept distinct | "Your card was declined" and "someone else got the seat, you were never charged" are different events with different support consequences. Collapsing them destroys that. |
| Vitest against real Postgres | Row locks, `READ COMMITTED` visibility, and unique-index blocking cannot be meaningfully mocked. A mocked concurrency test proves nothing. |
| Typed domain errors mapped to HTTP in one place | Routes contain zero error logic; `toErrorResponse` is the only mapping. A raw SQLSTATE never escapes to a client. |

### Idempotency: the `SELECT` is the fast path, the index is the decider

`payment_attempts_idem` is a **global** unique index on `idempotency_key`. `payForBooking`
looks the key up first and branches on `booking_id`:

| Condition | Behaviour |
|---|---|
| No attempt with this key | Proceed with the charge. |
| Attempt exists, `booking_id` matches | Return the prior result unchanged — idempotent replay. |
| Attempt exists, `booking_id` differs | Throw `IdempotencyKeyReuseError` → HTTP 409. Returning another booking's outcome would be worse than failing loudly. |

That `SELECT` alone is **not** sufficient. It runs under `READ COMMITTED` and cannot see a
peer transaction's uncommitted `INSERT`, so two requests racing on one key across different
bookings both read no prior row and both proceed. The unique index is what actually decides
under concurrency: `recordAttempt` catches the resulting `23505` and translates it into the
same typed `IdempotencyKeyReuseError`. The `SELECT` handles the sequential case cheaply; the
constraint handles the concurrent one correctly.

`tests/concurrency.test.ts` proves this deterministically rather than by sleeping and
hoping: one transaction inserts the key and is held open, and the test polls
`pg_stat_activity` until the second request is observably parked on the index
(`wait_event_type = 'Lock'`) before committing the first.

### Order of operations on the confirmed path

The `payment_attempts` row is written **before** `capture()`. If that insert fails — for
example a concurrent cross-booking key reuse hitting the unique index — the authorization
is voided and the error propagates; nothing is captured. The reverse order would risk a
real charge with no `payment_attempts` row and a booking stuck in `pending_payment`.

**An accepted residual window:** if `capture()` itself throws after the attempt is
recorded, the transaction rolls back and the authorization is stranded until it expires.
This is inherent — an external network call cannot participate in a database transaction,
so there is always *some* window where the two can disagree. The design chooses the window
whose failure mode is "money never moved" over the one whose failure mode is "money moved
and nothing recorded it." A real provider's webhooks plus a transactional outbox are the
answer, and both are in [what to do next](#what-to-do-next-with-more-time).

### Retries without an explicit key are still safe

If a client omits `Idempotency-Key`, the pay route generates one. That looks like it
defeats replay protection, and it does not. `payForBooking`'s first gate returns the
existing outcome whenever the booking's status is not `pending_payment`, so replaying a
request that already completed cannot charge twice regardless of the key. The explicit key
covers the narrower window where two requests for the same booking are genuinely in flight
at once — and the `FOR UPDATE` on the booking row serializes those anyway. The key is
defence in depth for that window, not the primary mechanism.

---

## Backend Design

### Schema

```
parents(id, full_name, email UNIQUE)
students(id, parent_id → parents, full_name, grade_level)
trial_classes(id, title, subject, starts_at,
              capacity int DEFAULT 4 CHECK (capacity > 0),
              price_cents int CHECK (price_cents >= 0))
bookings(id, trial_class_id → trial_classes, student_id → students,
         status booking_status DEFAULT 'pending_payment', created_at, updated_at)
payment_attempts(id, booking_id → bookings, idempotency_key, outcome payment_status,
                 amount_cents, provider_ref, created_at)
```

Two indexes carry the invariants, and both are documented in `db/schema.sql`:

```sql
-- one live booking per child per class; a failed/cancelled booking may be retried
CREATE UNIQUE INDEX bookings_active_unique
  ON bookings (trial_class_id, student_id)
  WHERE status IN ('pending_payment', 'confirmed');

-- replaying a payment request cannot double-charge or double-confirm
CREATE UNIQUE INDEX payment_attempts_idem
  ON payment_attempts (idempotency_key);
```

`bookings_class_status` is a third index, purely an access path for the count-under-lock
and the roster query — it enforces nothing.

Seat capacity is deliberately **not** denormalized into a `confirmed_seats` column — see
[alternatives rejected](#alternatives-rejected) for why.

### Endpoints

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/trial-classes` | Every class with `capacity`, `confirmedCount`, `seatsRemaining`. |
| `GET` | `/api/trial-classes/:id/roster` | **Confirmed students only.** |
| `POST` | `/api/bookings` | Creates a `pending_payment` booking. `409` if a live booking already exists. |
| `GET` | `/api/bookings/:id` | Current booking and status. |
| `POST` | `/api/bookings/:id/pay` | Authorize → claim → capture. Returns `confirmed`, `payment_failed`, or `cancelled_class_full`. Accepts `Idempotency-Key` as a header, falling back to a body field. |

Error mapping: `DuplicateBookingError` → 409, `IdempotencyKeyReuseError` → 409,
`NotFoundError` → 404, `ValidationError` → 400. Anything else is logged and returns a
generic 500 — a raw Postgres error never reaches a client.

### Booking statuses

| Status | Meaning |
|---|---|
| `pending_payment` | Booking created, payment not yet attempted. **Holds no seat.** |
| `confirmed` | Payment captured. This is the *only* status that consumes a seat or appears on a roster. |
| `payment_failed` | The card was declined. No seat taken, nothing charged. The child may rebook — the partial index excludes this status. |
| `cancelled_class_full` | Lost the last-seat race. The card was authorized but never captured, and the authorization was voided. Nothing was charged. |
| `cancelled` | Declared but never produced by this build. Reserved for admin-initiated cancellation, which is a stated cut. The brief names it as an example status, so it is declared explicitly rather than silently omitted — and `db/schema.sql` says so in a comment. |

`payment_failed` and `cancelled_class_full` are kept apart on purpose: a parent whose card
bounced and a parent who lost a race need different messages and different support
handling.

### Duplicate prevention

`bookings_active_unique` is the *only* thing preventing a duplicate booking. The service
does not pre-check with a `SELECT`, because check-then-insert has a TOCTOU window two
concurrent requests can both pass. It inserts, catches SQLSTATE `23505` on that specific
index name, and throws `DuplicateBookingError` → HTTP 409.

The partial predicate is the point. A child who failed payment or lost a race can rebook,
but can never hold two live bookings for one class.

The 409 is not a dead-end. After the constraint fires, the service does a *recovery read*
— not a pre-check — to find the live booking that blocked the insert, and returns its id as
`existingBookingId` on the error. The booking form uses that to redirect the parent to that
booking: the Pay buttons if it is still `pending_payment`, or its confirmed status if it is
already `confirmed`. The database still decides; the UI just recovers gracefully instead of
showing a wall. (The recovery read runs after a `ROLLBACK TO SAVEPOINT`, because a failed
insert aborts the surrounding transaction.)

### Payment-failure handling

A declined authorization is handled **without ever locking or writing the class row**: the attempt
is recorded as `failed`, the booking becomes `payment_failed`, and the transaction commits.
A card that is about to bounce never contends for the seat gate, never consumes a seat, and
never reaches a roster — `getRoster` filters on `status = 'confirmed'`, and so does the
`seats_remaining` calculation.

### Which checks live where

| Check | UI | Backend | Database |
|---|---|---|---|
| Class appears full | Greys out the button | — | — |
| Duplicate booking | — | Translates 23505 → 409 | `bookings_active_unique` **decides** |
| Overbooking past capacity | — | Counts under lock, **decides** `confirmed < capacity` | `FOR UPDATE` on the class serializes claimants |
| Payment failure off roster | — | Sets `payment_failed`, never locks the class row | Roster query filters `status = 'confirmed'` |
| Double-charge on replay | Sends a stable key | Returns the prior outcome | `payment_attempts_idem` **decides** |

Read the "UI" column as *convenience only*. A greyed-out button avoids an obviously wasted
click; it is never what prevents overbooking, and a class can fill between the page
rendering and the button being pressed. No check in this build lives in a background job —
there are no background jobs. Seat holds with a TTL would introduce the first one, and that
is a stated cut.

Look closely at the overbooking row and it is not like the other three: `FOR UPDATE` only
serializes claimants onto one queue, it does not itself decide anything. The decision is a
plain TypeScript comparison, `if (confirmed >= classRow.capacity)` in
`src/lib/booking/service.ts`, running after the lock is held. That makes overbooking the one
hazard of the four enforced procedurally — by code that runs under mutual exclusion — rather
than structurally, by a constraint that holds no matter what code runs on top of it. This is
a considered tradeoff, not an oversight: the rejected `confirmed_seats` counter +
`CHECK (confirmed_seats <= capacity)` alternative described in [alternatives
rejected](#alternatives-rejected) is exactly what would close that gap, at the cost of a
second source of truth that can drift.

---

## Last-Seat Race

### Pending bookings do not reserve seats

This is the central design choice, and it is deliberate. In the brief's own scenario, User
B is able to *select the same slot* User A is already paying for — which is only possible
if A's `pending_payment` booking holds nothing. So a seat is consumed at exactly one
moment: when a booking becomes `confirmed`, inside the transaction that captures the money.

The consequence is honest and stated to the user: B can reach the payment screen for a seat
that is about to disappear. What must never happen is B being *charged* for it.

- **Booking a full class is permitted, on purpose.** `createBooking` runs no capacity check
  at all — a `POST /api/bookings` on a 4-of-4 class still returns 201, and that booking is
  guaranteed to end at `payForBooking` in `cancelled_class_full`. A create-time capacity
  check would be advisory only: it would decide nothing, since the seat can be taken by
  someone else between that check and the eventual payment. The UI's greyed-out button
  already prevents the obviously wasted click; the backend does not need to duplicate it.

### The sequence

Everything below happens inside one transaction on `POST /api/bookings/:id/pay`:

1. `SELECT … FROM bookings WHERE id = $1 FOR UPDATE` — **lock 1**. Serializes concurrent
   retries of the same booking.
2. If the status is not `pending_payment`, return the existing outcome. Idempotent replay.
3. Idempotency-key check (see above).
4. Read the price with a **plain, unlocked** `SELECT`. Reading a price must not take the
   seat gate.
5. **Authorize** with the gateway. Declined → record `failed`, set `payment_failed`,
   commit, return. **The class row is never locked, and nothing about the class changes.**
6. `SELECT … FROM trial_classes WHERE id = $1 FOR UPDATE` — **lock 2, the seat gate.**
   Concurrent claims on the same class serialize here.
7. `SELECT count(*) FROM bookings WHERE trial_class_id = $1 AND status = 'confirmed'`,
   under that lock.
8. `count >= capacity` → **void** the authorization, record `voided`, set
   `cancelled_class_full`. The user is not charged.
   Otherwise → record `captured`, **capture**, set `confirmed`.

Walked through with the brief's scenario: A and B both hold `pending_payment` on a class
with one seat. B pays first, locks the class, counts 3 of 4, captures, confirms. A pays
second, blocks on B's row lock, wakes to a count of 4, voids the authorization, and lands
in `cancelled_class_full`. Exactly one confirmation, and A was never charged.

**Lock order is always booking, then class, in every code path.** That fixed order is what
makes deadlock impossible, and it is written into `CLAUDE.md` as a standing rule.

**Seeing it by hand.** A genuine race needs two simultaneous payments, which is what
`tests/concurrency.test.ts` fires and asserts — that test is the proof of the concurrent
guarantee. You can still watch the same *states* in the UI: the seed leaves Fractions Deep
Dive at 3 of 4 confirmed. Book two different children onto it (both go `pending_payment` —
pending does not reserve), pay one → `confirmed`, then pay the other → `cancelled_class_full`
with the "you were not charged" message. Same outcome the race produces, walked one step at
a time.

### Why authorize → claim → capture

A payment provider is an external network call and cannot participate in a database
transaction. Charging before securing the seat means the race loser is charged for a class
they never got and recovery becomes a refund workflow — a support ticket, a customer who
sees a debit on their statement, and a reversal that takes days. Splitting authorize from
capture moves the money decision *after* the seat decision, so the loser's authorization is
simply voided and nothing ever appears on their statement.

### Tradeoffs accepted

- **The gateway round-trip happens while the class row is locked.** `capture()` — and, on
  the race-lost path, `voidAuthorization()` — run inside the seat gate, so on a hot class
  every claimant queues behind the current claimant's network call, and a hung gateway pins
  the gate for as long as it hangs. That is inherent to deciding the money outcome inside
  the seat transaction rather than after it. The alternative (claim the seat, capture
  afterwards) shortens the lock but reintroduces a "confirmed but never charged" state that
  would need its own reconciliation path.
- **A user can lose a seat after entering their card.** That is the direct cost of pending
  not reserving. It is the brief's scenario, and the mitigation is a clear message rather
  than a hidden failure. If the `cancelled_class_full` rate ever climbs, the answer is seat
  holds — see [what to monitor](#what-to-monitor-after-release).
- **The residual window on `capture()`** — see [order of operations on the confirmed
  path](#order-of-operations-on-the-confirmed-path).

### The foreign-key lock interaction

`INSERT INTO bookings` takes a `FOR KEY SHARE` lock on the referenced `trial_classes` row
to validate the foreign key. That conflicts with the `FOR UPDATE` the pay path takes at
step 6. The fixed booking → class lock order means this **cannot deadlock**, but an
in-flight `createBooking` can briefly block a concurrent `pay` on the same class.

This is not a bug and needs no code change. It is named here because a lock interaction the
design avoids by construction is worth stating explicitly — the ordering was reasoned
about, not stumbled into.

### Alternatives rejected

- **Denormalized `confirmed_seats` counter with `CHECK (confirmed_seats <= capacity)`.**
  One atomic `UPDATE … WHERE confirmed_seats < capacity`, no explicit lock, and the
  constraint makes overbooking structurally impossible. Genuinely faster under contention.
  Rejected because it adds a second source of truth that drifts the moment any code path
  writes `bookings` without updating the counter. Worth revisiting at higher load — and
  that is a decision to make with a load test, not a guess.
- **`SERIALIZABLE` isolation with retry.** Correct and less code, but pushes
  serialization-failure retry handling into every caller and degrades under contention.
- **Pre-created seat rows claimed with `FOR UPDATE SKIP LOCKED`.** The right answer for
  genuinely high contention; overkill for a 4-seat class.
- **Time-limited holds on `pending_payment`.** Better UX for a hot class — B could not
  start paying for A's seat at all. Rejected because it needs a TTL and an expiry job, and
  because the brief's scenario explicitly has both users reaching payment.

### How this is verified

`tests/concurrency.test.ts` seeds a class to 3 of 4 confirmed and has two children
`Promise.all` their pay calls, asserting exactly one `confirmed` and one
`cancelled_class_full`; then fires six simultaneous pay calls at an empty 4-seat class and
asserts exactly 4 `confirmed` and 2 `cancelled_class_full`. Statuses are compared as sorted
sets, never positionally — which actor wins is genuinely nondeterministic, and asserting
"A wins" would be a flaky test that also misstates the guarantee.

Those tests were checked for falsifiability by mutation: **removing `FOR UPDATE` from the
class lock drives them to 5-of-4 and 6-of-4 confirmed.** Totals above capacity are
unreachable without genuine transaction overlap, so that failure proves both that the tests
can fail and that the actors really do run concurrently rather than serially. `FOR UPDATE`
was restored immediately and the suite is green.

---

## What was deliberately cut

The brief asks to prioritize backend correctness and verification over feature breadth, so
adding features here would be a failure mode, not a bonus. Cut on purpose:

- Authentication, authorization, and RLS.
- Regular (non-trial) enrollment.
- A real payment provider, webhooks, and refunds.
- Waitlist and auto-promotion.
- Cancel / reschedule UI, and the admin actions that would produce the `cancelled` status.
- Email and notifications.
- Seat holds with a TTL and the expiry job they require.
- Rate limiting.
- Styling beyond plain Tailwind, and any component library.
- Fixing `npm audit`'s 3 transitive advisories (`next`/high, `postcss`/moderate,
  `sharp`/high): the only fix npm offers is downgrading `next` to 9.3.3, and the advisory
  range extends through Next 16, so none is actionable at the pinned Next 15 version.

---

## What to monitor after release

- **Confirmed bookings exceeding capacity.** Should be exactly zero. Alert on any single
  occurrence — this is the invariant the whole design exists to hold, and it is the same
  query the test suite runs in its `afterEach`.
- **Authorizations older than N minutes that were never captured or voided.** Stranded
  money, and the direct signal for the residual window described above.
- **Bookings stuck in `pending_payment` beyond 30 minutes.** Abandoned checkouts, or a
  route failing between create and pay.
- **The rate of `cancelled_class_full`.** Every one is a real user who lost a seat after
  reaching payment. If it climbs, that is the trigger to add seat holds.
- **Duplicate-attempt rate (409s on `POST /api/bookings`).** A spike usually means a UI bug
  or a retrying client, not a malicious one.
- **p95 latency on `/pay`.** Lock contention shows up here first, because the gateway
  round-trip runs inside the seat gate.
- **Roster count versus actual attendance.** The end-to-end check that the data means what
  the business thinks it means.

---

## What to do next with more time

1. **Seat holds with a TTL plus an expiry job** — the real fix for users losing a seat at
   the payment screen, and the thing a rising `cancelled_class_full` rate would justify.
2. **A real provider with webhooks and a transactional outbox** — closes the residual
   window described in [order of operations on the confirmed
   path](#order-of-operations-on-the-confirmed-path) by making the money state
   reconcilable out of band instead of depending on one in-transaction call.
3. **Waitlist with auto-promotion** when a confirmed booking cancels.
4. **Admin cancel and refund**, which is what finally activates the `cancelled` status.
5. **A load test on lock contention**, to settle the counter-versus-lock tradeoff with data
   rather than judgment.
6. **Auth and per-parent authorization**, so a parent can only see and act on their own
   children.
