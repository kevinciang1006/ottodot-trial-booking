# Ottodot Take-Home — Trial Booking Reliability

**Design spec.** Date: 2026-07-23. Timebox: 3–4 hours.
Deliverable: GitHub repo with `README.md`, `AI_USAGE.md`, implementation, seed data, tests.

This spec supersedes the take-home brief's own PRD document. It carries that document
forward unchanged except for four deltas, each marked **[Δ]** and justified inline.

---

## 1. What is being graded

The brief names four hazards — duplicate bookings, overbooking past 4, payment failure
polluting the roster, and the last-seat race. They are one question asked four times:
**where do you enforce correctness?**

The answer this build gives: **in Postgres.** Application code is a thin, testable wrapper
over constraints and locks. UI checks exist only to avoid obviously wasted clicks and are
never trusted.

The brief's stated evaluation criteria, in its own order: backend and data-model judgment;
correctness under payment and double-booking edge cases; a working full-stack or
backend-led flow; sensible tests or verification; clear scope control; clear communication.

It closes with: *"prioritize correct backend behavior, clear edge-case handling, and
verification over frontend polish or feature breadth."* Adding features is a failure mode
here, not a bonus.

## 2. Scope

**In:** parent picks child → picks class → books → mock payment → status shown; admin
roster view; the four hazards; seed data; tests; README and AI_USAGE.

**Out (stated plainly in the README):** authentication, RLS, regular enrollment, real
payment provider and webhooks, waitlist, cancel/refund/reschedule UI, email and
notifications, seat holds with TTL, rate limiting, styling beyond plain Tailwind.

## 3. Stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js 15 App Router, React 19, TypeScript strict | Ottodot's stack |
| DB | Postgres 16 via `docker-compose.yml` | Reviewer runs it with zero accounts; same engine as Supabase |
| DB access | `pg` (node-postgres), raw SQL | The correctness argument *is* the SQL; an ORM hides it |
| API | Route Handlers under `/api` | curl-verifiable, directly testable |
| Logic | `src/lib/booking/service.ts`, functions taking a `PoolClient` | Tests drive the service against real Postgres; routes stay thin |
| Tests | Vitest against real Postgres | Concurrency cannot be meaningfully mocked |
| UI | 3 plain Tailwind pages | Useful, not polished — per the brief |

No auth, no ORM, no component library. All stated as deliberate cuts.

**[Δ4] Portability.** Because access is `pg` + `DATABASE_URL` + raw SQL, the app runs
against any Postgres. docker-compose is the zero-account default; pointing `DATABASE_URL`
at Supabase or Neon works unmodified. The README states this in one line. The brief lists
Supabase as an acceptable store, so this answers "does it work on our stack?" without
building for it.

**Node version.** Node 25 is installed on the build machine; Next.js 15 targets 18.18+/20+.
Verify `npm run build` and `tsc --noEmit` pass at the end of scaffolding, before any
feature code is written, so an incompatibility surfaces at minute 20 rather than hour 3.

## 4. Data model

```sql
booking_status : pending_payment | confirmed | payment_failed | cancelled_class_full | cancelled
payment_status : authorized | captured | failed | voided

parents(id, full_name, email unique)
students(id, parent_id -> parents, full_name, grade_level)
trial_classes(id, title, subject, starts_at, capacity int default 4 check capacity > 0,
              price_cents int not null check price_cents >= 0)          -- [Δ1]
bookings(id, trial_class_id -> trial_classes, student_id -> students,
         status booking_status default 'pending_payment', created_at, updated_at)
payment_attempts(id, booking_id -> bookings, idempotency_key, outcome payment_status,
                 amount_cents, provider_ref, created_at)
```

All FKs `ON DELETE CASCADE`. All columns `NOT NULL` unless nullable is meaningful
(`provider_ref` is null on a declined authorization — there is no reference to record).
An `updated_at` trigger fires on `bookings`.

**[Δ1] `trial_classes.price_cents`.** The PRD puts `amount_cents` on `payment_attempts`
but gives the class no price, so the amount has no source. A module constant would work,
but reads as a data-model miss on a take-home graded explicitly on data-model judgment.
The attempt still snapshots `amount_cents` at charge time, so a later price change cannot
rewrite what a parent was charged. Seed value: 2900 (S$29.00).

**`cancelled` is defined and unused.** It carries a SQL comment saying so: reserved for
admin-initiated cancellation, which is a stated cut. The brief names it as an example
status, so omitting it invites "why not?"; leaving it undocumented invites "dead code."
No transition in this build produces it.

Seat capacity is **not** denormalized into a counter column. Confirmed bookings are the
single source of truth (see §6).

### Indexes carrying the invariants

Each gets a SQL comment above it stating the invariant it enforces. Those comments are
part of the submission.

```sql
-- one live booking per child per class; a failed/cancelled booking may be retried
CREATE UNIQUE INDEX bookings_active_unique
  ON bookings (trial_class_id, student_id)
  WHERE status IN ('pending_payment', 'confirmed');

-- replaying a payment request cannot double-charge or double-confirm
CREATE UNIQUE INDEX payment_attempts_idem
  ON payment_attempts (idempotency_key);
```

The partial predicate is the point: a child who failed payment or cancelled can rebook,
but can never hold two live bookings for one class. The database rejects it; the service
translates error `23505` into a 409.

## 5. Booking lifecycle

```
POST /api/bookings                 -> pending_payment  (409 if a live booking exists)
POST /api/bookings/:id/pay         -> confirmed | payment_failed | cancelled_class_full
GET  /api/bookings/:id             -> current status
GET  /api/trial-classes            -> list with seats_remaining
GET  /api/trial-classes/:id/roster -> confirmed students only
```

Statuses are distinct on purpose. `payment_failed` (their card declined) and
`cancelled_class_full` (they paid nothing; the seat went to someone else) are different
events with different customer-support consequences, and collapsing them loses that.

A `payment_failed` or `cancelled_class_full` booking must never appear on a roster.

## 6. Concurrency: the seat claim

Inside one transaction on `POST /pay`:

1. `SELECT ... FROM bookings WHERE id = $1 FOR UPDATE` — serializes retries of the same booking.
2. If status is not `pending_payment`, return the existing outcome. Idempotent.
3. Idempotency check — see §7.
4. **Authorize** with the mock gateway. Declined → record `failed`, booking becomes
   `payment_failed`, commit, return. **No class row is touched.**
5. `SELECT ... FROM trial_classes WHERE id = $1 FOR UPDATE` — the seat gate. Concurrent
   claims on the same class serialize here.
6. `SELECT count(*) FROM bookings WHERE trial_class_id = $1 AND status = 'confirmed'`.
7. If `count >= capacity` → **void** the authorization, record `voided`, booking becomes
   `cancelled_class_full`, commit. The user is not charged.
8. Otherwise → **capture**, record `captured`, booking becomes `confirmed`, commit.

Lock order is always **booking, then class**, in every code path. That rule is what
prevents deadlock and it goes in `CLAUDE.md`.

### Transaction ownership

`withTransaction(fn)` in `src/lib/db.ts` checks a client out of the pool, issues `BEGIN`,
runs `fn(client)`, then `COMMIT` on return or `ROLLBACK` on throw, and releases the client
in a `finally`.

Service functions take a `PoolClient` and **assume they are already inside a transaction**.
They never issue `BEGIN`/`COMMIT` themselves. Routes call
`withTransaction(c => payForBooking(c, …))`; tests call the service exactly the same way.

One consequence matters for §11: because `withTransaction` checks out its own client per
call, concurrent callers automatically get separate connections. No extra helper is needed
to make the concurrency tests genuinely concurrent.

### Why authorize → claim → capture

A payment provider is an external network call and cannot participate in a database
transaction. Capturing money before securing the seat means the race loser is charged for
a class they never got, and recovery becomes a refund workflow. Splitting authorize from
capture moves the money decision *after* the seat decision, so the loser's authorization
is simply voided.

### [Δ3] The FK lock interaction, documented

`INSERT INTO bookings` takes a `FOR KEY SHARE` lock on the referenced `trial_classes` row
to validate the foreign key. That conflicts with the `FOR UPDATE` the pay path takes in
step 5. The fixed booking→class lock order means this cannot deadlock, but an in-flight
`createBooking` can briefly block a concurrent `pay` on the same class.

This is not a bug and requires no code change. It goes in the README's Last-Seat Race
section as a short subsection. Naming a lock interaction the design *avoided* is a
stronger signal than not knowing it exists.

### The required scenario

A and B both hold `pending_payment` for a class with one seat. **Pending does not reserve**
— matching the brief, where B is able to select the same slot A is paying for. B pays
first: locks the class, counts 3 of 4, captures, confirms. A pays second: blocks on B's
row lock, wakes to a count of 4, voids the authorization, ends at `cancelled_class_full`.
Exactly one confirmation, and A is not charged.

The README states plainly that pending bookings do not reserve seats, and why that matches
the brief's scenario.

### Alternatives considered (stated in the README)

- **Denormalized `confirmed_seats` counter + `CHECK (confirmed_seats <= capacity)`.** One
  atomic `UPDATE ... WHERE confirmed_seats < capacity`, no explicit lock, and the
  constraint makes overbooking structurally impossible. Faster under contention; rejected
  because it adds a second source of truth that can drift if any path writes bookings
  without the counter. Worth it at higher load.
- **`SERIALIZABLE` isolation with retry.** Correct, less code, but pushes retry handling
  into every caller and degrades under contention.
- **Pre-created seat rows claimed with `FOR UPDATE SKIP LOCKED`.** Best for genuinely high
  contention; overkill for a 4-seat class.
- **Time-limited holds on `pending_payment`.** Better UX for a hot class — B could not
  start paying for A's seat. Rejected: needs a TTL and an expiry job, and the brief's
  scenario explicitly has both users reaching payment.

## 7. [Δ2] Idempotency semantics

`payment_attempts_idem` is a **global** unique index on `idempotency_key`. The PRD's
service step said only "if the key already exists, return the prior result," which is
under-specified: if a client reuses a key against a *different* booking, that returns
another booking's outcome.

Resolution — the service looks the attempt up by key and branches on `booking_id`:

| Condition | Behaviour |
|---|---|
| No attempt with this key | Proceed with the charge. |
| Attempt exists, `booking_id` matches | Return the prior result unchanged. Idempotent replay. |
| Attempt exists, `booking_id` differs | Throw `IdempotencyKeyReuseError` → HTTP 409. |

The third row is the delta. It costs roughly six lines and closes a real correctness hole
in exactly the category being graded.

Both callers reach this through the same code path, so the guarantee holds whether the key
arrives as an `Idempotency-Key` header or a body field.

## 8. Mock payment gateway

`src/lib/payments/gateway.ts`. Deterministic, never random: a card token of `pm_fail`
always declines, anything else authorizes. Random failure is unreviewable and untestable.

`authorize(amountCents, cardToken)` returns `{ ok: false }` or `{ ok: true, providerRef }`.
`capture(providerRef)` and `voidAuthorization(providerRef)` are separate functions, so the
real-provider seam is visible. A comment states that this is where a real provider and its
webhooks would attach.

(`void` is a TypeScript reserved word in this position, hence `voidAuthorization`.)

## 9. API routes

Thin wrappers: parse and validate input, call the service, map typed errors to status
codes. **No business logic in route handlers.**

| Error | Status |
|---|---|
| `DuplicateBookingError` | 409 |
| `IdempotencyKeyReuseError` | 409 |
| `NotFoundError` | 404 |
| `ValidationError` | 400 |

Typed domain errors in `src/lib/booking/errors.ts`, never bare strings. Parameterized
queries only. The pay route accepts `Idempotency-Key` as a header, falling back to a body
field.

## 10. UI — three plain pages, deliberately minimal

- `/` — parent dropdown → that parent's children → class list with seats remaining.
  Booking posts and redirects to the booking page.
- `/bookings/[id]` — current status, plus "Pay (success)" and "Pay (declined card)"
  buttons sending `pm_ok` / `pm_fail`. Shows the resulting status clearly, including the
  `cancelled_class_full` case with plain text explaining no charge was made.
- `/admin` — every class, seats remaining, and its confirmed roster.

Tailwind only. Legible, unstyled-adjacent. Do not spend time here.

## 11. Tests — Vitest against real Postgres

The concurrency tests are the ones a reviewer will actually read.

Six named cases below, covering the brief's seventh requirement — the capacity invariant — as
a global assertion rather than a single test (see below). As built, several of these split
naturally into more than one assertion and a third concurrency test was added (cross-booking
idempotency-key reuse), landing the shipped suite at 15 tests across these two files — see
`README.md` and `AI_USAGE.md` for the final count and breakdown.

`tests/booking.test.ts`:

1. Happy path — booking confirms, roster shows the child.
2. Duplicate — a second live booking for the same child+class returns 409.
3. Payment declined — status `payment_failed`, seat not consumed, roster unchanged, and
   rebooking afterwards is allowed.
4. Idempotency — same key twice yields one `payment_attempts` row and one identical
   response; the same key against a *different* booking returns 409.

`tests/concurrency.test.ts`:

5. **Last-seat race** — class seeded to 3 confirmed, two children `Promise.all` their pay
   calls. Assert exactly one `confirmed` and exactly one `cancelled_class_full`.
6. **Overbooking under load** — 6 concurrent pay calls on an empty 4-seat class. Assert
   exactly 4 `confirmed` and 2 `cancelled_class_full`.

**Invariant sweep** — `expect(no class has confirmed bookings exceeding capacity)`, run as
an `afterEach` in **both** files. Written this way it guards every test in the shipped
suite, not just the two (now three) that were designed to stress it. A single test asserting
the invariant once would only prove it for whatever state that test happened to leave behind.

### [Δ2] Test architecture requirements

These are load-bearing. A concurrency test that gets them wrong passes while proving
nothing.

**Each concurrent actor gets its own pooled connection.** This falls out of §6's
transaction ownership rule for free: each `withTransaction` call checks out its own client.
The thing to avoid is the tempting alternative — checking out one `PoolClient` and passing
it to every actor in the `Promise.all`, which serializes the statements on a single wire.
The test would go green and demonstrate nothing.

**Size the pool above the peak actor count.** Test 6 needs 6 simultaneous connections; set
the pool `max` to 10. An undersized pool silently serializes the test into a queue, which
is the same false-green failure by another route.

**Assert on sorted sets, not positions.** Which actor wins the race is genuinely
nondeterministic. Asserting "A confirms" is a flaky test that also misrepresents the
guarantee being made. Sort the resulting statuses and compare, or count by status.

**`fileParallelism: false` in `vitest.config.ts`.** Both test files share one database and
each resets it; parallel files would corrupt each other.

**The invariant sweep is an `afterEach` in both files, not a seventh test case.** That way
every test proves no class exceeds capacity, not just the two that were written to.

`tests/setup.ts` resets the database before each test.

## 12. Seed data

Fixed UUIDs so README curl examples and the UI stay stable across resets. Covers every
case the brief names:

- **Class A** — 4 seats, 1 confirmed. Plain availability.
- **Class B** — 4 seats, **3 confirmed.** One seat left; the race demo class.
- **Class C** — a child already confirmed, so a duplicate attempt can be demonstrated.
- **Class D** — a booking sitting in `payment_failed`, showing a failed payment left off
  the roster.
- 3 parents, 5 students.

`npm run db:reset` drops, recreates, and seeds in one command.

## 13. Structure

```
docker-compose.yml
.env.example                              # DATABASE_URL pointing at the compose Postgres
CLAUDE.md
db/
  schema.sql                              # types, tables, constraints, indexes, trigger
  seed.sql                                # synthetic data per §12
src/
  app/
    page.tsx                              # pick child -> pick class -> book
    bookings/[id]/page.tsx                # status + pay (success / decline)
    admin/page.tsx                        # rosters + seats remaining
    api/
      trial-classes/route.ts
      trial-classes/[id]/roster/route.ts
      bookings/route.ts
      bookings/[id]/route.ts
      bookings/[id]/pay/route.ts
    layout.tsx, globals.css
  lib/
    db.ts                                 # pg Pool + withTransaction helper
    payments/gateway.ts                   # mock authorize / capture / voidAuthorization
    booking/service.ts                    # all business logic
    booking/errors.ts                     # typed domain errors -> HTTP codes
    types.ts
scripts/
  reset-db.ts                             # drop, apply schema.sql, apply seed.sql
tests/
  setup.ts
  booking.test.ts
  concurrency.test.ts
README.md
AI_USAGE.md
```

## 14. Code quality rules (go in `CLAUDE.md`)

- TypeScript strict. **No `any`**, no `!` to silence types, no `@ts-ignore`.
- Every multi-step database operation runs in one transaction via `withTransaction`.
- Never trust the client for correctness. Constraints and locks decide; the UI only avoids
  obviously wasted clicks.
- Always lock **booking before class**. This is what prevents deadlock.
- Typed domain errors, never bare strings.
- Parameterized queries only.
- `npm run build` and `tsc --noEmit` pass clean.
- No placeholders, no TODOs, no stubbed functions anywhere in the deliverable.

## 15. README contents

In this order: how to run (`docker compose up` → `npm run db:reset` → `npm run test` →
`npm run dev`); what was built; time spent (**a clearly marked placeholder for the human
to fill in**); assumptions; architecture and backend decisions; what was deliberately cut;
what to monitor after release; what would come next.

Plus two dedicated sections the brief asks for by name:

- **Last-Seat Race** — the approach, why it was chosen, the tradeoffs accepted, the
  alternatives rejected (§6), and the FK lock subsection (Δ3).
- **Backend Design** — schema, endpoints, the booking statuses and what each means,
  duplicate prevention, payment-failure handling, and which checks live in the UI vs the
  backend vs the database vs a background job.

**What to monitor after release:** confirmed bookings exceeding capacity (should be exactly
zero — alert on any); authorizations older than N minutes never captured or voided
(stranded money); bookings stuck in `pending_payment` beyond 30 minutes; the rate of
`cancelled_class_full` (races are real users losing seats — if it climbs, add holds);
duplicate-attempt rate; p95 latency on `/pay`, where lock contention shows first; roster
count versus actual attendance.

**What next with more time:** seat holds with TTL plus an expiry job; a real provider with
webhooks and a transactional outbox; waitlist auto-promotion when a confirmed booking
cancels; admin cancel and refund (which is what activates the `cancelled` status); a load
test on lock contention to size the counter-versus-lock decision with data; auth and
per-parent authorization.

## 16. AI_USAGE.md

Write the section headings the brief requires: tools used; what AI was used for; one place
it helped move faster; one place its output was rejected or corrected; what would change
next time; how the final implementation was verified.

Fill in only what is factually observable from the build session. For "disagreed with or
rejected," write `<!-- HUMAN: fill this in with the real instance -->` and leave it empty.
**Do not fabricate anything in this file.**

## 17. Done criteria

- `docker compose up` → `npm run db:reset` → `npm run test` passes from a clean checkout.
- All 15 shipped tests green — including all three concurrency tests — with the capacity
  invariant asserted after every one of them.
- `npm run build` and `tsc --noEmit` clean.
- No placeholders anywhere except the two explicitly marked human fields (README time
  spent, AI_USAGE rejected-output section).
