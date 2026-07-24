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
