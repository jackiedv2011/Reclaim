import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AuthProvider } from '@/lib/auth/AuthContext'
import { setFetch } from '@/lib/auth/apiAuthService'
import { CheckoutPage } from '@/pages/CheckoutPage'

/** Stripe.js itself is never loaded: the card field is a button that reports a complete card. */
const stripe = { createPaymentMethod: vi.fn(), confirmCardPayment: vi.fn() }
vi.mock('@/billing/stripe', () => ({ getStripe: () => Promise.resolve(stripe), STRIPE_IS_TEST_MODE: true }))
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => children,
  CardElement: ({ onChange }: { onChange: (e: { complete: boolean }) => void }) => (
    <button type="button" onClick={() => onChange({ complete: true })}>
      fill card
    </button>
  ),
  useStripe: () => stripe,
  useElements: () => ({ getElement: () => ({}) }),
}))

const user = { id: 'u1', firstName: 'Pat', lastName: 'Lee', name: 'Pat Lee', email: 'pat@example.com', company: 'Lee Co', createdAt: 1, emailVerified: true, termsAcceptedAt: 1, termsVersion: 't', methods: ['password'], plan: 'growth', onboardingSeenAt: 1, onboardingProfile: null }
let answers: Record<string, { status: number; body: unknown } | 'offline'>
let sent: Array<{ path: string; json: unknown }>

beforeEach(() => {
  sent = []
  answers = { '/api/auth/me': { status: 200, body: { user } }, '/api/projects': { status: 200, body: { projects: [] } } }
  stripe.createPaymentMethod.mockReset().mockResolvedValue({ paymentMethod: { id: 'pm_new', card: { brand: 'visa', last4: '4242' } } })
  stripe.confirmCardPayment.mockReset().mockResolvedValue({})
  setFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (init?.body) sent.push({ path, json: JSON.parse(String(init.body)) })
    const answer = answers[path] ?? { status: 404, body: { message: 'Not found.' } }
    if (answer === 'offline') throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  }) as typeof fetch)
  window.history.pushState({}, '', '/checkout?card=update')
})
afterEach(() => {
  cleanup()
  setFetch((...args) => fetch(...args))
  window.localStorage.clear()
})

async function save() {
  render(
    <AuthProvider>
      <CheckoutPage />
    </AuthProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: 'fill card' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save card' }))
}

describe('updating the card on file', () => {
  it('sends only Stripe’s card id and confirms', async () => {
    answers['/api/billing/card'] = { status: 200, body: { status: 'active' } }
    await save()
    expect(await screen.findByTestId('card-updated')).toBeInTheDocument()
    expect(sent.filter((s) => s.path.startsWith('/api/billing'))).toEqual([{ path: '/api/billing/card', json: { paymentMethodId: 'pm_new' } }])
  })

  it('finishes 3-D Secure in the browser, then asks the server to check', async () => {
    answers['/api/billing/card'] = { status: 200, body: { status: 'requires_action', clientSecret: 'secret_1', subscriptionId: 'sub_1' } }
    answers['/api/billing/card/confirm'] = { status: 200, body: { status: 'active' } }
    await save()
    expect(await screen.findByTestId('card-updated')).toBeInTheDocument()
    expect(stripe.confirmCardPayment).toHaveBeenCalledWith('secret_1')
    expect(sent.at(-1)).toEqual({ path: '/api/billing/card/confirm', json: { subscriptionId: 'sub_1' } })
  })

  it.each([
    ['a decline', { status: 402, body: { message: 'The new card is saved, but the overdue payment was declined.' } }, /declined/],
    ['being offline', 'offline' as const, /Couldn’t reach Reclaim/],
  ])('%s is shown, and the form can be used again', async (_name, answer, text) => {
    answers['/api/billing/card'] = answer
    await save()
    expect(await screen.findByText(text)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save card' })).toBeEnabled())
  })

  it('Stripe itself being unreachable does not leave the button stuck', async () => {
    stripe.createPaymentMethod.mockRejectedValue(new Error('network'))
    await save()
    expect(await screen.findByText(/Couldn’t reach our payment provider/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save card' })).toBeEnabled())
  })
})
