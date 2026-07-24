import { randomUUID } from 'node:crypto'

/**
 * Mock payment gateway.
 *
 * THIS MODULE IS THE SEAM where a real provider and its webhooks would attach.
 * With Stripe, `authorize` becomes a PaymentIntent created with
 * `capture_method: 'manual'`, `capture` becomes `paymentIntents.capture`, and
 * `voidAuthorization` becomes `paymentIntents.cancel`. A webhook handler would
 * reconcile out-of-band state changes against the `payment_attempts` table.
 *
 * Behaviour is deterministic, never random: `pm_fail` always declines and every
 * other token always authorizes. A gateway that fails randomly cannot be
 * reviewed and cannot be tested.
 *
 * The functions are async because a real provider is a network call. That is
 * also precisely why authorize is split from capture: an external call cannot
 * participate in a database transaction, so the money decision has to happen
 * after the seat decision.
 */

export const SUCCESS_CARD_TOKEN = 'pm_ok'
export const DECLINE_CARD_TOKEN = 'pm_fail'

export type AuthorizeResult =
  | { ok: true; providerRef: string }
  | { ok: false; declineReason: string }

export async function authorize(
  amountCents: number,
  cardToken: string,
): Promise<AuthorizeResult> {
  if (amountCents < 0) {
    throw new Error('authorize: amountCents must be non-negative')
  }
  if (cardToken === DECLINE_CARD_TOKEN) {
    return { ok: false, declineReason: 'card_declined' }
  }
  return { ok: true, providerRef: `auth_${randomUUID()}` }
}

export async function capture(providerRef: string): Promise<void> {
  if (!providerRef) throw new Error('capture: providerRef is required')
}

export async function voidAuthorization(providerRef: string): Promise<void> {
  if (!providerRef) throw new Error('voidAuthorization: providerRef is required')
}
