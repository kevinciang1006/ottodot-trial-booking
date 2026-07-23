'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { isRecord } from '@/lib/booking/errors'

export function PayButtons({ bookingId }: { bookingId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function pay(cardToken: string) {
    setBusy(true)
    const response = await fetch(`/api/bookings/${bookingId}/pay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // A stable key per booking, so double-clicking cannot double-charge.
        'Idempotency-Key': `ui-${bookingId}`,
      },
      body: JSON.stringify({ cardToken }),
    })
    const payload: unknown = await response.json()
    setBusy(false)

    if (isRecord(payload) && typeof payload.message === 'string') {
      setMessage(payload.message)
    } else if (
      isRecord(payload) &&
      isRecord(payload.error) &&
      typeof payload.error.message === 'string'
    ) {
      setMessage(payload.error.message)
    } else {
      setMessage('Something went wrong.')
    }
    router.refresh()
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <button
          type="button"
          className="border px-3 py-1 disabled:opacity-40"
          disabled={busy}
          onClick={() => void pay('pm_ok')}
        >
          Pay (success)
        </button>
        <button
          type="button"
          className="border px-3 py-1 disabled:opacity-40"
          disabled={busy}
          onClick={() => void pay('pm_fail')}
        >
          Pay (declined card)
        </button>
      </div>
      {message ? <p className="border bg-gray-50 p-3 text-sm">{message}</p> : null}
    </div>
  )
}
