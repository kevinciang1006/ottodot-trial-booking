import { withTransaction } from '@/lib/db'
import { getRoster, listTrialClasses } from '@/lib/booking/service'
import type { RosterEntry, TrialClassSummary } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const classesWithRosters = await withTransaction(async (client) => {
    const trialClasses = await listTrialClasses(client)
    // Sequential, never Promise.all: these queries share ONE pooled connection,
    // and a single pg connection runs one query at a time. Firing them
    // concurrently overlaps queries on that connection (the pg "client is
    // already executing a query" deprecation, removed in pg@9). An admin page
    // renders a handful of classes, so serial reads cost nothing.
    const rows: { trialClass: TrialClassSummary; roster: RosterEntry[] }[] = []
    for (const trialClass of trialClasses) {
      rows.push({ trialClass, roster: await getRoster(client, trialClass.id) })
    }
    return rows
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
