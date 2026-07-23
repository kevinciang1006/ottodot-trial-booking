# Ottodot Trial Booking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a trial class booking system where duplicate bookings, overbooking, payment failure, and the last-seat race are prevented by Postgres constraints and row locks rather than by application code.

**Architecture:** Raw SQL over `pg` with a thin service layer; every service function takes a `PoolClient` and assumes it is already inside a transaction opened by `withTransaction`. The pay path takes two row locks in a fixed order — booking, then class — with the payment authorization split from the capture so the race loser is never charged. Route handlers and React pages are thin wrappers that add no business logic.

**Tech Stack:** Next.js 15.5.21 (App Router), React 19, TypeScript 5.9.3 strict, Postgres 16 (docker-compose), `pg` 8.x raw SQL, Vitest 3.x against real Postgres, Tailwind (whatever `create-next-app@15` installs).

## Global Constraints

Every task's requirements implicitly include this section.

- **Pin `typescript@~5.9.3`.** `typescript@latest` is 7.0.2, and `typescript-eslint@8` declares a peer of `typescript: >=4.8.4 <6.1.0`. A fresh clone would fail `npm run lint`.
- **Pin `next@15.5.21`.** `next@latest` is 16.2.11. The spec targets the Next 15 line.
- **TypeScript strict. No `any`, no `!` non-null assertions, no `@ts-ignore`.** Where a value may be absent, guard it (`const row = result.rows[0]; if (!row) throw …`).
- **Parameterized queries only.** Never interpolate a value into SQL.
- **Every multi-step database operation runs in one transaction via `withTransaction`.** Service functions never issue `BEGIN`/`COMMIT` themselves.
- **Always lock booking before class.** In every code path, without exception. This fixed order is what makes deadlock impossible.
- **Never trust the client for correctness.** Constraints and locks decide; the UI only avoids obviously wasted clicks.
- **Typed domain errors, never bare strings.**
- **No placeholders, no TODOs, no stubbed functions** in the deliverable, except the two explicitly marked human fields (README time spent, AI_USAGE rejected-output section).
- **Docker on this machine needs a sandbox bypass** to reach `~/.docker/run/docker.sock`.
- **`npm run build` and `npx tsc --noEmit` must pass clean** at the end of every task that touches TypeScript.

---

### Task 1: Project scaffold, Postgres, and the connection pool

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`, `.env`
- Create: `src/lib/db.ts`
- Create: `CLAUDE.md`
- Modify: `package.json` (scripts), `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `getPool(): Pool`, `withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>`, `closePool(): Promise<void>` — all from `src/lib/db.ts`. Every later task uses `withTransaction`.

- [ ] **Step 1: Scaffold the Next.js app in the existing repo**

The repo already exists at `~/Documents/Projects/ottodot-trial-booking` with `docs/` and `.local-refs/`. Scaffold in place:

```bash
cd ~/Documents/Projects/ottodot-trial-booking
npx --yes create-next-app@15.5.21 . \
  --typescript --tailwind --app --src-dir --eslint \
  --import-alias "@/*" --no-turbopack --use-npm --yes
```

If it refuses because the directory is non-empty, answer yes to proceed — it does not delete `docs/` or `.local-refs/`.

- [ ] **Step 2: Pin TypeScript and add runtime dependencies**

```bash
npm i pg
npm i -D @types/pg typescript@~5.9.3 vitest@^3.2.7 tsx dotenv
```

- [ ] **Step 3: Verify the toolchain before writing any feature code**

Run: `npx tsc --noEmit && npm run build`
Expected: both exit 0. This is the Node 25 compatibility check — if Next 15 cannot build on this Node version, that must surface now, not at hour three.

- [ ] **Step 4: Write `docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:16-alpine
    container_name: ottodot-db
    environment:
      POSTGRES_USER: ottodot
      POSTGRES_PASSWORD: ottodot
      POSTGRES_DB: ottodot
    # 5433 on the host so this never collides with a Postgres already on 5432.
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ottodot -d ottodot"]
      interval: 2s
      timeout: 3s
      retries: 30
    volumes:
      - ottodot_pgdata:/var/lib/postgresql/data

volumes:
  ottodot_pgdata:
```

- [ ] **Step 5: Write `.env.example` and copy it to `.env`**

`.env.example`:

```
# Points at the Postgres in docker-compose.yml.
# Any Postgres works — a Supabase or Neon connection string can be dropped in
# unchanged, because all database access is raw SQL over `pg`.
DATABASE_URL=postgres://ottodot:ottodot@localhost:5433/ottodot
```

```bash
cp .env.example .env
```

Confirm `.gitignore` (created by `create-next-app`) already ignores `.env*`. It must still track `.env.example` — add `!.env.example` if needed. Also confirm `.local-refs/` is still listed.

- [ ] **Step 6: Write `src/lib/db.ts`**

```ts
import { Pool, type PoolClient } from 'pg'

// Next.js dev-mode HMR re-evaluates modules on every edit. Without caching the
// pool on globalThis the process accumulates a new Pool — and its sockets — each
// time, and eventually exhausts Postgres connections.
const globalForPool = globalThis as unknown as { ottodotPool?: Pool }

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and run `docker compose up -d`.',
    )
  }
  // `max` must exceed the peak concurrent-actor count in the tests (6, from the
  // overbooking-under-load case). An undersized pool silently serializes those
  // actors into a queue, which makes a concurrency test pass while proving
  // nothing.
  return new Pool({ connectionString, max: 10 })
}

export function getPool(): Pool {
  if (!globalForPool.ottodotPool) {
    globalForPool.ottodotPool = createPool()
  }
  return globalForPool.ottodotPool
}

/**
 * Runs `fn` inside a single transaction on its own pooled client.
 *
 * Service functions take a PoolClient and assume they are already inside a
 * transaction; they never issue BEGIN or COMMIT themselves. Because each call
 * checks out its own client, concurrent callers automatically get separate
 * connections — which is what makes the concurrency tests genuinely concurrent.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function closePool(): Promise<void> {
  const pool = globalForPool.ottodotPool
  if (pool) {
    globalForPool.ottodotPool = undefined
    await pool.end()
  }
}
```

- [ ] **Step 7: Add scripts to `package.json`**

Merge into the existing `"scripts"` block:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "typecheck": "tsc --noEmit",
    "db:reset": "tsx scripts/reset-db.ts",
    "test": "vitest run"
  }
}
```

- [ ] **Step 8: Start Postgres and verify the pool connects**

```bash
docker compose up -d
docker compose ps
```

Expected: the `db` service reports `healthy` within ~10s. (Docker commands need a sandbox bypass on this machine.)

Then:

```bash
npx tsx -e "import 'dotenv/config'; import {getPool,closePool} from './src/lib/db.ts'; const r = await getPool().query('select version()'); console.log(r.rows[0].version); await closePool();"
```

Expected: prints `PostgreSQL 16.x …`.

- [ ] **Step 9: Write `CLAUDE.md`**

```markdown
# Ottodot Trial Booking — working rules

## What this is
A take-home. Graded on backend correctness, edge cases, and explanation —
explicitly not on frontend polish or feature breadth. Adding features is a
failure mode, not a bonus. The scope is fixed by
`docs/superpowers/specs/2026-07-23-ottodot-trial-booking-design.md`.

## Stack — do not substitute
Next.js 15 App Router, React 19, TypeScript strict. Postgres 16 via
docker-compose. `pg` with raw SQL — no ORM, no query builder, because the
correctness argument *is* the SQL. Plain Tailwind, no component library.
Vitest against real Postgres — concurrency cannot be meaningfully mocked.
No auth, no RLS; a parent is picked from a dropdown.

## Architecture rules
- Correctness lives in Postgres. Constraints and locks decide. Application
  code is a thin, testable wrapper over them.
- **Always lock booking before class.** Every code path, no exceptions. That
  fixed order is what makes deadlock impossible.
- Service functions take a `PoolClient` and assume they are already inside a
  transaction. They never issue BEGIN/COMMIT. Callers use `withTransaction`.
- No business logic in route handlers or React components.
- Never pre-check with a SELECT what a constraint can decide — check-then-insert
  has a TOCTOU window that two concurrent requests can both pass.

## Code quality
- TypeScript strict. No `any`, no `!`, no `@ts-ignore`.
- Parameterized queries only.
- Typed domain errors, never bare strings.
- `npm run build` and `npm run typecheck` pass clean.
- No placeholders, TODOs, or stubs — except the two marked human fields in
  README (time spent) and AI_USAGE (rejected output).

## Commands
    docker compose up -d    # Postgres 16 on localhost:5433
    npm run db:reset        # drop, apply db/schema.sql, apply db/seed.sql
    npm run test            # Vitest against the real database
    npm run dev
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next 15 app, Postgres compose, and connection pool"
```

---

### Task 2: Schema, seed data, and the reset script

**Files:**
- Create: `db/schema.sql`
- Create: `db/seed.sql`
- Create: `scripts/reset-db.ts`

**Interfaces:**
- Consumes: `getPool`, `closePool` from `src/lib/db.ts`.
- Produces: `resetDatabase(): Promise<void>` from `scripts/reset-db.ts`, imported by `tests/setup.ts` in Task 4. Also produces the fixed seed UUIDs that every later task and test refers to.

> **Deviation from spec §12, deliberate:** the spec says 3 parents / 5 students / classes A–D. This plan seeds **6 students and a fifth class (E)**. The overbooking-under-load test needs six *distinct* students booking one class — `bookings_active_unique` forbids reusing a student — and it needs an empty 4-seat class that no other test has touched. Five students and four classes cannot express that test.

- [ ] **Step 1: Write `db/schema.sql`**

```sql
-- Ottodot trial booking — schema.
--
-- Correctness lives here, not in application code. Every constraint and index
-- below carries a comment naming the invariant it enforces; those comments are
-- part of the submission.

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE TYPE booking_status AS ENUM (
  'pending_payment',
  'confirmed',
  'payment_failed',
  'cancelled_class_full',
  'cancelled'
);
-- 'payment_failed' (their card declined) and 'cancelled_class_full' (they paid
-- nothing; the seat went to someone else) are deliberately distinct. They are
-- different events with different customer-support consequences, and collapsing
-- them into one status destroys that information.
--
-- 'cancelled' is declared but never produced by this build. It is reserved for
-- admin-initiated cancellation, which is a stated scope cut. The brief names it
-- as an example status, so it is declared rather than silently omitted.

CREATE TYPE payment_status AS ENUM ('authorized', 'captured', 'failed', 'voided');

CREATE TABLE parents (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  email     text NOT NULL UNIQUE
);

CREATE TABLE students (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  full_name   text NOT NULL,
  grade_level int  NOT NULL
);

CREATE TABLE trial_classes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title     text NOT NULL,
  subject   text NOT NULL,
  starts_at timestamptz NOT NULL,
  -- INVARIANT: a class holds at most `capacity` confirmed students. The check
  -- makes a zero- or negative-capacity class unrepresentable.
  capacity  int NOT NULL DEFAULT 4 CHECK (capacity > 0),
  -- Price lives on the class; payment_attempts snapshots amount_cents at charge
  -- time, so changing the price later cannot rewrite what a parent was charged.
  price_cents int NOT NULL CHECK (price_cents >= 0)
);
-- Seat capacity is deliberately NOT denormalized into a confirmed_seats counter.
-- Confirmed bookings are the single source of truth. A counter would be faster
-- under contention but adds a second source of truth that drifts the moment any
-- code path writes bookings without updating it.

CREATE TABLE bookings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trial_class_id uuid NOT NULL REFERENCES trial_classes(id) ON DELETE CASCADE,
  student_id     uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status         booking_status NOT NULL DEFAULT 'pending_payment',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  outcome         payment_status NOT NULL,
  amount_cents    int NOT NULL CHECK (amount_cents >= 0),
  -- Null when the gateway declined: there is no provider reference to record.
  provider_ref    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- INVARIANT: a child holds at most one *live* booking per class.
--
-- The partial predicate is the whole point. A child whose payment failed, or
-- whose seat was taken by a race winner, can rebook — but can never hold two
-- live bookings for the same class. Violating this raises SQLSTATE 23505, which
-- the service translates into HTTP 409.
--
-- This is the *only* thing preventing duplicate bookings. The service does not
-- pre-check with a SELECT, because check-then-insert has a TOCTOU window that
-- two concurrent requests can both pass.
CREATE UNIQUE INDEX bookings_active_unique
  ON bookings (trial_class_id, student_id)
  WHERE status IN ('pending_payment', 'confirmed');

-- INVARIANT: one payment attempt per idempotency key, globally.
-- Replaying a payment request cannot double-charge or double-confirm.
CREATE UNIQUE INDEX payment_attempts_idem
  ON payment_attempts (idempotency_key);

-- Supports the confirmed-seat count taken under lock in the pay path, and the
-- roster query. Not an invariant — purely an access path.
CREATE INDEX bookings_class_status ON bookings (trial_class_id, status);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_set_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

- [ ] **Step 2: Write `db/seed.sql`**

IDs are fixed, not generated, so README curl examples and the UI stay stable across resets.

```sql
-- Synthetic seed data. Fixed UUIDs so curl examples and the UI stay stable
-- across resets. Covers every case the brief asks to demonstrate.

INSERT INTO parents (id, full_name, email) VALUES
  ('11111111-1111-1111-1111-111111111101', 'Aisha Rahman',  'aisha@example.com'),
  ('11111111-1111-1111-1111-111111111102', 'Wei Ling Tan',  'weiling@example.com'),
  ('11111111-1111-1111-1111-111111111103', 'Marcus Lee',    'marcus@example.com');

INSERT INTO students (id, parent_id, full_name, grade_level) VALUES
  ('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111101', 'Nadia Rahman', 4),
  ('22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111101', 'Omar Rahman',  6),
  ('22222222-2222-2222-2222-222222222203', '11111111-1111-1111-1111-111111111102', 'Sophie Tan',   5),
  ('22222222-2222-2222-2222-222222222204', '11111111-1111-1111-1111-111111111102', 'Ethan Tan',    3),
  ('22222222-2222-2222-2222-222222222205', '11111111-1111-1111-1111-111111111103', 'Priya Lee',    4),
  ('22222222-2222-2222-2222-222222222206', '11111111-1111-1111-1111-111111111103', 'Daniel Lee',   5);

INSERT INTO trial_classes (id, title, subject, starts_at, capacity, price_cents) VALUES
  -- Class A: plain availability (1 of 4 confirmed).
  ('33333333-3333-3333-3333-333333333301', 'Intro to Forces',      'Science', now() + interval '3 days', 4, 2900),
  -- Class B: THE RACE CLASS. 3 of 4 confirmed, exactly one seat left.
  ('33333333-3333-3333-3333-333333333302', 'Fractions Deep Dive',  'Math',    now() + interval '4 days', 4, 2900),
  -- Class C: has a confirmed booking for Nadia, so a duplicate attempt can be demonstrated.
  ('33333333-3333-3333-3333-333333333303', 'Light and Shadow',     'Science', now() + interval '5 days', 4, 2900),
  -- Class D: has a payment_failed booking, showing a failed payment left off the roster.
  ('33333333-3333-3333-3333-333333333304', 'Algebra Foundations',  'Math',    now() + interval '6 days', 4, 2900),
  -- Class E: empty. Reserved for the overbooking-under-load test.
  ('33333333-3333-3333-3333-333333333305', 'Cells and Microscopes','Science', now() + interval '7 days', 4, 2900);

INSERT INTO bookings (id, trial_class_id, student_id, status) VALUES
  -- Class A — 1 confirmed.
  ('44444444-4444-4444-4444-444444444401', '33333333-3333-3333-3333-333333333301', '22222222-2222-2222-2222-222222222205', 'confirmed'),
  -- Class B — 3 confirmed, one seat left.
  ('44444444-4444-4444-4444-444444444402', '33333333-3333-3333-3333-333333333302', '22222222-2222-2222-2222-222222222201', 'confirmed'),
  ('44444444-4444-4444-4444-444444444403', '33333333-3333-3333-3333-333333333302', '22222222-2222-2222-2222-222222222202', 'confirmed'),
  ('44444444-4444-4444-4444-444444444404', '33333333-3333-3333-3333-333333333302', '22222222-2222-2222-2222-222222222203', 'confirmed'),
  -- Class C — Nadia is already confirmed; booking her again must return 409.
  ('44444444-4444-4444-4444-444444444405', '33333333-3333-3333-3333-333333333303', '22222222-2222-2222-2222-222222222201', 'confirmed'),
  -- Class D — Omar's payment failed. He is NOT on the roster, and he may rebook.
  ('44444444-4444-4444-4444-444444444406', '33333333-3333-3333-3333-333333333304', '22222222-2222-2222-2222-222222222202', 'payment_failed');

INSERT INTO payment_attempts (booking_id, idempotency_key, outcome, amount_cents, provider_ref) VALUES
  ('44444444-4444-4444-4444-444444444401', 'seed-a-1', 'captured', 2900, 'auth_seed_a1'),
  ('44444444-4444-4444-4444-444444444402', 'seed-b-1', 'captured', 2900, 'auth_seed_b1'),
  ('44444444-4444-4444-4444-444444444403', 'seed-b-2', 'captured', 2900, 'auth_seed_b2'),
  ('44444444-4444-4444-4444-444444444404', 'seed-b-3', 'captured', 2900, 'auth_seed_b3'),
  ('44444444-4444-4444-4444-444444444405', 'seed-c-1', 'captured', 2900, 'auth_seed_c1'),
  -- Declined: no provider_ref, because there is no authorization to reference.
  ('44444444-4444-4444-4444-444444444406', 'seed-d-1', 'failed',   2900, NULL);
```

- [ ] **Step 3: Write `scripts/reset-db.ts`**

```ts
import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closePool, getPool } from '../src/lib/db'

/**
 * Drops and rebuilds the database from db/schema.sql, then applies db/seed.sql.
 * Exported so tests/setup.ts can call it directly between tests.
 */
export async function resetDatabase(): Promise<void> {
  const root = process.cwd()
  const schema = await readFile(path.join(root, 'db', 'schema.sql'), 'utf8')
  const seed = await readFile(path.join(root, 'db', 'seed.sql'), 'utf8')
  const client = await getPool().connect()
  try {
    // schema.sql begins by dropping and recreating the public schema, so this
    // is idempotent and needs no separate teardown.
    await client.query(schema)
    await client.query(seed)
  } finally {
    client.release()
  }
}

// Standard ESM main-module check: run the reset only when this file is the
// process entrypoint, never when tests import `resetDatabase` from it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await resetDatabase()
    console.log('Database reset: schema + seed applied.')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    await closePool()
  }
}
```

- [ ] **Step 4: Run the reset and verify the seeded state**

```bash
npm run db:reset
```

Expected: `Database reset: schema + seed applied.`

```bash
docker compose exec -T db psql -U ottodot -d ottodot -c \
  "SELECT c.title, c.capacity, count(b.id) FILTER (WHERE b.status='confirmed') AS confirmed
     FROM trial_classes c LEFT JOIN bookings b ON b.trial_class_id=c.id
    GROUP BY c.id, c.title, c.capacity ORDER BY c.title;"
```

Expected exactly:

```
        title         | capacity | confirmed
----------------------+----------+-----------
 Algebra Foundations  |        4 |         0
 Cells and Microscopes|        4 |         0
 Fractions Deep Dive  |        4 |         3
 Intro to Forces      |        4 |         1
 Light and Shadow     |        4 |         1
```

- [ ] **Step 5: Prove the duplicate-booking index actually rejects**

```bash
docker compose exec -T db psql -U ottodot -d ottodot -c \
  "INSERT INTO bookings (trial_class_id, student_id) VALUES
     ('33333333-3333-3333-3333-333333333303','22222222-2222-2222-2222-222222222201');"
```

Expected: `ERROR: duplicate key value violates unique constraint "bookings_active_unique"`.

Then prove a failed booking may be retried:

```bash
docker compose exec -T db psql -U ottodot -d ottodot -c \
  "INSERT INTO bookings (trial_class_id, student_id) VALUES
     ('33333333-3333-3333-3333-333333333304','22222222-2222-2222-2222-222222222202') RETURNING id;"
```

Expected: succeeds — Omar's existing booking on Class D is `payment_failed`, which the partial index excludes. Run `npm run db:reset` afterwards to undo it.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(db): schema with invariant comments, seed data, and reset script"
```

---

### Task 3: Types, domain errors, and the mock payment gateway

**Files:**
- Create: `src/lib/types.ts`
- Create: `src/lib/booking/errors.ts`
- Create: `src/lib/payments/gateway.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/lib/types.ts`: `BookingStatus`, `PaymentOutcome`, `Booking`, `TrialClassSummary`, `RosterEntry`, `PayResult`, `ParentWithStudents`.
  - `src/lib/booking/errors.ts`: `DomainError` (abstract), `ValidationError`, `NotFoundError`, `DuplicateBookingError`, `IdempotencyKeyReuseError`, `isDomainError(e: unknown): e is DomainError`, `isUniqueViolation(error: unknown, constraint: string): boolean`.
  - `src/lib/payments/gateway.ts`: `authorize(amountCents: number, cardToken: string): Promise<AuthorizeResult>`, `capture(providerRef: string): Promise<void>`, `voidAuthorization(providerRef: string): Promise<void>`, `SUCCESS_CARD_TOKEN`, `DECLINE_CARD_TOKEN`.

- [ ] **Step 1: Write `src/lib/types.ts`**

```ts
export type BookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'payment_failed'
  | 'cancelled_class_full'
  | 'cancelled'

export type PaymentOutcome = 'authorized' | 'captured' | 'failed' | 'voided'

export interface Booking {
  id: string
  trialClassId: string
  studentId: string
  status: BookingStatus
  createdAt: string
  updatedAt: string
}

export interface TrialClassSummary {
  id: string
  title: string
  subject: string
  startsAt: string
  capacity: number
  priceCents: number
  confirmedCount: number
  seatsRemaining: number
}

export interface RosterEntry {
  bookingId: string
  studentId: string
  studentName: string
  gradeLevel: number
  confirmedAt: string
}

export interface PayResult {
  booking: Booking
  /** Null when the booking reached a terminal state with no recorded attempt. */
  outcome: PaymentOutcome | null
  charged: boolean
  message: string
}

export interface StudentSummary {
  id: string
  fullName: string
  gradeLevel: number
}

export interface ParentWithStudents {
  id: string
  fullName: string
  email: string
  students: StudentSummary[]
}
```

- [ ] **Step 2: Write `src/lib/booking/errors.ts`**

```ts
/** Base for every error the service raises deliberately. Each carries the HTTP
 *  status a route handler should map it to, so routes contain no error logic. */
export abstract class DomainError extends Error {
  abstract readonly status: number
  abstract readonly code: string

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class ValidationError extends DomainError {
  readonly status = 400
  readonly code = 'validation_error'
}

export class NotFoundError extends DomainError {
  readonly status = 404
  readonly code = 'not_found'
}

export class DuplicateBookingError extends DomainError {
  readonly status = 409
  readonly code = 'duplicate_booking'

  constructor() {
    super('This child already has a live booking for this class.')
  }
}

export class IdempotencyKeyReuseError extends DomainError {
  readonly status = 409
  readonly code = 'idempotency_key_reuse'

  constructor() {
    super('This Idempotency-Key was already used for a different booking.')
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError
}

const PG_UNIQUE_VIOLATION = '23505'

/**
 * True when `error` is a Postgres unique-violation raised by a named index.
 * Written without `any`: pg errors are untyped at the boundary, so the shape is
 * narrowed explicitly.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  return candidate.code === PG_UNIQUE_VIOLATION && candidate.constraint === constraint
}
```

- [ ] **Step 3: Write `src/lib/payments/gateway.ts`**

```ts
import { randomUUID } from 'node:crypto'

/**
 * Mock payment gateway.
 *
 * THIS MODULE IS THE SEAM where a real provider and its webhooks would attach.
 * With Stripe, `authorize` becomes a PaymentIntent created with
 * `capture_method: 'manual'`, `capture` becomes `paymentIntents.capture`, and
 * `voidAuthorization` becomes `paymentIntents.cancel`. A webhook handler would
 * reconcile out-of-band state changes against the `payment_attempts` table.
 *
 * Behaviour is deterministic, never random: `pm_fail` always declines and every
 * other token always authorizes. A gateway that fails randomly cannot be
 * reviewed and cannot be tested.
 *
 * The functions are async because a real provider is a network call. That is
 * also precisely why authorize is split from capture: an external call cannot
 * participate in a database transaction, so the money decision has to happen
 * after the seat decision.
 */

export const SUCCESS_CARD_TOKEN = 'pm_ok'
export const DECLINE_CARD_TOKEN = 'pm_fail'

export type AuthorizeResult =
  | { ok: true; providerRef: string }
  | { ok: false; declineReason: string }

export async function authorize(
  amountCents: number,
  cardToken: string,
): Promise<AuthorizeResult> {
  if (amountCents < 0) {
    throw new Error('authorize: amountCents must be non-negative')
  }
  if (cardToken === DECLINE_CARD_TOKEN) {
    return { ok: false, declineReason: 'card_declined' }
  }
  return { ok: true, providerRef: `auth_${randomUUID()}` }
}

export async function capture(providerRef: string): Promise<void> {
  if (!providerRef) throw new Error('capture: providerRef is required')
}

export async function voidAuthorization(providerRef: string): Promise<void> {
  if (!providerRef) throw new Error('voidAuthorization: providerRef is required')
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(lib): shared types, typed domain errors, deterministic mock gateway"
```

---

### Task 4: Test harness, read queries, and `createBooking`

**Files:**
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`
- Create: `src/lib/booking/service.ts`
- Create: `tests/booking.test.ts`

**Interfaces:**
- Consumes: `withTransaction`, `getPool`, `closePool` (Task 1); `resetDatabase` (Task 2); all types and errors (Task 3).
- Produces from `src/lib/booking/service.ts`:
  - `createBooking(client: PoolClient, input: { studentId: string; trialClassId: string }): Promise<Booking>`
  - `getBooking(client: PoolClient, bookingId: string): Promise<Booking>`
  - `listTrialClasses(client: PoolClient): Promise<TrialClassSummary[]>`
  - `getRoster(client: PoolClient, trialClassId: string): Promise<RosterEntry[]>`
  - `listParentsWithStudents(client: PoolClient): Promise<ParentWithStudents[]>`
- Produces from `tests/setup.ts`: `PARENTS`, `STUDENTS`, `CLASSES` id constants.

- [ ] **Step 1: Write `vitest.config.ts`**

```ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Both test files share one Postgres and each resets it between tests.
    // Running files in parallel would have them destroy each other's fixtures.
    fileParallelism: false,
    setupFiles: ['./tests/setup.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
```

- [ ] **Step 2: Write `tests/setup.ts`**

```ts
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
```

- [ ] **Step 3: Write the failing tests for reads, `createBooking`, and duplicates**

`tests/booking.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm run test`
Expected: FAIL — `Failed to resolve import "@/lib/booking/service"`.

- [ ] **Step 5: Write `src/lib/booking/service.ts` — reads and `createBooking`**

```ts
import type { PoolClient } from 'pg'
import {
  DuplicateBookingError,
  NotFoundError,
  ValidationError,
  isUniqueViolation,
} from '@/lib/booking/errors'
import type {
  Booking,
  BookingStatus,
  ParentWithStudents,
  RosterEntry,
  StudentSummary,
  TrialClassSummary,
} from '@/lib/types'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new ValidationError(`${field} must be a UUID.`)
  }
}

interface BookingRow {
  id: string
  trial_class_id: string
  student_id: string
  status: BookingStatus
  created_at: Date
  updated_at: Date
}

const BOOKING_COLUMNS =
  'id, trial_class_id, student_id, status, created_at, updated_at'

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    trialClassId: row.trial_class_id,
    studentId: row.student_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export async function createBooking(
  client: PoolClient,
  input: { studentId: string; trialClassId: string },
): Promise<Booking> {
  assertUuid(input.studentId, 'studentId')
  assertUuid(input.trialClassId, 'trialClassId')

  // Existence checks so a bad id produces a clean 404 rather than a raw
  // foreign-key error. These are NOT the duplicate check — see below.
  const cls = await client.query('SELECT 1 FROM trial_classes WHERE id = $1', [
    input.trialClassId,
  ])
  if (cls.rowCount === 0) throw new NotFoundError('Trial class not found.')

  const student = await client.query('SELECT 1 FROM students WHERE id = $1', [
    input.studentId,
  ])
  if (student.rowCount === 0) throw new NotFoundError('Student not found.')

  try {
    const result = await client.query<BookingRow>(
      `INSERT INTO bookings (trial_class_id, student_id, status)
            VALUES ($1, $2, 'pending_payment')
         RETURNING ${BOOKING_COLUMNS}`,
      [input.trialClassId, input.studentId],
    )
    const row = result.rows[0]
    if (!row) throw new Error('INSERT ... RETURNING produced no row')
    return toBooking(row)
  } catch (error) {
    // The partial unique index decides, not a prior SELECT. A check-then-insert
    // has a TOCTOU window that two concurrent requests can both pass.
    if (isUniqueViolation(error, 'bookings_active_unique')) {
      throw new DuplicateBookingError()
    }
    throw error
  }
}

export async function getBooking(
  client: PoolClient,
  bookingId: string,
): Promise<Booking> {
  assertUuid(bookingId, 'bookingId')
  const result = await client.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`,
    [bookingId],
  )
  const row = result.rows[0]
  if (!row) throw new NotFoundError('Booking not found.')
  return toBooking(row)
}

export async function listTrialClasses(
  client: PoolClient,
): Promise<TrialClassSummary[]> {
  // seats_remaining is DERIVED from confirmed bookings on every read. There is
  // no counter column to drift out of sync.
  const result = await client.query<{
    id: string
    title: string
    subject: string
    starts_at: Date
    capacity: number
    price_cents: number
    confirmed_count: number
  }>(
    `SELECT c.id,
            c.title,
            c.subject,
            c.starts_at,
            c.capacity,
            c.price_cents,
            (count(b.id) FILTER (WHERE b.status = 'confirmed'))::int AS confirmed_count
       FROM trial_classes c
       LEFT JOIN bookings b ON b.trial_class_id = c.id
      GROUP BY c.id
      ORDER BY c.starts_at`,
  )
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    subject: row.subject,
    startsAt: row.starts_at.toISOString(),
    capacity: row.capacity,
    priceCents: row.price_cents,
    confirmedCount: row.confirmed_count,
    seatsRemaining: Math.max(row.capacity - row.confirmed_count, 0),
  }))
}

export async function getRoster(
  client: PoolClient,
  trialClassId: string,
): Promise<RosterEntry[]> {
  assertUuid(trialClassId, 'trialClassId')
  // 'confirmed' ONLY. A payment_failed or cancelled_class_full booking must
  // never appear on a roster — that is the third hazard in the brief.
  const result = await client.query<{
    booking_id: string
    student_id: string
    full_name: string
    grade_level: number
    updated_at: Date
  }>(
    `SELECT b.id AS booking_id,
            s.id AS student_id,
            s.full_name,
            s.grade_level,
            b.updated_at
       FROM bookings b
       JOIN students s ON s.id = b.student_id
      WHERE b.trial_class_id = $1
        AND b.status = 'confirmed'
      ORDER BY b.updated_at, b.id`,
    [trialClassId],
  )
  return result.rows.map((row) => ({
    bookingId: row.booking_id,
    studentId: row.student_id,
    studentName: row.full_name,
    gradeLevel: row.grade_level,
    confirmedAt: row.updated_at.toISOString(),
  }))
}

export async function listParentsWithStudents(
  client: PoolClient,
): Promise<ParentWithStudents[]> {
  const result = await client.query<{
    id: string
    full_name: string
    email: string
    students: StudentSummary[] | null
  }>(
    `SELECT p.id,
            p.full_name,
            p.email,
            coalesce(
              json_agg(
                json_build_object(
                  'id', s.id,
                  'fullName', s.full_name,
                  'gradeLevel', s.grade_level
                ) ORDER BY s.full_name
              ) FILTER (WHERE s.id IS NOT NULL),
              '[]'::json
            ) AS students
       FROM parents p
       LEFT JOIN students s ON s.parent_id = p.id
      GROUP BY p.id
      ORDER BY p.full_name`,
  )
  return result.rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    students: row.students ?? [],
  }))
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test`
Expected: PASS — 7 tests in `tests/booking.test.ts`, 0 failures. The `afterEach` invariant runs after each.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add -A
git commit -m "feat(service): read queries and createBooking with constraint-driven duplicate detection"
```

---

### Task 5: `payForBooking` — the seat claim

**Files:**
- Modify: `src/lib/booking/service.ts` (append)
- Modify: `tests/booking.test.ts` (append)

**Interfaces:**
- Consumes: everything from Tasks 1–4, plus `authorize`, `capture`, `voidAuthorization` from `@/lib/payments/gateway`.
- Produces: `payForBooking(client: PoolClient, input: { bookingId: string; idempotencyKey: string; cardToken: string }): Promise<PayResult>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/booking.test.ts` (and extend the import from `@/lib/booking/service` to include `payForBooking`, and from `@/lib/booking/errors` to include `IdempotencyKeyReuseError`; add `import { getPool } from '@/lib/db'`):

```ts
describe('payForBooking', () => {
  async function book(studentId: string, trialClassId: string) {
    return withTransaction((c) => createBooking(c, { studentId, trialClassId }))
  }

  async function pay(bookingId: string, idempotencyKey: string, cardToken: string) {
    return withTransaction((c) =>
      payForBooking(c, { bookingId, idempotencyKey, cardToken }),
    )
  }

  it('confirms the booking and puts the child on the roster', async () => {
    const booking = await book(STUDENTS.ethan, CLASSES.available)
    const result = await pay(booking.id, 'happy-1', 'pm_ok')

    expect(result.booking.status).toBe('confirmed')
    expect(result.outcome).toBe('captured')
    expect(result.charged).toBe(true)

    const roster = await withTransaction((c) => getRoster(c, CLASSES.available))
    expect(roster.map((r) => r.studentName)).toContain('Ethan Tan')
  })

  it('leaves a declined booking off the roster and consumes no seat', async () => {
    const booking = await book(STUDENTS.ethan, CLASSES.available)
    const result = await pay(booking.id, 'decline-1', 'pm_fail')

    expect(result.booking.status).toBe('payment_failed')
    expect(result.outcome).toBe('failed')
    expect(result.charged).toBe(false)

    const roster = await withTransaction((c) => getRoster(c, CLASSES.available))
    expect(roster.map((r) => r.studentName)).not.toContain('Ethan Tan')

    const classes = await withTransaction((c) => listTrialClasses(c))
    expect(classes.find((c) => c.id === CLASSES.available)?.confirmedCount).toBe(1)

    // And the child may book again — the partial index excludes payment_failed.
    const retry = await book(STUDENTS.ethan, CLASSES.available)
    expect(retry.status).toBe('pending_payment')
  })

  it('replaying the same key charges once and returns the same outcome', async () => {
    const booking = await book(STUDENTS.ethan, CLASSES.available)
    const first = await pay(booking.id, 'idem-1', 'pm_ok')
    const second = await pay(booking.id, 'idem-1', 'pm_ok')

    expect(first.booking.status).toBe('confirmed')
    expect(second.booking.status).toBe('confirmed')
    expect(second.charged).toBe(true)

    const { rows } = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM payment_attempts WHERE booking_id = $1',
      [booking.id],
    )
    expect(rows[0]?.n).toBe(1)
  })

  it('rejects an idempotency key already used for a different booking', async () => {
    const first = await book(STUDENTS.ethan, CLASSES.available)
    const second = await book(STUDENTS.daniel, CLASSES.available)

    await pay(first.id, 'shared-key', 'pm_ok')

    // Returning the other booking's outcome would be worse than failing loudly.
    await expect(pay(second.id, 'shared-key', 'pm_ok')).rejects.toBeInstanceOf(
      IdempotencyKeyReuseError,
    )
  })

  it('404s on an unknown booking', async () => {
    await expect(
      pay('44444444-4444-4444-4444-4444444444ff', 'missing-1', 'pm_ok'),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test`
Expected: FAIL — `payForBooking is not exported by @/lib/booking/service`.

- [ ] **Step 3: Append `payForBooking` and its helpers to `src/lib/booking/service.ts`**

Add these imports at the top of the file:

```ts
import { authorize, capture, voidAuthorization } from '@/lib/payments/gateway'
import { IdempotencyKeyReuseError } from '@/lib/booking/errors'
import type { PayResult, PaymentOutcome } from '@/lib/types'
```

Then append:

```ts
/** One message per terminal status, shared by fresh results and idempotent
 *  replays so a replay can never describe the outcome differently. */
const STATUS_MESSAGES: Record<BookingStatus, string> = {
  pending_payment: 'Awaiting payment.',
  confirmed: 'Payment received. The trial class is confirmed.',
  payment_failed:
    'Payment was declined. No seat was taken and you were not charged. You can try booking again.',
  cancelled_class_full:
    'This class filled up while your payment was being processed. Your card was authorized but never charged, and the authorization has been released.',
  cancelled: 'This booking was cancelled.',
}

function toPayResult(booking: Booking, outcome: PaymentOutcome | null): PayResult {
  return {
    booking,
    outcome,
    charged: booking.status === 'confirmed',
    message: STATUS_MESSAGES[booking.status],
  }
}

async function recordAttempt(
  client: PoolClient,
  input: {
    bookingId: string
    idempotencyKey: string
    outcome: PaymentOutcome
    amountCents: number
    providerRef: string | null
  },
): Promise<void> {
  await client.query(
    `INSERT INTO payment_attempts
       (booking_id, idempotency_key, outcome, amount_cents, provider_ref)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.bookingId,
      input.idempotencyKey,
      input.outcome,
      input.amountCents,
      input.providerRef,
    ],
  )
}

async function setStatus(
  client: PoolClient,
  bookingId: string,
  status: BookingStatus,
): Promise<Booking> {
  const result = await client.query<BookingRow>(
    `UPDATE bookings SET status = $2 WHERE id = $1 RETURNING ${BOOKING_COLUMNS}`,
    [bookingId, status],
  )
  const row = result.rows[0]
  if (!row) throw new NotFoundError('Booking not found.')
  return toBooking(row)
}

async function latestOutcome(
  client: PoolClient,
  bookingId: string,
): Promise<PaymentOutcome | null> {
  const result = await client.query<{ outcome: PaymentOutcome }>(
    `SELECT outcome FROM payment_attempts
      WHERE booking_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [bookingId],
  )
  return result.rows[0]?.outcome ?? null
}

/**
 * Claims a seat and settles payment, in one transaction.
 *
 * LOCK ORDER: booking, then class. Always, in every path. That fixed order is
 * what makes deadlock impossible.
 *
 * The sequence is authorize -> claim -> capture rather than charge -> claim.
 * A payment provider is an external network call and cannot participate in a
 * database transaction, so capturing money before securing the seat would leave
 * the race loser charged for a class they never got, and recovery would become
 * a refund workflow. Splitting authorize from capture moves the money decision
 * after the seat decision, so the loser's authorization is simply voided.
 */
export async function payForBooking(
  client: PoolClient,
  input: { bookingId: string; idempotencyKey: string; cardToken: string },
): Promise<PayResult> {
  assertUuid(input.bookingId, 'bookingId')
  if (input.idempotencyKey.trim() === '') {
    throw new ValidationError('An Idempotency-Key is required.')
  }
  if (input.cardToken.trim() === '') {
    throw new ValidationError('A cardToken is required.')
  }

  // ---- Lock 1 of 2: the booking. -----------------------------------------
  // Serializes concurrent retries of the SAME booking against each other.
  const bookingResult = await client.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1 FOR UPDATE`,
    [input.bookingId],
  )
  const bookingRow = bookingResult.rows[0]
  if (!bookingRow) throw new NotFoundError('Booking not found.')

  // Idempotent replay: this booking already reached a terminal state, so return
  // that outcome unchanged rather than charging again.
  if (bookingRow.status !== 'pending_payment') {
    return toPayResult(
      toBooking(bookingRow),
      await latestOutcome(client, bookingRow.id),
    )
  }

  // Idempotency key. The unique index on payment_attempts.idempotency_key is
  // GLOBAL, so a key seen before may belong to another booking entirely.
  const priorResult = await client.query<{
    booking_id: string
    outcome: PaymentOutcome
  }>(
    'SELECT booking_id, outcome FROM payment_attempts WHERE idempotency_key = $1',
    [input.idempotencyKey],
  )
  const prior = priorResult.rows[0]
  if (prior) {
    if (prior.booking_id !== bookingRow.id) {
      // Same key, different booking: the caller has a bug. Returning another
      // booking's outcome would be worse than failing loudly.
      throw new IdempotencyKeyReuseError()
    }
    return toPayResult(toBooking(bookingRow), prior.outcome)
  }

  // Plain read, NO lock. Reading the price must not take the seat gate: a card
  // that is about to be declined has no business contending for the class row.
  const priceResult = await client.query<{ price_cents: number }>(
    'SELECT price_cents FROM trial_classes WHERE id = $1',
    [bookingRow.trial_class_id],
  )
  const priceRow = priceResult.rows[0]
  if (!priceRow) throw new NotFoundError('Trial class not found.')

  const auth = await authorize(priceRow.price_cents, input.cardToken)

  if (!auth.ok) {
    await recordAttempt(client, {
      bookingId: bookingRow.id,
      idempotencyKey: input.idempotencyKey,
      outcome: 'failed',
      amountCents: priceRow.price_cents,
      providerRef: null,
    })
    // NO CLASS ROW IS TOUCHED. A declined card never consumes a seat and never
    // contends for the class lock.
    return toPayResult(await setStatus(client, bookingRow.id, 'payment_failed'), 'failed')
  }

  // ---- Lock 2 of 2: the class. The seat gate. -----------------------------
  // Concurrent claims on the same class serialize HERE. Taken after the booking
  // lock, always.
  const classResult = await client.query<{ capacity: number }>(
    'SELECT capacity FROM trial_classes WHERE id = $1 FOR UPDATE',
    [bookingRow.trial_class_id],
  )
  const classRow = classResult.rows[0]
  if (!classRow) throw new NotFoundError('Trial class not found.')

  // Counted under the lock, from confirmed bookings — the single source of truth.
  const countResult = await client.query<{ confirmed: number }>(
    `SELECT count(*)::int AS confirmed
       FROM bookings
      WHERE trial_class_id = $1 AND status = 'confirmed'`,
    [bookingRow.trial_class_id],
  )
  const confirmed = countResult.rows[0]?.confirmed ?? 0

  if (confirmed >= classRow.capacity) {
    // Lost the race. Void the authorization so no money ever moves.
    await voidAuthorization(auth.providerRef)
    await recordAttempt(client, {
      bookingId: bookingRow.id,
      idempotencyKey: input.idempotencyKey,
      outcome: 'voided',
      amountCents: priceRow.price_cents,
      providerRef: auth.providerRef,
    })
    return toPayResult(
      await setStatus(client, bookingRow.id, 'cancelled_class_full'),
      'voided',
    )
  }

  await capture(auth.providerRef)
  await recordAttempt(client, {
    bookingId: bookingRow.id,
    idempotencyKey: input.idempotencyKey,
    outcome: 'captured',
    amountCents: priceRow.price_cents,
    providerRef: auth.providerRef,
  })
  return toPayResult(await setStatus(client, bookingRow.id, 'confirmed'), 'captured')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test`
Expected: PASS — 12 tests, 0 failures.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add -A
git commit -m "feat(service): payForBooking with authorize-claim-capture and idempotency"
```

---

### Task 6: The concurrency tests

**Files:**
- Create: `tests/concurrency.test.ts`

**Interfaces:**
- Consumes: `withTransaction` (Task 1), `createBooking` / `payForBooking` (Tasks 4–5), `CLASSES` / `STUDENTS` (Task 4).
- Produces: nothing consumed by later tasks. This task is the proof.

> No implementation change is expected here. If either test fails, the bug is in Task 5's lock ordering, not in the test.

- [ ] **Step 1: Write `tests/concurrency.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { withTransaction } from '@/lib/db'
import { createBooking, payForBooking } from '@/lib/booking/service'
import type { BookingStatus } from '@/lib/types'
import { CLASSES, STUDENTS } from './setup'

/**
 * Each actor runs inside its OWN `withTransaction` call, which checks out its
 * own client from the pool. That is what makes these tests genuinely
 * concurrent.
 *
 * The tempting alternative — checking out one PoolClient and handing it to
 * every actor in the Promise.all — serializes every statement onto a single
 * wire. Those tests still go green, and prove nothing at all.
 */
function bookAsSeparateUser(studentId: string, trialClassId: string) {
  return withTransaction((client) =>
    createBooking(client, { studentId, trialClassId }),
  )
}

function payAsSeparateUser(bookingId: string, idempotencyKey: string) {
  return withTransaction((client) =>
    payForBooking(client, { bookingId, idempotencyKey, cardToken: 'pm_ok' }),
  )
}

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
      bookAsSeparateUser(STUDENTS.ethan, CLASSES.lastSeat),
      bookAsSeparateUser(STUDENTS.priya, CLASSES.lastSeat),
    ])

    // Both now hold pending_payment. PENDING DOES NOT RESERVE A SEAT — this is
    // exactly the brief's scenario, where B can select the slot A is already
    // paying for.
    const results = await Promise.all([
      payAsSeparateUser(bookingA.id, 'race-a'),
      payAsSeparateUser(bookingB.id, 'race-b'),
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
      studentIds.map((studentId) => bookAsSeparateUser(studentId, CLASSES.empty)),
    )

    const results = await Promise.all(
      bookings.map((booking, index) =>
        payAsSeparateUser(booking.id, `load-${index}`),
      ),
    )

    expect(tally(results.map((r) => r.booking.status))).toEqual({
      confirmed: 4,
      cancelled_class_full: 2,
    })
    expect(results.filter((r) => r.charged)).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `npm run test`
Expected: PASS — 14 tests total, 0 failures. The `afterEach` capacity invariant runs after every one.

If the load test reports `confirmed: 6`, the class lock is missing or is taken before the booking lock — fix Task 5, not this test.

- [ ] **Step 3: Mutation check — prove these tests can actually fail**

A concurrency test that passes for the wrong reason is worse than no test. Prove
these two detect the bug they exist to catch, by temporarily removing the seat
gate.

In `src/lib/booking/service.ts`, drop `FOR UPDATE` from the class lock:

```ts
  // TEMPORARY — revert immediately after observing the failure.
  const classResult = await client.query<{ capacity: number }>(
    'SELECT capacity FROM trial_classes WHERE id = $1',
    [bookingRow.trial_class_id],
  )
```

Run: `npm run test`

Expected: **both concurrency tests FAIL**, and the `afterEach` capacity invariant
fails alongside them. Without the lock, each transaction reads the confirmed
count under READ COMMITTED before its neighbours commit, so several actors all
see room and all confirm — the overbooking test reports more than 4 confirmed.

Restore `FOR UPDATE` and re-run. Expected: green.

Note what this experiment does *not* prove, and do not substitute it: shrinking
the pool to `max: 1` would leave both tests **passing**, because six actors on
one connection simply run serially and still produce the right totals. That is
precisely the false green this whole design guards against — correct results,
zero concurrency exercised.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: last-seat race and overbooking-under-load against real Postgres"
```

---

### Task 7: API route handlers

**Files:**
- Create: `src/app/api/trial-classes/route.ts`
- Create: `src/app/api/trial-classes/[id]/roster/route.ts`
- Create: `src/app/api/bookings/route.ts`
- Create: `src/app/api/bookings/[id]/route.ts`
- Create: `src/app/api/bookings/[id]/pay/route.ts`
- Modify: `src/lib/booking/errors.ts` (append `toErrorResponse`)

**Interfaces:**
- Consumes: `withTransaction`, all service functions, all error classes.
- Produces: the five HTTP endpoints, plus `toErrorResponse(error: unknown): Response` in `errors.ts`, used by every route.

> In Next 15, dynamic route `params` is a **Promise**. Every handler below awaits it. Getting this wrong is the most common Next 15 migration error.

- [ ] **Step 1: Append the error-to-response mapper to `src/lib/booking/errors.ts`**

```ts
/** Maps a thrown value to an HTTP response. This is the ONLY error logic in the
 *  API layer — route handlers just call it. */
export function toErrorResponse(error: unknown): Response {
  if (isDomainError(error)) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    )
  }
  console.error('Unhandled error in route handler:', error)
  return Response.json(
    { error: { code: 'internal_error', message: 'Something went wrong.' } },
    { status: 500 },
  )
}
```

- [ ] **Step 2: Write `src/app/api/trial-classes/route.ts`**

```ts
import { withTransaction } from '@/lib/db'
import { listTrialClasses } from '@/lib/booking/service'
import { toErrorResponse } from '@/lib/booking/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    const classes = await withTransaction((client) => listTrialClasses(client))
    return Response.json({ trialClasses: classes })
  } catch (error) {
    return toErrorResponse(error)
  }
}
```

- [ ] **Step 3: Write `src/app/api/trial-classes/[id]/roster/route.ts`**

```ts
import { withTransaction } from '@/lib/db'
import { getRoster } from '@/lib/booking/service'
import { toErrorResponse } from '@/lib/booking/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params
    const roster = await withTransaction((client) => getRoster(client, id))
    return Response.json({ roster })
  } catch (error) {
    return toErrorResponse(error)
  }
}
```

- [ ] **Step 4: Write `src/app/api/bookings/route.ts`**

```ts
import { withTransaction } from '@/lib/db'
import { createBooking } from '@/lib/booking/service'
import { ValidationError, toErrorResponse } from '@/lib/booking/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null)
    if (typeof body !== 'object' || body === null) {
      throw new ValidationError('A JSON body is required.')
    }
    const { studentId, trialClassId } = body as {
      studentId?: unknown
      trialClassId?: unknown
    }
    if (typeof studentId !== 'string' || typeof trialClassId !== 'string') {
      throw new ValidationError('studentId and trialClassId are required strings.')
    }

    const booking = await withTransaction((client) =>
      createBooking(client, { studentId, trialClassId }),
    )
    return Response.json({ booking }, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
```

- [ ] **Step 5: Write `src/app/api/bookings/[id]/route.ts`**

```ts
import { withTransaction } from '@/lib/db'
import { getBooking } from '@/lib/booking/service'
import { toErrorResponse } from '@/lib/booking/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params
    const booking = await withTransaction((client) => getBooking(client, id))
    return Response.json({ booking })
  } catch (error) {
    return toErrorResponse(error)
  }
}
```

- [ ] **Step 6: Write `src/app/api/bookings/[id]/pay/route.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { withTransaction } from '@/lib/db'
import { payForBooking } from '@/lib/booking/service'
import { ValidationError, toErrorResponse } from '@/lib/booking/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params
    const body: unknown = await request.json().catch(() => null)
    const fields =
      typeof body === 'object' && body !== null
        ? (body as { cardToken?: unknown; idempotencyKey?: unknown })
        : {}

    // Narrowed into a local so the call site needs no cast.
    const cardToken = fields.cardToken
    if (typeof cardToken !== 'string') {
      throw new ValidationError('cardToken is required.')
    }

    // Header first, body field as a fallback, generated as a last resort so a
    // curl example without a key still works exactly once.
    const headerKey = request.headers.get('Idempotency-Key')
    const bodyKey =
      typeof fields.idempotencyKey === 'string' ? fields.idempotencyKey : null
    const idempotencyKey = headerKey ?? bodyKey ?? randomUUID()

    const result = await withTransaction((client) =>
      payForBooking(client, { bookingId: id, idempotencyKey, cardToken }),
    )
    return Response.json(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}
```

- [ ] **Step 7: Verify every endpoint with curl**

```bash
npm run db:reset
npm run dev &
sleep 6
```

```bash
curl -s localhost:3000/api/trial-classes | head -c 400
```
Expected: JSON with five classes; the race class shows `"seatsRemaining":1`.

```bash
curl -s -X POST localhost:3000/api/bookings \
  -H 'content-type: application/json' \
  -d '{"studentId":"22222222-2222-2222-2222-222222222201","trialClassId":"33333333-3333-3333-3333-333333333303"}'
```
Expected: HTTP 409, `{"error":{"code":"duplicate_booking",…}}`.

```bash
BOOKING=$(curl -s -X POST localhost:3000/api/bookings \
  -H 'content-type: application/json' \
  -d '{"studentId":"22222222-2222-2222-2222-222222222204","trialClassId":"33333333-3333-3333-3333-333333333302"}' \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
curl -s -X POST "localhost:3000/api/bookings/$BOOKING/pay" \
  -H 'content-type: application/json' -H 'Idempotency-Key: demo-1' \
  -d '{"cardToken":"pm_ok"}'
```
Expected: `"status":"confirmed"`, `"charged":true`.

Replay the identical command. Expected: the same response, and still one row in `payment_attempts`.

```bash
curl -s localhost:3000/api/trial-classes/33333333-3333-3333-3333-333333333304/roster
```
Expected: `{"roster":[]}` — the payment_failed booking is absent.

Stop the dev server (`kill %1`).

- [ ] **Step 8: Typecheck, build, commit**

```bash
npm run typecheck && npm run build
git add -A
git commit -m "feat(api): five route handlers with typed-error to status mapping"
```

---

### Task 8: The three UI pages

**Files:**
- Create: `src/app/_components/booking-form.tsx`
- Create: `src/app/_components/pay-buttons.tsx`
- Modify: `src/app/page.tsx`
- Create: `src/app/bookings/[id]/page.tsx`
- Create: `src/app/admin/page.tsx`
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Consumes: `withTransaction`, `listParentsWithStudents`, `listTrialClasses`, `getBooking`, `getRoster`, and the API routes from Task 7 (the two client components POST to them).
- Produces: nothing consumed by later tasks.

> Pages are server components that call the service directly. The two client components POST to the Task 7 API routes and then `router.refresh()`. **Tailwind only, legible, unstyled-adjacent — do not spend time here.** The brief is explicit that frontend polish is not graded.

- [ ] **Step 1: Write `src/app/_components/booking-form.tsx`**

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ParentWithStudents, TrialClassSummary } from '@/lib/types'

export function BookingForm({
  parents,
  trialClasses,
}: {
  parents: ParentWithStudents[]
  trialClasses: TrialClassSummary[]
}) {
  const router = useRouter()
  const [parentId, setParentId] = useState(parents[0]?.id ?? '')
  const [studentId, setStudentId] = useState(parents[0]?.students[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const students = parents.find((p) => p.id === parentId)?.students ?? []

  async function book(trialClassId: string) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ studentId, trialClassId }),
    })
    const payload: unknown = await response.json()
    setBusy(false)

    if (!response.ok) {
      const message =
        typeof payload === 'object' && payload !== null && 'error' in payload
          ? String((payload as { error: { message?: string } }).error.message)
          : 'Booking failed.'
      setError(message)
      return
    }
    const booking = (payload as { booking: { id: string } }).booking
    router.push(`/bookings/${booking.id}`)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col text-sm">
          Parent
          <select
            className="mt-1 border p-2"
            value={parentId}
            onChange={(e) => {
              const next = e.target.value
              setParentId(next)
              setStudentId(
                parents.find((p) => p.id === next)?.students[0]?.id ?? '',
              )
            }}
          >
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col text-sm">
          Child
          <select
            className="mt-1 border p-2"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
          >
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName} (grade {s.gradeLevel})
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <p className="border border-red-500 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <ul className="space-y-2">
        {trialClasses.map((c) => (
          <li key={c.id} className="flex items-center justify-between border p-3">
            <span>
              <strong>{c.title}</strong> — {c.subject} · $
              {(c.priceCents / 100).toFixed(2)}
              <br />
              <span className="text-sm text-gray-600">
                {c.seatsRemaining} of {c.capacity} seats remaining
              </span>
            </span>
            <button
              type="button"
              className="border px-3 py-1 disabled:opacity-40"
              disabled={busy || studentId === '' || c.seatsRemaining === 0}
              onClick={() => void book(c.id)}
            >
              Book trial
            </button>
          </li>
        ))}
      </ul>

      {/* The disabled state above only avoids an obviously wasted click. It is
          NOT what prevents overbooking — the database is. A class can fill
          between this page rendering and the button being pressed. */}
    </div>
  )
}
```

- [ ] **Step 2: Write `src/app/_components/pay-buttons.tsx`**

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function PayButtons({ bookingId }: { bookingId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function pay(cardToken: string) {
    setBusy(true)
    const response = await fetch(`/api/bookings/${bookingId}/pay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // A stable key per booking, so double-clicking cannot double-charge.
        'Idempotency-Key': `ui-${bookingId}`,
      },
      body: JSON.stringify({ cardToken }),
    })
    const payload: unknown = await response.json()
    setBusy(false)
    if (typeof payload === 'object' && payload !== null && 'message' in payload) {
      setMessage(String((payload as { message: string }).message))
    } else if (
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload
    ) {
      setMessage(String((payload as { error: { message: string } }).error.message))
    }
    router.refresh()
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <button
          type="button"
          className="border px-3 py-1 disabled:opacity-40"
          disabled={busy}
          onClick={() => void pay('pm_ok')}
        >
          Pay (success)
        </button>
        <button
          type="button"
          className="border px-3 py-1 disabled:opacity-40"
          disabled={busy}
          onClick={() => void pay('pm_fail')}
        >
          Pay (declined card)
        </button>
      </div>
      {message ? <p className="border bg-gray-50 p-3 text-sm">{message}</p> : null}
    </div>
  )
}
```

- [ ] **Step 3: Replace `src/app/page.tsx`**

```tsx
import { BookingForm } from '@/app/_components/booking-form'
import { withTransaction } from '@/lib/db'
import { listParentsWithStudents, listTrialClasses } from '@/lib/booking/service'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const { parents, trialClasses } = await withTransaction(async (client) => ({
    parents: await listParentsWithStudents(client),
    trialClasses: await listTrialClasses(client),
  }))

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Book a trial class</h1>
      <BookingForm parents={parents} trialClasses={trialClasses} />
    </main>
  )
}
```

- [ ] **Step 4: Write `src/app/bookings/[id]/page.tsx`**

```tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PayButtons } from '@/app/_components/pay-buttons'
import { withTransaction } from '@/lib/db'
import { getBooking, listTrialClasses } from '@/lib/booking/service'
import { NotFoundError } from '@/lib/booking/errors'
import type { Booking, TrialClassSummary } from '@/lib/types'

export const dynamic = 'force-dynamic'

const STATUS_COPY: Record<string, string> = {
  pending_payment: 'Awaiting payment.',
  confirmed: 'Confirmed. Your child has a seat in this class.',
  payment_failed:
    'The card was declined. No seat was taken and you were not charged — you can book again.',
  cancelled_class_full:
    'This class filled up while your payment was being processed. Your card was authorized but never charged, and the authorization has been released. You have not been charged anything.',
  cancelled: 'This booking was cancelled.',
}

export default async function BookingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  let booking: Booking
  let trialClasses: TrialClassSummary[]
  try {
    const loaded = await withTransaction(async (client) => ({
      booking: await getBooking(client, id),
      trialClasses: await listTrialClasses(client),
    }))
    booking = loaded.booking
    trialClasses = loaded.trialClasses
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    throw error
  }

  const trialClass = trialClasses.find((c) => c.id === booking.trialClassId)

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Booking</h1>
      <dl className="space-y-1 text-sm">
        <div>
          <dt className="inline font-semibold">Class: </dt>
          <dd className="inline">{trialClass?.title ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Status: </dt>
          <dd className="inline font-mono">{booking.status}</dd>
        </div>
      </dl>
      <p className="border bg-gray-50 p-3">{STATUS_COPY[booking.status]}</p>

      {booking.status === 'pending_payment' ? (
        <PayButtons bookingId={booking.id} />
      ) : null}

      <Link className="underline" href="/">
        Back to classes
      </Link>
    </main>
  )
}
```

- [ ] **Step 5: Write `src/app/admin/page.tsx`**

```tsx
import { withTransaction } from '@/lib/db'
import { getRoster, listTrialClasses } from '@/lib/booking/service'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const classesWithRosters = await withTransaction(async (client) => {
    const trialClasses = await listTrialClasses(client)
    return Promise.all(
      trialClasses.map(async (trialClass) => ({
        trialClass,
        roster: await getRoster(client, trialClass.id),
      })),
    )
  })

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Rosters</h1>
      {classesWithRosters.map(({ trialClass, roster }) => (
        <section key={trialClass.id} className="border p-4">
          <h2 className="font-semibold">{trialClass.title}</h2>
          <p className="text-sm text-gray-600">
            {trialClass.confirmedCount} of {trialClass.capacity} confirmed ·{' '}
            {trialClass.seatsRemaining} remaining
          </p>
          {roster.length === 0 ? (
            <p className="mt-2 text-sm italic">No confirmed students yet.</p>
          ) : (
            <ol className="mt-2 list-decimal pl-6 text-sm">
              {roster.map((entry) => (
                <li key={entry.bookingId}>
                  {entry.studentName} (grade {entry.gradeLevel})
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
    </main>
  )
}
```

- [ ] **Step 6: Add navigation to `src/app/layout.tsx`**

Inside the existing `<body>`, above `{children}`:

```tsx
        <nav className="border-b p-4 text-sm">
          <a className="mr-4 underline" href="/">
            Book
          </a>
          <a className="underline" href="/admin">
            Rosters
          </a>
        </nav>
```

- [ ] **Step 7: Walk the three pages manually**

```bash
npm run db:reset
npm run dev
```

Check, in a browser:
1. `/` — switching parent changes the child list. The race class shows "1 of 4 seats remaining".
2. Book the race class for Ethan Tan → redirects to `/bookings/<id>` showing `pending_payment`.
3. "Pay (declined card)" → status becomes `payment_failed` with the no-charge copy.
4. Book again for Ethan, then "Pay (success)" → `confirmed`.
5. `/admin` — the race class now shows 4 of 4 confirmed with Ethan on the roster; the payment-failed class shows an empty roster.

- [ ] **Step 8: Typecheck, build, commit**

```bash
npm run typecheck && npm run lint && npm run build
git add -A
git commit -m "feat(ui): booking, status, and roster pages"
```

---

### Task 9: README, AI_USAGE, and final verification

**Files:**
- Modify: `README.md` (replace the create-next-app default entirely)
- Create: `AI_USAGE.md`

**Interfaces:**
- Consumes: everything.
- Produces: the submission.

- [ ] **Step 1: Write `README.md`**

Required sections, in the brief's order: how to run; what was built; time spent; assumptions; key architecture and backend decisions; what was deliberately cut; what to monitor after release; what to do next with more time. Plus the two the brief names explicitly: **Last-Seat Race** and **Backend Design**.

Content to pull verbatim from the spec:
- §6 for the seat-claim sequence, the authorize→claim→capture rationale, the FK/`FOR UPDATE` lock subsection, and the four rejected alternatives.
- §15 for the monitoring list and the next-steps list.
- §2 for the cut list.

Non-negotiable content:

- The **time spent** line must be exactly:
  `**Time spent:** <!-- HUMAN: fill in the real number before submitting -->`
- A plain statement that **pending bookings do not reserve seats**, and that this matches the brief's scenario where User B can select the slot User A is already paying for.
- A table naming where each check lives:

| Check | UI | Backend | Database |
|---|---|---|---|
| Class appears full | Greys out the button | — | — |
| Duplicate booking | — | Translates 23505 → 409 | `bookings_active_unique` **decides** |
| Overbooking past capacity | — | Counts under lock | `FOR UPDATE` on the class **decides** |
| Payment failure off roster | — | Sets `payment_failed`, touches no class row | Roster query filters `status = 'confirmed'` |
| Double-charge on replay | Sends a stable key | Returns the prior outcome | `payment_attempts_idem` **decides** |

- A one-line note that any Postgres works: point `DATABASE_URL` at Supabase or Neon and it runs unmodified.
- The run sequence: `docker compose up -d` → `cp .env.example .env` → `npm install` → `npm run db:reset` → `npm run test` → `npm run dev`.

- [ ] **Step 2: Write `AI_USAGE.md`**

```markdown
# AI Usage

## Which AI tools I used

Claude Code (Opus 4.8) in the terminal.

## What I used AI for

<!-- Describe factually: brainstorming the design against the brief, drafting the
     schema and service layer, writing the test suite, drafting this README. -->

## One place AI helped me move faster

<!-- Describe factually. -->

## One place I disagreed with, corrected, or rejected AI output

<!-- HUMAN: fill this in with the real instance -->

## What I would change about my AI workflow next time

<!-- Describe factually. -->

## How I verified the final implementation

<!-- Describe factually: the test suite against real Postgres, the curl walkthrough,
     the manual UI pass, and the pool-size experiment that proves the concurrency
     tests are genuinely concurrent. -->
```

**Do not fabricate anything in this file.** Fill each section only from what is factually observable in the build session. Leave the "disagreed with" section as the bare HTML comment.

- [ ] **Step 3: Full clean-checkout verification**

```bash
docker compose down -v
docker compose up -d
sleep 10
rm -rf node_modules .next
npm install
npm run db:reset
npm run test
npm run typecheck
npm run lint
npm run build
```

Expected: 14 tests pass, and typecheck, lint, and build all exit 0.

- [ ] **Step 4: Placeholder sweep**

```bash
grep -rn "TODO\|FIXME\|TBD\|PLACEHOLDER" --include="*.ts" --include="*.tsx" --include="*.sql" --include="*.md" \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.local-refs --exclude-dir=docs .
```

Expected: exactly two hits, both the marked `<!-- HUMAN: … -->` fields (README time spent, AI_USAGE rejected output). Anything else is a bug.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: README with last-seat-race and backend-design sections, AI_USAGE skeleton"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §3 stack → T1; §4 data model and indexes → T2; §5 lifecycle → T5, T7; §6 seat claim, lock order, FK note → T5, T9; §7 idempotency → T5; §8 gateway → T3; §9 routes → T7; §10 UI → T8; §11 tests → T4, T5, T6; §12 seed → T2; §13 structure → T1–T8; §14 quality rules → Global Constraints and T1 Step 9; §15 README → T9; §16 AI_USAGE → T9; §17 done criteria → T9 Steps 3–4.

**Known deviations from the spec, both deliberate and both flagged in place:**
1. **T2** seeds 6 students and 5 classes rather than 5 and 4. The overbooking-under-load test needs six distinct students on one untouched empty class; `bookings_active_unique` forbids reusing a student, so five students cannot express the test.
2. **T8** adds `src/app/_components/` (two client components), which the spec's file tree does not list. Server components cannot carry `onClick`, so the interactive parts have to live somewhere.

**Type consistency.** `getPool`/`withTransaction`/`closePool` (T1) are used identically in T2, T4, T5, T6, T7, T8. `BOOKING_COLUMNS`, `BookingRow`, `toBooking`, and `assertUuid` are defined in T4 Step 5 and reused unchanged in T5 Step 3. `PayResult.outcome` is `PaymentOutcome | null` in T3 and every producer in T5 honours that. `voidAuthorization` — never `void`, which is a reserved word in that position — is named consistently in T3 and T5. `CLASSES`/`STUDENTS` keys defined in T4 Step 2 match every use in T5 and T6.
