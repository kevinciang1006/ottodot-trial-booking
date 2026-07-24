# Ottodot — Trial Class Booking

A parent picks a child and a trial class, books, and pays. A class holds 4 students.

Correctness is enforced in Postgres. Constraints and locks decide; application code is a thin wrapper over them.

Short on time: read [Last-Seat Race](#last-seat-race) and [Backend Design](#backend-design).

## Where each requirement is answered

| Brief asks for | Section |
|---|---|
| How to run your solution | [How to run](#how-to-run) |
| What you built | [What was built](#what-was-built) |
| Time spent | [Time spent](#time-spent) |
| Assumptions you made | [Assumptions](#assumptions) |
| Key architecture and backend decisions | [Key architecture and backend decisions](#key-architecture-and-backend-decisions) |
| Last-seat race: approach, why, tradeoffs | [Last-Seat Race](#last-seat-race) 1–3 |
| Data model or schema | [Backend Design](#backend-design) 1 |
| Key API endpoints or backend functions | [Backend Design](#backend-design) 2 |
| Booking statuses used | [Backend Design](#backend-design) 3 |
| How you prevent duplicate bookings | [Backend Design](#backend-design) 4 |
| How you handle payment failure | [Backend Design](#backend-design) 5 |
| How you handle two users competing for the last seat | [Backend Design](#backend-design) 6 |
| Which checks belong in UI, backend, database, background job | [Backend Design](#backend-design) 7 |
| What you deliberately cut | [What was deliberately cut](#what-was-deliberately-cut) |
| What you would monitor after release | [What to monitor after release](#what-to-monitor-after-release) |
| What you would do next with more time | [What to do next with more time](#what-to-do-next-with-more-time) |
| Seed data and setup steps | [How to run](#how-to-run), `db/seed.sql` |
| Tests or clear verification steps | [Verify with curl](#verify-with-curl), [How this is verified](#how-this-is-verified) |

---

## How to run

```bash
docker compose up -d      # Postgres 16, host port 5434
cp .env.example .env
npm install
npm run db:reset          # drop schema, apply db/schema.sql, apply db/seed.sql
npm run test              # 16 tests against the real database
npm run dev               # http://localhost:3000
```

Postgres binds to host port **5434** to avoid colliding with 5432 or 5433. If it still collides, change it in `docker-compose.yml` and `DATABASE_URL`.

Any Postgres works. All access is raw SQL over `pg` with a `DATABASE_URL`, so a Supabase or Neon connection string drops in. The pool sets no `ssl` option, so append `?sslmode=require` for a hosted database.

Pages: `/` (book), `/bookings/<id>` (status and pay), `/admin` (rosters).

Seed data covers the four cases the brief asks for: a class with seats available, a class with exactly 3 confirmed students, a child already confirmed on a class so a duplicate can be demonstrated, and a booking sitting in `payment_failed`.

### Verify with curl

The backend is the graded part, so it is checkable without the UI. Fixed UUIDs from `db/seed.sql`, against a fresh `npm run db:reset` and a running `npm run dev`:

```bash
# 1. The race class has one seat left.
curl http://localhost:3000/api/trial-classes
# → class ...302 has "seatsRemaining":1

# 2. Nadia is already confirmed on this class.
curl -X POST http://localhost:3000/api/bookings -H 'Content-Type: application/json' -d \
  '{"studentId":"22222222-2222-2222-2222-222222222201","trialClassId":"33333333-3333-3333-3333-333333333303"}'
# → 409 duplicate_booking, with existingBookingId so the UI can redirect there

# 3. Ethan takes the race class's last seat.
curl -X POST http://localhost:3000/api/bookings -H 'Content-Type: application/json' -d \
  '{"studentId":"22222222-2222-2222-2222-222222222204","trialClassId":"33333333-3333-3333-3333-333333333302"}'
# → 201 pending_payment — keep the returned id for step 4

# 4. Pay, then replay the identical request.
curl -X POST http://localhost:3000/api/bookings/<id-from-step-3>/pay \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' -d '{"cardToken":"pm_ok"}'
# → 200 confirmed / captured / charged:true
# Replaying returns a byte-for-byte identical response, and payment_attempts still
# holds exactly one row for that booking.

# 5. The class with a payment_failed booking has an empty roster.
curl http://localhost:3000/api/trial-classes/33333333-3333-3333-3333-333333333304/roster
# → {"roster":[]}
```

---

## What was built

- **Schema** (`db/schema.sql`) — five tables, two unique indexes carrying the correctness invariants, one enum per state machine, an `updated_at` trigger. Every constraint has a comment naming what it enforces.
- **Service layer** (`src/lib/booking/service.ts`) — all business logic. Functions take a `PoolClient` and assume they are already inside a transaction. Tests call them the same way routes do.
- **Five API routes** — parse input, call the service, map typed errors to status codes. No business logic in a route handler.
- **Mock payment gateway** (`src/lib/payments/gateway.ts`) — deterministic, split into `authorize` / `capture` / `voidAuthorization` so the real-provider seam is visible.
- **Three plain Tailwind pages** — deliberately unpolished, per the brief.
- **Seed data** (`db/seed.sql`) — fixed UUIDs, covering the four required edge cases.
- **16 tests** — 13 in `tests/booking.test.ts`, 3 in `tests/concurrency.test.ts`, run by Vitest against real Postgres, plus a capacity invariant in an `afterEach` that runs after every one.

---

## Time spent

Roughly **4 hours**:

- ~45 min — reading the brief and writing the design spec.
- ~2 hours — schema, service layer, API routes, seed data, UI.
- ~45 min — tests and the mutation check.
- ~30 min — this README and `AI_USAGE.md`.

---

## Assumptions

- **No authentication.** A parent is picked from a dropdown. Every endpoint is open, including `/admin`. Stated as a cut, not an oversight.
- **The gateway is mocked and deterministic.** Card token `pm_fail` always declines, anything else authorizes. A gateway that fails randomly cannot be reviewed or tested.
- **A "live" booking is `pending_payment` or `confirmed`.** Those are the two statuses the duplicate index covers. A child whose payment failed may rebook.
- **A pending booking does not reserve a seat.** See [Last-Seat Race](#last-seat-race).
- **Price lives on the class** (`price_cents`, seeded at 2900). The payment attempt snapshots `amount_cents` at charge time, so a later price change cannot rewrite what a parent was charged.
- **Trial classes are seeded, not managed.** No admin CRUD for classes.
- **One Postgres, no read replicas.** Every read in the seat-claim path hits the primary, inside the transaction that writes.

---

## Key architecture and backend decisions

| Decision | Why |
|---|---|
| Correctness in Postgres, not application code | `SELECT`-then-`INSERT` has a TOCTOU window two concurrent requests can both pass. A unique index does not. |
| Raw SQL over `pg`, no ORM | The correctness argument is the SQL: partial indexes, `FOR UPDATE`, lock ordering. An ORM hides it. |
| Seats derived from confirmed bookings, no counter column | One source of truth that cannot drift. Tradeoff in [alternatives rejected](#alternatives-rejected). |
| Service functions take a `PoolClient`, never issue `BEGIN`/`COMMIT` | `withTransaction` owns the transaction and checks out its own pooled client per call, so concurrent callers get separate connections. This is what makes the concurrency tests concurrent rather than serialized. |
| **Always lock booking, then class** | A fixed global lock order makes deadlock impossible. Every code path obeys it. |
| `authorize` → claim seat → `capture` | An external network call cannot join a database transaction. Capturing before securing the seat charges the race loser for a class they never got. |
| `payment_failed` and `cancelled_class_full` kept distinct | A declined card and a lost race need different messages and different support handling. |
| Vitest against real Postgres | Row locks, `READ COMMITTED` visibility, and unique-index blocking cannot be mocked. |
| Typed errors mapped to HTTP in one place | `toErrorResponse` is the only mapping. A raw SQLSTATE never reaches a client. |

### Idempotency

`payment_attempts_idem` is a global unique index on `idempotency_key`. `payForBooking` looks the key up and branches on `booking_id`:

| Condition | Behaviour |
|---|---|
| No attempt with this key | Proceed with the charge. |
| Attempt exists, `booking_id` matches | Return the prior result unchanged. |
| Attempt exists, `booking_id` differs | `IdempotencyKeyReuseError` → 409. |

That `SELECT` is not sufficient on its own. Under `READ COMMITTED` it cannot see another transaction's uncommitted `INSERT`, so two requests racing on one key across different bookings both read no prior row and both proceed. The unique index decides: `recordAttempt` catches the `23505` and throws the same typed error.

`tests/concurrency.test.ts` proves this without sleeping. One transaction inserts the key and is held open while the test polls `pg_stat_activity` until the second request is parked on the index (`wait_event_type = 'Lock'`).

### Order of operations on the confirmed path

The `payment_attempts` row is written **before** `capture()`. If that insert fails, the authorization is voided and the error propagates with nothing captured. The reverse order risks a real charge with no record of it.

Accepted residual window: if `capture()` itself throws after the attempt is recorded, the transaction rolls back and the authorization is stranded until it expires. An external call cannot join a database transaction, so some window always exists. This ordering picks the failure mode where money never moved. Webhooks plus a transactional outbox are the real fix — see [what to do next](#what-to-do-next-with-more-time).

### Retries without an explicit key

If a client omits `Idempotency-Key`, the pay route generates one. Replay protection still holds: `payForBooking`'s first gate returns the existing outcome whenever the booking's status is not `pending_payment`, so a completed request cannot charge twice regardless of key. The explicit key covers the narrower window where two requests for the same booking are in flight at once, and `FOR UPDATE` on the booking row serializes those anyway.

---

## Last-Seat Race

### 1. The approach I chose

**A pending booking does not reserve a seat.** A seat is consumed at exactly one moment: when a booking becomes `confirmed`, inside the transaction that captures the money.

Everything below happens in one transaction on `POST /api/bookings/:id/pay`:

1. `SELECT … FROM bookings WHERE id = $1 FOR UPDATE` — **lock 1**. Serializes concurrent retries of the same booking.
2. If the status is not `pending_payment`, return the existing outcome.
3. Idempotency-key check.
4. Read the price with a plain, unlocked `SELECT`.
5. **Authorize.** Declined → record `failed`, set `payment_failed`, commit, return. The class row is never locked.
6. `SELECT … FROM trial_classes WHERE id = $1 FOR UPDATE` — **lock 2, the seat gate.**
7. `SELECT count(*) FROM bookings WHERE trial_class_id = $1 AND status = 'confirmed'`, under that lock.
8. `count >= capacity` → void the authorization, record `voided`, set `cancelled_class_full`. Otherwise record `captured`, capture, set `confirmed`.

Lock order is always booking, then class, in every code path. That fixed order makes deadlock impossible, and it is written into `CLAUDE.md` as a standing rule.

**The brief's scenario, walked through.** A and B both hold `pending_payment` on a class with one seat. B pays first, locks the class, counts 3 of 4, captures, confirms. A pays second, blocks on B's lock, wakes to a count of 4, voids, and lands in `cancelled_class_full`. One confirmation, and A was never charged.

Booking a full class is permitted on purpose. `createBooking` runs no capacity check, so a `POST /api/bookings` on a 4-of-4 class returns 201 and that booking is guaranteed to end at `cancelled_class_full`. A create-time check would be advisory only — the seat can be taken between that check and the eventual payment.

### 2. Why I chose it

**Why pending does not reserve.** In the brief's own scenario, User B selects the same slot User A is already paying for. That is only possible if A's pending booking holds nothing. The consequence is honest: B can reach the payment screen for a seat that is about to disappear. What must never happen is B being charged for it.

**Why authorize → claim → capture.** A payment provider is an external network call and cannot join a database transaction. Charging before securing the seat means the race loser is charged for a class they never got, and recovery becomes a refund — a support ticket, a debit on their statement, and days to reverse. Splitting authorize from capture moves the money decision after the seat decision, so the loser's authorization is voided and nothing appears on their statement.

**Why a lock and a count, rather than a constraint.** See [alternatives rejected](#alternatives-rejected) below.

### 3. Tradeoffs accepted

- **The gateway round-trip happens while the class row is locked.** `capture()` and `voidAuthorization()` run inside the seat gate, so on a hot class every claimant queues behind the current claimant's network call, and a hung gateway pins the gate. The alternative — claim the seat, capture afterwards — shortens the lock but reintroduces a "confirmed but never charged" state needing its own reconciliation.
- **A user can lose a seat after entering their card.** The direct cost of pending not reserving. The mitigation is a clear message. If the `cancelled_class_full` rate climbs, the answer is seat holds.
- **Overbooking is prevented procedurally, not structurally.** See [Backend Design 7](#7-which-checks-belong-in-the-ui-backend-database-or-background-job).
- **The residual window on `capture()`** — see [order of operations](#order-of-operations-on-the-confirmed-path).

### Alternatives rejected

- **Denormalized `confirmed_seats` counter with `CHECK (confirmed_seats <= capacity)`.** One atomic `UPDATE … WHERE confirmed_seats < capacity`, no explicit lock, and overbooking becomes structurally impossible. Faster under contention. Rejected because it adds a second source of truth that drifts the moment any path writes `bookings` without updating the counter. Worth revisiting at higher load, with a load test rather than a guess.
- **`SERIALIZABLE` isolation with retry.** Correct and less code, but pushes retry handling into every caller and degrades under contention.
- **Pre-created seat rows claimed with `FOR UPDATE SKIP LOCKED`.** Right for high contention, overkill for a 4-seat class.
- **Time-limited holds on `pending_payment`.** Better UX on a hot class, since B could not start paying for A's seat. Rejected because it needs a TTL and an expiry job, and the brief's scenario has both users reaching payment.

### The foreign-key lock interaction

`INSERT INTO bookings` takes a `FOR KEY SHARE` lock on the referenced `trial_classes` row to validate the foreign key, which conflicts with the `FOR UPDATE` the pay path takes at step 6. The fixed booking → class lock order means this cannot deadlock, but an in-flight `createBooking` can briefly block a concurrent `pay` on the same class. No code change needed; noted because the ordering was chosen with this in mind.

### How this is verified

`tests/concurrency.test.ts` seeds a class to 3 of 4 and has two children `Promise.all` their pay calls, asserting exactly one `confirmed` and one `cancelled_class_full`. It then fires six simultaneous pay calls at an empty 4-seat class and asserts exactly 4 `confirmed` and 2 `cancelled_class_full`. Statuses are compared as sorted sets, never positionally — which actor wins is nondeterministic, and asserting "A wins" would be flaky and would misstate the guarantee.

The tests were checked for falsifiability by mutation: removing `FOR UPDATE` from the class lock drives them to 5-of-4 and 6-of-4 confirmed. Totals above capacity are unreachable without genuine transaction overlap, so that failure proves both that the tests can fail and that the actors really run concurrently. `FOR UPDATE` was restored and the suite is green.

**Seeing it by hand.** A genuine race needs two simultaneous payments, which is what the tests fire. You can watch the same states in the UI: the seed leaves Fractions Deep Dive at 3 of 4. Book two different children onto it (both go `pending_payment`), pay one → `confirmed`, pay the other → `cancelled_class_full` with the "you were not charged" message.

---

## Backend Design

### 1. Data model

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

Two indexes carry the invariants:

```sql
-- one live booking per child per class; a failed/cancelled booking may be retried
CREATE UNIQUE INDEX bookings_active_unique
  ON bookings (trial_class_id, student_id)
  WHERE status IN ('pending_payment', 'confirmed');

-- replaying a payment request cannot double-charge or double-confirm
CREATE UNIQUE INDEX payment_attempts_idem
  ON payment_attempts (idempotency_key);
```

`bookings_class_status` is a third index, an access path for the count-under-lock and the roster query. It enforces nothing.

Seat capacity is not denormalized into a `confirmed_seats` column — see [alternatives rejected](#alternatives-rejected).

### 2. Key API endpoints

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/trial-classes` | Every class with `capacity`, `confirmedCount`, `seatsRemaining`. |
| `GET` | `/api/trial-classes/:id/roster` | Confirmed students only. |
| `POST` | `/api/bookings` | Creates a `pending_payment` booking. 409 if a live booking exists. |
| `GET` | `/api/bookings/:id` | Current booking and status. |
| `POST` | `/api/bookings/:id/pay` | Authorize → claim → capture. Returns `confirmed`, `payment_failed`, or `cancelled_class_full`. Accepts `Idempotency-Key` as a header, falling back to a body field. |

The backend functions behind them are `listTrialClasses`, `getRoster`, `createBooking`, `getBooking`, and `payForBooking`, all in `src/lib/booking/service.ts`.

Error mapping: `DuplicateBookingError` → 409, `IdempotencyKeyReuseError` → 409, `NotFoundError` → 404, `ValidationError` → 400. Anything else is logged and returns a generic 500.

### 3. Booking statuses

| Status | Meaning |
|---|---|
| `pending_payment` | Created, payment not yet attempted. Holds no seat. |
| `confirmed` | Payment captured. The only status that consumes a seat or appears on a roster. |
| `payment_failed` | Card declined. No seat taken, nothing charged. The child may rebook. |
| `cancelled_class_full` | Lost the last-seat race. Authorized but never captured, then voided. Nothing charged. |
| `cancelled` | Declared but never produced by this build. Reserved for admin cancellation, which is a stated cut. The brief names it as an example status, so it is declared rather than silently omitted. |

`payment_failed` and `cancelled_class_full` are kept apart on purpose. A parent whose card bounced and a parent who lost a race need different messages and different support handling.

### 4. How duplicate bookings are prevented

`bookings_active_unique` is the only thing preventing a duplicate. The service does not pre-check with a `SELECT`, because check-then-insert has a TOCTOU window two concurrent requests can both pass. It inserts, catches `23505` on that index name, and throws `DuplicateBookingError` → 409.

The partial predicate matters: a child who failed payment or lost a race can rebook, but can never hold two live bookings for one class.

The 409 is not a dead end. After the constraint fires, the service does a recovery read to find the live booking that blocked the insert and returns its id as `existingBookingId`. The booking form uses that to redirect the parent to that booking. The database still decides; the UI just recovers. (The recovery read runs after `ROLLBACK TO SAVEPOINT`, since a failed insert aborts the surrounding transaction.)

### 5. How payment failure is handled

A declined authorization is handled without locking or writing the class row. The attempt is recorded as `failed`, the booking becomes `payment_failed`, and the transaction commits. A card that is about to bounce never contends for the seat gate and never reaches a roster — `getRoster` and the `seats_remaining` calculation both filter on `status = 'confirmed'`.

A payment that succeeds but arrives too late is a different outcome: the authorization is voided, the booking becomes `cancelled_class_full`, and nothing is charged.

### 6. How two users competing for the last seat is handled

Both reach payment, because a pending booking reserves nothing. Both authorize. Both then queue on `SELECT … FROM trial_classes … FOR UPDATE`, and Postgres lets exactly one through at a time. The first counts 3 of 4, captures, confirms, and commits. The second's lock query does not return until that commit, then counts 4 of 4, voids its authorization, and lands in `cancelled_class_full` with nothing charged.

Full detail, including why this ordering was chosen and what it costs: [Last-Seat Race](#last-seat-race).

### 7. Which checks belong in the UI, backend, database, or background job

| Check | UI | Backend | Database |
|---|---|---|---|
| Class appears full | Greys out the button | — | — |
| Duplicate booking | — | Translates 23505 → 409 | `bookings_active_unique` **decides** |
| Overbooking past capacity | — | Counts under lock, **decides** `confirmed < capacity` | `FOR UPDATE` serializes claimants |
| Payment failure off roster | — | Sets `payment_failed`, never locks the class | Roster query filters `status = 'confirmed'` |
| Double-charge on replay | Sends a stable key | Returns the prior outcome | `payment_attempts_idem` **decides** |

The UI column is convenience only. A greyed-out button avoids an obviously wasted click; it never prevents overbooking, and a class can fill between the page rendering and the button being pressed.

**No check lives in a background job — there are none.** Seat holds with a TTL would introduce the first, and that is a stated cut.

The overbooking row differs from the other three. `FOR UPDATE` serializes claimants onto one queue but decides nothing itself. The decision is a TypeScript comparison, `if (confirmed >= classRow.capacity)`, running after the lock is held. So overbooking is the one hazard enforced procedurally rather than by a constraint that holds regardless of the code above it. The rejected `confirmed_seats` counter with `CHECK (confirmed_seats <= capacity)` is what would close that gap, at the cost of a second source of truth.

---

## What was deliberately cut

The brief asks to prioritize backend correctness and verification over feature breadth, so adding features here would be a failure mode. Cut on purpose:

- Authentication, authorization, and RLS.
- Regular (non-trial) enrollment.
- A real payment provider, webhooks, and refunds.
- Waitlist and auto-promotion.
- Cancel / reschedule UI, and the admin actions that would produce the `cancelled` status.
- Email and notifications.
- Seat holds with a TTL and the expiry job they require.
- Rate limiting.
- Styling beyond plain Tailwind, and any component library.
- A third button state on the class list. A child with a live booking still sees an active "Book trial" button, which redirects to the existing booking rather than creating a second one. The behaviour is correct and the duplicate is prevented at the database, but the button text does not reflect the state. Closing it needs every child's live bookings loaded into client state for a presentational gain.
- Fixing `npm audit`'s 3 transitive advisories (`next`/high, `postcss`/moderate, `sharp`/high). The only fix npm offers is downgrading `next` to 9.3.3, and the advisory range extends through Next 16, so none is actionable at the pinned version.

---

## What to monitor after release

- **Confirmed bookings exceeding capacity.** Should be exactly zero. Alert on any occurrence — this is the invariant the design exists to hold, and it is the same query the suite runs in its `afterEach`.
- **Authorizations older than N minutes never captured or voided.** Stranded money, and the direct signal for the residual window above.
- **Bookings stuck in `pending_payment` beyond 30 minutes.** Abandoned checkouts, or a route failing between create and pay.
- **Rate of `cancelled_class_full`.** Every one is a real user who lost a seat after reaching payment. If it climbs, add seat holds.
- **Duplicate-attempt rate (409s on `POST /api/bookings`).** A spike usually means a UI bug or a retrying client.
- **p95 latency on `/pay`.** Lock contention shows up here first, because the gateway round-trip runs inside the seat gate.
- **Roster count versus actual attendance.** The end-to-end check that the data means what the business thinks it means.

---

## What to do next with more time

1. **Seat holds with a TTL plus an expiry job** — the fix for users losing a seat at the payment screen, justified by a rising `cancelled_class_full` rate.
2. **A real provider with webhooks and a transactional outbox** — closes the residual window by making the money state reconcilable out of band. The seat claim itself moves into the webhook handler; the lock, count and decide block is unchanged.
3. **Waitlist with auto-promotion** when a confirmed booking cancels.
4. **Admin cancel and refund**, which activates the `cancelled` status.
5. **A load test on lock contention**, to settle the counter-versus-lock tradeoff with data.
6. **Auth and per-parent authorization**, so a parent only sees their own children.
