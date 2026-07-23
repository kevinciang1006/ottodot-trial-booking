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
