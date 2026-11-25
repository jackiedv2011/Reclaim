import { useState, type FormEvent } from 'react'
import { CardElement, useElements, useStripe } from '@stripe/react-stripe-js'
import type { StripeCardElementOptions } from '@stripe/stripe-js'
import { Lock, ShieldCheck } from 'lucide-react'
import { call } from '@/lib/auth/apiAuthService'

type Answer = { status?: string; clientSecret?: string; subscriptionId?: string; message?: string } | null

async function post(path: string, json: unknown): Promise<{ ok: true; body: NonNullable<Answer> } | { ok: false; message: string }> {
  try {
    const { status, body } = await call<Answer>(path, { method: 'POST', json })
    if (status === 200 && body) return { ok: true, body }
    return { ok: false, message: body?.message ?? 'Something went wrong with billing. Your card may not have changed; try again in a minute.' }
  } catch {
    return { ok: false, message: 'Couldn’t reach Reclaim. Check your connection and try again.' }
  }
}

/**
 * Replaces the card a subscription charges. If the last bill failed, the
 * server tries it again with the new card, and the bank may ask for 3-D Secure
 * first. Must be rendered inside Stripe's <Elements>.
 */
export function UpdateCardForm({ email, name, options, onDone }: { email: string; name: string; options: StripeCardElementOptions; onDone: () => void | Promise<void> }) {
  const stripe = useStripe()
  const elements = useElements()
  const [complete, setComplete] = useState(false)
  const [cardError, setCardError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(): Promise<string | null> {
    const card = elements?.getElement(CardElement)
    if (!stripe || !card) return 'The card form hasn’t loaded yet. Try again in a moment.'
    const made = await stripe.createPaymentMethod({ type: 'card', card, billing_details: { name: name.trim() || undefined, email } })
    if (made.error) return made.error.message ?? 'That card could not be verified. Check the details and try again.'
    const saved = await post('/api/billing/card', { paymentMethodId: made.paymentMethod.id })
    if (!saved.ok) return saved.message
    if (saved.body.status !== 'requires_action' || !saved.body.clientSecret) return null
    const challenge = await stripe.confirmCardPayment(saved.body.clientSecret)
    if (challenge.error) return `${challenge.error.message ?? 'Your bank didn’t approve the payment.'} The overdue payment is still open.`
    const confirmed = await post('/api/billing/card/confirm', { subscriptionId: saved.body.subscriptionId })
    return confirmed.ok ? null : confirmed.message
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!complete) {
      setCardError((prev) => prev ?? 'Enter your card details.')
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      const problem = await save()
      if (problem) setFormError(problem)
      else await onDone()
    } catch {
      setFormError('Couldn’t reach our payment provider. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="wk-checkout-form" onSubmit={submit} noValidate>
      <div className="wk-field">
        <label htmlFor="uc-card">New card</label>
        <div id="uc-card" className="wk-input wk-checkout-card" data-invalid={Boolean(cardError) || undefined}>
          <CardElement
            options={options}
            onChange={(e) => {
              setComplete(e.complete)
              setCardError(e.error?.message ?? null)
            }}
          />
        </div>
        {cardError ? <span className="wk-field-error" role="alert">{cardError}</span> : null}
      </div>
      {formError ? (
        <div className="wk-alert" role="alert">
          <p>{formError}</p>
        </div>
      ) : null}
      <button type="submit" className="wk-btn wk-checkout-pay" data-variant="primary" disabled={busy || !stripe}>
        <Lock aria-hidden="true" />
        {busy ? 'Saving card…' : 'Save card'}
      </button>
      <p className="wk-checkout-secure">
        <ShieldCheck aria-hidden="true" />
        If a payment is overdue, it is charged to this card now. Otherwise nothing is charged until your next bill. Reclaim never sees or stores your card number.
      </p>
    </form>
  )
}
