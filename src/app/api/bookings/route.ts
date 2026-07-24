import { withTransaction } from '@/lib/db'
import { createBooking } from '@/lib/booking/service'
import { ValidationError, isRecord, toErrorResponse } from '@/lib/booking/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Type predicate rather than an `as` cast: narrows `unknown` to an indexable
// record without asserting anything about its shape.
export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null)
    if (!isRecord(body)) {
      throw new ValidationError('A JSON body is required.')
    }
    const { studentId, trialClassId } = body
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
