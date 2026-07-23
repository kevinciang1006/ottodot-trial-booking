export type BookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'payment_failed'
  | 'cancelled_class_full'
  | 'cancelled'

export type PaymentOutcome = 'authorized' | 'captured' | 'failed' | 'voided'

export interface Booking {
  id: string
  trialClassId: string
  studentId: string
  status: BookingStatus
  createdAt: string
  updatedAt: string
}

export interface TrialClassSummary {
  id: string
  title: string
  subject: string
  startsAt: string
  capacity: number
  priceCents: number
  confirmedCount: number
  seatsRemaining: number
}

export interface RosterEntry {
  bookingId: string
  studentId: string
  studentName: string
  gradeLevel: number
  confirmedAt: string
}

export interface PayResult {
  booking: Booking
  /** Null when the booking reached a terminal state with no recorded attempt. */
  outcome: PaymentOutcome | null
  charged: boolean
  message: string
}

export interface StudentSummary {
  id: string
  fullName: string
  gradeLevel: number
}

export interface ParentWithStudents {
  id: string
  fullName: string
  email: string
  students: StudentSummary[]
}
