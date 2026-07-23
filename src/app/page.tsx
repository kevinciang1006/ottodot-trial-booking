import { BookingForm } from '@/app/_components/booking-form'
import { withTransaction } from '@/lib/db'
import { listParentsWithStudents, listTrialClasses } from '@/lib/booking/service'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const { parents, trialClasses } = await withTransaction(async (client) => ({
    parents: await listParentsWithStudents(client),
    trialClasses: await listTrialClasses(client),
  }))

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Book a trial class</h1>
      <BookingForm parents={parents} trialClasses={trialClasses} />
    </main>
  )
}
