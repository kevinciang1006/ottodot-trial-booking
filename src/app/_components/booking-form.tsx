'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { isRecord } from '@/lib/booking/errors'
import type { ParentWithStudents, TrialClassSummary } from '@/lib/types'

export function BookingForm({
  parents,
  trialClasses,
}: {
  parents: ParentWithStudents[]
  trialClasses: TrialClassSummary[]
}) {
  const router = useRouter()
  const [parentId, setParentId] = useState(parents[0]?.id ?? '')
  const [studentId, setStudentId] = useState(parents[0]?.students[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const students = parents.find((p) => p.id === parentId)?.students ?? []

  async function book(trialClassId: string) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ studentId, trialClassId }),
    })
    const payload: unknown = await response.json()
    setBusy(false)

    if (!response.ok) {
      // A duplicate isn't a dead-end: the child already has a live booking for
      // this class, so send the user to it (Pay buttons if pending, status if
      // confirmed) rather than showing an error with no way forward.
      if (
        isRecord(payload) &&
        isRecord(payload.error) &&
        payload.error.code === 'duplicate_booking' &&
        typeof payload.error.existingBookingId === 'string'
      ) {
        router.push(`/bookings/${payload.error.existingBookingId}`)
        return
      }
      const message =
        isRecord(payload) &&
        isRecord(payload.error) &&
        typeof payload.error.message === 'string'
          ? payload.error.message
          : 'Booking failed.'
      setError(message)
      return
    }

    if (
      isRecord(payload) &&
      isRecord(payload.booking) &&
      typeof payload.booking.id === 'string'
    ) {
      router.push(`/bookings/${payload.booking.id}`)
      return
    }
    setError('Booking succeeded but the response was malformed.')
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col text-sm">
          Parent
          <select
            className="mt-1 border p-2"
            value={parentId}
            onChange={(e) => {
              const next = e.target.value
              setParentId(next)
              setStudentId(
                parents.find((p) => p.id === next)?.students[0]?.id ?? '',
              )
            }}
          >
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col text-sm">
          Child
          <select
            className="mt-1 border p-2"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
          >
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName} (grade {s.gradeLevel})
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <p className="border border-red-500 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <ul className="space-y-2">
        {trialClasses.map((c) => (
          <li key={c.id} className="flex items-center justify-between border p-3">
            <span>
              <strong>{c.title}</strong> — {c.subject} · $
              {(c.priceCents / 100).toFixed(2)}
              <br />
              <span className="text-sm text-gray-600">
                {c.seatsRemaining} of {c.capacity} seats remaining
              </span>
            </span>
            <button
              type="button"
              className="border px-3 py-1 disabled:opacity-40"
              disabled={busy || studentId === '' || c.seatsRemaining === 0}
              onClick={() => void book(c.id)}
            >
              Book trial
            </button>
          </li>
        ))}
      </ul>

      {/* The disabled state above only avoids an obviously wasted click. It is
          NOT what prevents overbooking — the database is. A class can fill
          between this page rendering and the button being pressed. */}
    </div>
  )
}
