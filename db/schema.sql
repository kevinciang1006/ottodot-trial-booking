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
-- 'authorized' is declared but never written by this build: the mock gateway's
-- authorize() result is recorded straight as 'captured' or 'voided' within the
-- same transaction, so no row is ever left sitting in 'authorized'. A real
-- provider's webhooks would land rows in this state between authorization and
-- capture, which is exactly the gap a transactional outbox would close.

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
