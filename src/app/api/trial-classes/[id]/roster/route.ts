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
