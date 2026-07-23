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
