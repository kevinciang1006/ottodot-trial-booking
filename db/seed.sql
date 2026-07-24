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
