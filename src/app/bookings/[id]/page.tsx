import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PayButtons } from '@/app/_components/pay-buttons'
import { withTransaction } from '@/lib/db'
import { getBooking, listTrialClasses } from '@/lib/booking/service'
import { NotFoundError } from '@/lib/booking/errors'
import type { Booking, BookingStatus, TrialClassSummary } from '@/lib/types'

export const dynamic = 'force-dynamic'

// Keyed by BookingStatus, not string: adding a status to the enum without copy
// for it becomes a type error rather than a silently blank paragraph.
const STATUS_COPY: Record<BookingStatus, string> = {
  pending_payment: 'Awaiting payment.',
  confirmed: 'Confirmed. Your child has a seat in this class.',
  payment_failed:
    'The card was declined. No seat was taken and you were not charged — you can book again.',
  cancelled_class_full:
    'This class filled up while your payment was being processed. Your card was authorized but never charged, and the authorization has been released. You have not been charged anything.',
  cancelled: 'This booking was cancelled.',
}

export default async function BookingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  let booking: Booking
  let trialClasses: TrialClassSummary[]
  try {
    const loaded = await withTransaction(async (client) => ({
      booking: await getBooking(client, id),
      trialClasses: await listTrialClasses(client),
    }))
    booking = loaded.booking
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
          <dt className="inline font-semibold">Class: </dt>
          <dd className="inline">{trialClass?.title ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Status: </dt>
          <dd className="inline font-mono">{booking.status}</dd>
        </div>
      </dl>
      <p className="border bg-gray-50 p-3">{STATUS_COPY[booking.status]}</p>

      {booking.status === 'pending_payment' ? (
        <PayButtons bookingId={booking.id} />
      ) : null}

      <Link className="underline" href="/">
        Back to classes
      </Link>
    </main>
  )
}
