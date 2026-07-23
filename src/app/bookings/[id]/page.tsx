import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PayButtons } from '@/app/_components/pay-buttons'
import { withTransaction } from '@/lib/db'
import {
  getBooking,
  getStudent,
  listTrialClasses,
  STATUS_MESSAGES,
} from '@/lib/booking/service'
import { NotFoundError } from '@/lib/booking/errors'
import type { Booking, StudentSummary, TrialClassSummary } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function BookingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  let booking: Booking
  let student: StudentSummary
  let trialClasses: TrialClassSummary[]
  try {
    const loaded = await withTransaction(async (client) => {
      // Sequential awaits on one shared connection: getStudent needs the
      // booking's studentId, and a single pg client runs one query at a time.
      const found = await getBooking(client, id)
      return {
        booking: found,
        student: await getStudent(client, found.studentId),
        trialClasses: await listTrialClasses(client),
      }
    })
    booking = loaded.booking
    student = loaded.student
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
          <dt className="inline font-semibold">Student: </dt>
          <dd className="inline">
            {student.fullName} (grade {student.gradeLevel})
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold">Class: </dt>
          <dd className="inline">{trialClass?.title ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Status: </dt>
          <dd className="inline font-mono">{booking.status}</dd>
        </div>
      </dl>
      <p className="border bg-gray-500 p-3">{STATUS_MESSAGES[booking.status]}</p>

      {booking.status === 'pending_payment' ? (
        <PayButtons bookingId={booking.id} />
      ) : null}

      <Link className="underline" href="/">
        Back to classes
      </Link>
    </main>
  )
}
