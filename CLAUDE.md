# Ottodot Trial Booking — working rules

## What this is
A take-home. Graded on backend correctness, edge cases, and explanation —
explicitly not on frontend polish or feature breadth. Adding features is a
failure mode, not a bonus. The scope is fixed by
`docs/design.md`.

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
    docker compose up -d    # Postgres 16 on localhost:5434
    npm run db:reset        # drop, apply db/schema.sql, apply db/seed.sql
    npm run test            # Vitest against the real database
    npm run dev
