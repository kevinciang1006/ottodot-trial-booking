import { withTransaction } from '@/lib/db'
import { getRoster, listTrialClasses } from '@/lib/booking/service'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const classesWithRosters = await withTransaction(async (client) => {
    const trialClasses = await listTrialClasses(client)
    return Promise.all(
      trialClasses.map(async (trialClass) => ({
        trialClass,
        roster: await getRoster(client, trialClass.id),
      })),
    )
  })

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Rosters</h1>
      {classesWithRosters.map(({ trialClass, roster }) => (
        <section key={trialClass.id} className="border p-4">
          <h2 className="font-semibold">{trialClass.title}</h2>
          <p className="text-sm text-gray-600">
            {trialClass.confirmedCount} of {trialClass.capacity} confirmed ·{' '}
            {trialClass.seatsRemaining} remaining
          </p>
          {roster.length === 0 ? (
            <p className="mt-2 text-sm italic">No confirmed students yet.</p>
          ) : (
            <ol className="mt-2 list-decimal pl-6 text-sm">
              {roster.map((entry) => (
                <li key={entry.bookingId}>
                  {entry.studentName} (grade {entry.gradeLevel})
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
    </main>
  )
}
