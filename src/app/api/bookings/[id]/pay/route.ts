import { randomUUID } from 'node:crypto'
import { withTransaction } from '@/lib/db'
import { payForBooking } from '@/lib/booking/service'
import { ValidationError, toErrorResponse } from '@/lib/booking/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Type predicate rather than an `as` cast: narrows `unknown` to an indexable
// record without asserting anything about its shape.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params
    const body: unknown = await request.json().catch(() => null)
    const fields: Record<string, unknown> = isRecord(body) ? body : {}

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
