// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from './app.ts'
import { loadConfig } from './config.ts'
import { FakeStripe } from './fakeStripe.ts'
import { createStripeClient, formEncode, normalizeSubscription, signatureHeader, StripeError, verifyWebhook } from './stripe.ts'
import { authorizedProject } from './testProject.ts'
import { ProjectStore } from './projectStore.ts'
import { randomUUID } from 'node:crypto'

const WHSEC = 'whsec_test_secret'
const env = { NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: 'http://localhost:0', REQUIRE_EMAIL_VERIFICATION: 'false', STRIPE_SECRET_KEY: 'sk_test_unused', STRIPE_WEBHOOK_SECRET: WHSEC }

let app: App
let base: string
let stripe: FakeStripe

class Client {
  cookie = ''
  async call(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers)
    if (init.json !== undefined) headers.set('Content-Type', 'application/json')
    if (this.cookie) headers.set('Cookie', this.cookie)
    const res = await fetch(base + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body })
    const set = res.headers.getSetCookie().find((c) => c.startsWith('reclaim_session='))
    if (set) this.cookie = set.split(';')[0]
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  get = (p: string) => this.call(p)
  post = (p: string, json: unknown = {}) => this.call(p, { method: 'POST', json })
  put = (p: string, json: unknown) => this.call(p, { method: 'PUT', json })
}

async function signedIn(email = 'pilot@example.com') {
  const client = new Client()
  const res = await client.post('/api/auth/signup', { firstName: 'Pat', lastName: 'Lee', email, company: 'Lee Co', password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery', acceptedTerms: true, termsVersion: 't' })
  expect(res.status).toBe(201)
  return client
}

/** Delivers every queued Stripe event to the webhook, signed for this endpoint. */
async function deliver() {
  for (const { body, signature } of stripe.drainSigned(WHSEC)) {
    const res = await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body })
    expect(res.status).toBe(200)
  }
  await app.billingIdle()
}

const plan = async (client: Client) => (await client.get('/api/auth/me')).body.user.plan
const limits = async (client: Client) => (await client.get('/api/account/entitlements')).body.limits

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  stripe = new FakeStripe()
  app = createApp({ config: loadConfig(env), stripe, google: null, drafts: null, quickbooks: null })
  base = `http://127.0.0.1:${await app.listen(0)}`
})

afterEach(async () => {
  await app.close()
  vi.restoreAllMocks()
})

describe('webhook signature', () => {
  const event = JSON.stringify({ id: 'evt_1', type: 'customer.updated', data: { object: { object: 'customer', id: 'cus_x' } } })
  const post = (body: string, signature?: string) => fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: signature ? { 'Stripe-Signature': signature } : {}, body })

  it('refuses unsigned, wrongly signed, altered and stale events', async () => {
    expect((await post(event)).status).toBe(400)
    expect((await post(event, signatureHeader(event, 'whsec_other'))).status).toBe(400)
    expect((await post(event.replace('cus_x', 'cus_y'), signatureHeader(event, WHSEC))).status).toBe(400)
    expect((await post(event, signatureHeader(event, WHSEC, Math.floor(Date.now() / 1000) - 3600))).status).toBe(400)
  })

  it('accepts a correctly signed event once and ignores redelivery', async () => {
    const first = await post(event, signatureHeader(event, WHSEC))
    expect(first.status).toBe(200)
    const again = (await (await post(event, signatureHeader(event, WHSEC))).json()) as { duplicate?: boolean }
    expect(again.duplicate).toBe(true)
  })

  it('verifyWebhook accepts any one of several v1 signatures (secret rotation)', () => {
    const t = Math.floor(Date.now() / 1000)
    const header = `${signatureHeader(event, 'whsec_old', t)},${signatureHeader(event, WHSEC, t).split(',')[1]}`
    expect(verifyWebhook(event, header, WHSEC).id).toBe('evt_1')
  })

  it('does not trust the payload: a forged "active" subscription body is re-read from Stripe', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    await deliver()
    const sub = [...stripe.subscriptions.values()][0]
    await client.post('/api/billing/cancel')
    stripe.endPeriod()
    await deliver()
    expect(await plan(client)).toBe('free')
    // A replayed-looking event claiming the subscription is active, signed correctly, changes nothing: Stripe says canceled.
    const forged = JSON.stringify({ id: 'evt_forged', type: 'customer.subscription.updated', data: { object: { object: 'subscription', id: sub.id, customer: sub.customer, status: 'active' } } })
    expect((await post(forged, signatureHeader(forged, WHSEC))).status).toBe(200)
    expect(await plan(client)).toBe('free')
  })
})

describe('plan transitions', () => {
  it('Free → Growth unlocks every paid feature at once and stores only Stripe ids', async () => {
    const client = await signedIn()
    expect((await limits(client)).findingsVisible).toBe(3)
    const res = await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    expect(res.status).toBe(200)
    expect(res.body.user.plan).toBe('growth')
    expect(res.body.billing).toMatchObject({ plan: 'growth', status: 'active', cancelAtPeriodEnd: false })
    expect(res.body.billing.currentPeriodEnd).toBeGreaterThan(Date.now())
    expect(await plan(client)).toBe('growth')
    expect(await limits(client)).toMatchObject({ findingsVisible: null, aiDrafts: true, fullLetters: true, fullRecoveryWorkflow: true, advancedReports: true })
    const row = app.db.prepare('SELECT * FROM billing_accounts').get() as Record<string, unknown>
    expect(row.stripe_customer_id).toMatch(/^cus_/)
    expect(row.stripe_subscription_id).toMatch(/^sub_/)
    expect(Object.keys(row).some((k) => /card|pan|cvc|last4/i.test(k))).toBe(false)
    // The webhook that follows agrees and changes nothing.
    await deliver()
    expect(await plan(client)).toBe('growth')
  })

  it('Free → Flat through 3-D Secure switches only once the payment is confirmed', async () => {
    const client = await signedIn()
    const res = await client.post('/api/billing/subscribe', { plan: 'flat', paymentMethodId: 'pm_card_authenticationRequired' })
    expect(res.body).toMatchObject({ status: 'requires_action', clientSecret: expect.any(String) })
    await deliver()
    expect(await plan(client)).toBe('free')
    stripe.completeAuthentication(res.body.subscriptionId)
    const confirmed = await client.post('/api/billing/confirm', { subscriptionId: res.body.subscriptionId })
    expect(confirmed.status).toBe(200)
    expect(confirmed.body.user.plan).toBe('flat')
    await deliver()
    expect(await plan(client)).toBe('flat')
  })

  it('a declined card shows a plain message, charges nothing and keeps Free', async () => {
    const client = await signedIn()
    const res = await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_chargeDeclined' })
    expect(res.status).toBe(402)
    expect(res.body.message).toMatch(/declined.*still on Free/)
    await deliver()
    expect(await plan(client)).toBe('free')
    expect([...stripe.subscriptions.values()].every((s) => s.status === 'incomplete_expired')).toBe(true)
    const attach = await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_attachDeclined' })
    expect(attach.status).toBe(402)
    expect(attach.body.message).toBe('Your card was declined. You’re still on Free.')
    // After fixing the card the same account subscribes normally.
    expect((await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })).body.user.plan).toBe('growth')
  })

  it('Stripe being unreachable keeps the current plan', async () => {
    const client = await signedIn()
    stripe.failNext = new StripeError(500, 'api_error', null, 'boom')
    const res = await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    expect(res.status).toBe(502)
    expect(res.body.message).toMatch(/Nothing changed/)
    expect(res.body.message).not.toMatch(/boom/)
    expect(await plan(client)).toBe('free')
  })

  it('Growth ↔ Flat switches with proration, and a failed switch payment keeps the old plan', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    const toFlat = await client.post('/api/billing/change', { plan: 'flat' })
    expect(toFlat.status).toBe(200)
    expect(toFlat.body.user.plan).toBe('flat')
    expect(stripe.calls).toContain('changeSubscriptionPrice')
    expect((await client.post('/api/billing/change', { plan: 'growth' })).body.user.plan).toBe('growth')
    await deliver()
    expect(await plan(client)).toBe('growth')

    // The card on file now declines: the upgrade to Flat waits on payment and the plan does not move.
    const customer = [...stripe.customers.values()][0]
    customer.defaultPaymentMethod = 'pm_card_chargeDeclined'
    const failed = await client.post('/api/billing/change', { plan: 'flat' })
    expect(failed.status).toBe(402)
    expect(failed.body.message).toMatch(/still on Growth/)
    expect(await plan(client)).toBe('growth')
  })

  it('cancel keeps paid access until the period ends, then returns to Free; resume undoes it', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'flat', paymentMethodId: 'pm_card_visa' })
    const cancelled = await client.post('/api/billing/cancel')
    expect(cancelled.body.billing).toMatchObject({ plan: 'flat', cancelAtPeriodEnd: true })
    await deliver()
    expect(await plan(client)).toBe('flat')
    expect((await limits(client)).aiDrafts).toBe(true)

    const resumed = await client.post('/api/billing/resume')
    expect(resumed.body.billing.cancelAtPeriodEnd).toBe(false)
    await client.post('/api/billing/cancel')
    stripe.endPeriod()
    await deliver()
    expect(await plan(client)).toBe('free')
    expect(await limits(client)).toMatchObject({ findingsVisible: 3, aiDrafts: false })
    expect((await client.get('/api/billing')).body).toMatchObject({ plan: 'free', status: 'canceled', currentPeriodEnd: null })
    // And Free can subscribe again.
    expect((await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })).body.user.plan).toBe('growth')
  })

  it('choosing a plan again while a cancel is scheduled resumes it instead of double-charging', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    await client.post('/api/billing/cancel')
    const res = await client.post('/api/billing/change', { plan: 'growth' })
    expect(res.body.billing.cancelAtPeriodEnd).toBe(false)
    expect(stripe.calls).not.toContain('changeSubscriptionPrice')
    expect((await client.post('/api/billing/subscribe', { plan: 'flat', paymentMethodId: 'pm_card_visa' })).status).toBe(409)
  })

  it('past_due keeps access during retries; exhausted retries return the account to Free', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    const sub = [...stripe.subscriptions.values()][0]
    stripe.failRenewal(sub.id)
    await deliver()
    expect(await plan(client)).toBe('growth')
    expect((await client.get('/api/billing')).body.status).toBe('past_due')
    stripe.exhaustRetries(sub.id)
    await deliver()
    expect(await plan(client)).toBe('free')
  })

  it('the webhook is the source of truth for changes made outside the app', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    const sub = [...stripe.subscriptions.values()][0]
    // Switched to Flat from the Stripe dashboard.
    await stripe.changeSubscriptionPrice(sub.id, sub.itemId, [...stripe.prices.values()].find((p) => p.lookupKey === 'reclaim_flat_monthly')!.id)
    expect(await plan(client)).toBe('growth')
    await deliver()
    expect(await plan(client)).toBe('flat')
  })

  it('an old abandoned attempt expiring never downgrades a newer paid subscription', async () => {
    const client = await signedIn()
    const first = await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_authenticationRequired' })
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    await deliver()
    await stripe.cancelSubscriptionNow(first.body.subscriptionId)
    await deliver()
    expect(await plan(client)).toBe('growth')
  })

  it('refuses bad input and needs a session', async () => {
    const client = await signedIn()
    expect((await client.post('/api/billing/subscribe', { plan: 'free', paymentMethodId: 'pm_card_visa' })).status).toBe(400)
    expect((await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: '4242424242424242' })).status).toBe(400)
    expect((await client.post('/api/billing/cancel')).status).toBe(409)
    expect((await new Client().post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })).status).toBe(401)
  })

  it('refuses to sell a plan whose Stripe price does not match the site', async () => {
    stripe.prices.clear()
    stripe.addPrice('reclaim_growth_monthly', 1999)
    const client = await signedIn()
    const res = await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    expect(res.status).toBe(503)
    expect(stripe.calls).not.toContain('createSubscription')
  })
})

describe('without Stripe keys', () => {
  it('answers plainly and changes nothing', async () => {
    await app.close()
    app = createApp({ config: loadConfig({ ...env, STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' }), google: null, drafts: null, quickbooks: null })
    base = `http://127.0.0.1:${await app.listen(0)}`
    const client = await signedIn()
    const res = await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    expect(res.status).toBe(503)
    expect(res.body.message).toMatch(/Nothing was charged/)
    expect((await client.get('/api/billing')).body).toMatchObject({ configured: false, plan: 'free' })
    expect(await plan(client)).toBe('free')
  })
})

describe('customer-entered returns and proposed success fee', () => {
  const refund = (amount: number, reference: string) => ({ amount, method: 'refund', source: 'bank', reference, settledAt: Date.UTC(2026, 9, 1) })
  function project(id: string, state: Record<string, unknown>) {
    const { project, findingId } = authorizedProject(id, { vendor: 'Acme Supply', invoice: 'INV-1', amount: 1234.5, requested: 1234.5 })
    const caseState = project.environment.caseStates[findingId]
    const caseStates: Record<string, unknown> = project.environment.caseStates
    caseStates[findingId] = { ...caseState, recoveryStage: 'recovered', ...state }
    return project
  }
  const items = () => [...stripe.invoiceItems.values()]
  async function requestedCase(client: Client, id: string) {
    const saved = authorizedProject(id, { vendor: 'Acme Supply', invoice: 'INV-1', amount: 1234.5, requested: 1234.5 })
    const user = app.auth.findUserByEmail('pilot@example.com')!
    let revision = new ProjectStore(app.db, null).upsert(user.id, saved.project)
    const command = async (type: string, input: unknown) => {
      const response = await client.post(`/api/projects/${id}/case-commands`, { commandId: randomUUID(), expectedRevision: revision, findingId: saved.findingId, type, input })
      expect(response.status).toBe(200)
      revision = response.body.revision
    }
    const request = { subject: 'Duplicate payment INV-1', body: 'Please return the extra payment.', recipientEmail: 'billing@acme.test', recipientConfirmed: true, method: 'refund', requestedAmount: 1234.5 }
    await command('approve', { package: request, knownBeforeReclaim: false, knownBeforeNote: null })
    await command('request', request)
    return command
  }

  async function onGrowth() {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    await deliver()
    return client
  }

  it('records customer-entered refunds once without creating a success-fee invoice', async () => {
    const client = await onGrowth()
    const command = await requestedCase(client, 'p1')
    await command('settlement', refund(1000, 'BANK-1'))
    await command('settlement', refund(234.5, 'BANK-2'))
    await app.billingIdle()
    expect(items()).toHaveLength(0)
    // Reading billing again never turns the assertion into a fee.
    await client.get('/api/billing')
    await app.billingIdle()
    expect(items()).toHaveLength(0)
    const status = (await client.get('/api/billing')).body.successFees
    expect(status).toMatchObject({ monthCents: 0, unbilledCents: 0 })
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM recovery_fees WHERE billable = 0').get()).toEqual({ n: 2 })
    stripe.endPeriod()
    expect(stripe.invoices.at(-1)).toMatchObject({ amountCents: 1500 })
  })

  it('never charges on findings, vendor promises or credits not applied to a bill', async () => {
    const client = await onGrowth()
    const saved = project('p2', {
      recoveryStage: 'requested',
      vendorUpdates: [{ status: 'promised', at: 1, amount: 1234.5, note: 'Will refund next week' }, { status: 'credit_issued', at: 2, amount: 500, note: 'Credit memo CM-9' }],
      recoverySettlements: [{ amount: 500, method: 'credit', source: 'document', reference: 'CM-9', settledAt: 3 }],
    })
    await client.put('/api/projects/p2', saved)
    await app.billingIdle()
    expect(items()).toHaveLength(0)
    // A typed bill reference remains a customer assertion until matched.
    const states: Record<string, unknown> = saved.environment.caseStates
    states['exact_duplicate-p2'] = { ...(states['exact_duplicate-p2'] as object), recoverySettlements: [{ amount: 500, method: 'credit', source: 'document', reference: 'CM-9', settledAt: 3, appliedToBill: 'BILL-2207' }] }
    await client.put('/api/projects/p2', saved)
    await app.billingIdle()
    expect(items()).toHaveLength(0)
  })

  it('money recorded on Free or Flat is never billed, even after moving to Growth', async () => {
    const client = await signedIn()
    const command = await requestedCase(client, 'p3')
    await command('settlement', refund(800, 'BANK-FREE'))
    await client.post('/api/billing/subscribe', { plan: 'flat', paymentMethodId: 'pm_card_visa' })
    await command('settlement', refund(100, 'BANK-FLAT'))
    await client.post('/api/billing/change', { plan: 'growth' })
    await command('settlement', refund(50, 'BANK-GROWTH'))
    await app.billingIdle()
    expect(items()).toHaveLength(0)
    const rows = app.db.prepare('SELECT reference, billable, reason FROM recovery_fees ORDER BY recorded_at, reference').all()
    expect(rows).toEqual([
      { reference: 'BANK-FREE', billable: 0, reason: 'customer_assertion_unmatched' },
      { reference: 'BANK-FLAT', billable: 0, reason: 'customer_assertion_unmatched' },
      { reference: 'BANK-GROWTH', billable: 0, reason: 'customer_assertion_unmatched' },
    ])
  })

  it('a removed customer assertion is voided without a Stripe invoice item', async () => {
    const client = await onGrowth()
    const command = await requestedCase(client, 'p4')
    await command('settlement', refund(300, 'BANK-A'))
    await command('settlement', refund(934.5, 'BANK-B'))
    await app.billingIdle()
    expect(items()).toHaveLength(0)
    stripe.endPeriod()
    await deliver()
    await command('reopen', {})
    await app.billingIdle()
    expect(items()).toHaveLength(0)
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM recovery_fees WHERE voided_at IS NOT NULL').get()).toEqual({ n: 2 })
  })

  it('a cancelled plan does not invoice customer-entered returns from the last period', async () => {
    const client = await onGrowth()
    await client.post('/api/billing/cancel')
    await client.put('/api/projects/p5', project('p5', { recoverySettlements: [refund(1000, 'BANK-LAST')] }))
    await app.billingIdle()
    stripe.endPeriod()
    await deliver()
    expect(await plan(client)).toBe('free')
    expect(stripe.invoices).toHaveLength(0)
    // Recorded after the plan ended: not billable.
    await client.put('/api/projects/p5', project('p5', { recoverySettlements: [refund(1000, 'BANK-LAST'), refund(400, 'BANK-AFTER')] }))
    await app.billingIdle()
    expect(items()).toHaveLength(0)
  })

  it('imported audits are snapshotted, not billed', async () => {
    const client = await onGrowth()
    const res = await client.post('/api/projects/import', { projects: [project('p6', { recoverySettlements: [refund(900, 'GUEST-1')] })] })
    expect(res.body.imported).toEqual(['p6'])
    await client.put('/api/projects/p6', project('p6', { recoverySettlements: [refund(900, 'GUEST-1')] }))
    await app.billingIdle()
    expect(items()).toHaveLength(0)
  })
})

describe('deleting an account', () => {
  it('ends the subscription without billing asserted returns, then deletes; a Stripe outage stops deletion', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    const { project, findingId } = authorizedProject('d1', { vendor: 'Acme Supply', invoice: 'INV-9', amount: 500, requested: 500 })
    const states: Record<string, unknown> = project.environment.caseStates
    states[findingId] = { ...(states[findingId] as object), recoveryStage: 'recovered', recoverySettlements: [{ amount: 500, method: 'refund', source: 'bank', reference: 'BANK-DEL', settledAt: 5 }] }
    await client.put('/api/projects/d1', project)
    await app.billingIdle()
    stripe.failNext = new StripeError(500, 'api_error', null, 'down')
    const refused = await client.post('/api/account/delete', { confirmEmail: 'pilot@example.com' })
    expect(refused.status).toBe(502)
    expect(refused.body.message).toMatch(/account wasn’t deleted/)
    expect(await plan(client)).toBe('growth')

    const deleted = await client.post('/api/account/delete', { confirmEmail: 'pilot@example.com' })
    expect(deleted.status).toBe(200)
    expect([...stripe.subscriptions.values()][0].status).toBe('canceled')
    expect(stripe.invoices).toHaveLength(0)
    expect(app.db.prepare('SELECT COUNT(*) AS n FROM billing_accounts').get()).toEqual({ n: 0 })
  })
})

describe('a price that cannot be identified', () => {
  const tracked = () => [...stripe.subscriptions.values()][0]
  /** A restarted server on the same database: nothing cached in memory. */
  async function restart() {
    const db = app.db
    await app.close()
    app = createApp({ config: loadConfig(env), db, stripe, google: null, drafts: null, quickbooks: null })
    base = `http://127.0.0.1:${await app.listen(0)}`
  }
  const send = async () => {
    const statuses: number[] = []
    const queued = stripe.drainSigned(WHSEC)
    for (const { body, signature } of queued) statuses.push((await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body })).status)
    return { statuses, queued }
  }

  it('a renewal survives a price-lookup outage: the stored price says which plan it is', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    await deliver()
    await restart()
    stripe.hideLookupKeys = true
    stripe.failOn.set('findPrice', new StripeError(500, 'api_error', null, 'down'))
    stripe.endPeriod()
    expect((await send()).statuses.every((s) => s === 200)).toBe(true)
    expect(await plan(client)).toBe('growth')
  })

  it('without a stored price, a failed lookup answers 500, changes nothing, and Stripe’s retry is handled', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'flat', paymentMethodId: 'pm_card_visa' })
    await deliver()
    app.db.exec('DELETE FROM billing_prices')
    tracked().metadata = {}
    await restart()
    stripe.hideLookupKeys = true
    stripe.failOn.set('findPrice', new StripeError(500, 'api_error', null, 'down'))
    stripe.endPeriod()
    const { statuses, queued } = await send()
    expect(statuses.every((s) => s === 500)).toBe(true)
    expect(await plan(client)).toBe('flat')
    stripe.failOn.clear()
    for (const { body, signature } of queued) {
      const res = await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Stripe-Signature': signature }, body })
      expect([res.status, ((await res.json()) as { duplicate?: boolean }).duplicate]).toEqual([200, undefined])
    }
    expect(await plan(client)).toBe('flat')
    expect((await client.get('/api/billing')).body.status).toBe('active')
  })

  it('a price replaced under the same lookup key does not downgrade existing subscribers', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    await deliver()
    app.db.exec('DELETE FROM billing_prices')
    tracked().metadata = {}
    stripe.prices.get(tracked().priceId)!.lookupKey = 'retired'
    stripe.addPrice('reclaim_growth_monthly', 1500)
    await restart()
    stripe.endPeriod()
    await deliver()
    expect(await plan(client)).toBe('growth')
    expect((await client.get('/api/billing')).body.status).toBe('active')
    // And it still ends normally.
    await client.post('/api/billing/cancel')
    stripe.endPeriod()
    await deliver()
    expect(await plan(client)).toBe('free')
  })
})

describe('one live subscription per account', () => {
  const live = () => [...stripe.subscriptions.values()].filter((s) => !['canceled', 'incomplete_expired'].includes(s.status))

  it('overlapping subscribes charge once', async () => {
    const client = await signedIn()
    stripe.latency = 15
    const results = await Promise.all([
      client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' }),
      client.post('/api/billing/subscribe', { plan: 'flat', paymentMethodId: 'pm_card_mastercard' }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(live()).toHaveLength(1)
  })

  it('a double click on a 3-D Secure card returns the same payment, not a second one', async () => {
    const client = await signedIn()
    const body = { plan: 'growth', paymentMethodId: 'pm_card_authenticationRequired' }
    const [a, b] = await Promise.all([client.post('/api/billing/subscribe', body), client.post('/api/billing/subscribe', body)])
    expect(a.body.subscriptionId).toBe(b.body.subscriptionId)
    expect(live()).toHaveLength(1)
  })

  it('a second 3-D Secure attempt cancels the first, so both can never be paid', async () => {
    const client = await signedIn()
    const first = await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_authenticationRequired' })
    const second = await client.post('/api/billing/subscribe', { plan: 'flat', paymentMethodId: 'pm_card_authenticationRequired' })
    expect(second.body.subscriptionId).not.toBe(first.body.subscriptionId)
    expect(() => stripe.completeAuthentication(first.body.subscriptionId)).toThrow()
    stripe.completeAuthentication(second.body.subscriptionId)
    await deliver()
    expect(await plan(client)).toBe('flat')
    expect(live()).toHaveLength(1)
  })

  it('an attempt paid before its event arrives is adopted instead of buying again', async () => {
    const client = await signedIn()
    const first = await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_authenticationRequired' })
    stripe.completeAuthentication(first.body.subscriptionId)
    const again = await client.post('/api/billing/subscribe', { plan: 'flat', paymentMethodId: 'pm_card_visa' })
    expect(again.status).toBe(409)
    expect(await plan(client)).toBe('growth')
    expect(live()).toHaveLength(1)
  })

  it('a duplicate left by an older version is cancelled when Stripe reports it', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    const tracked = live()[0]
    const extra = await stripe.createSubscription({ customerId: tracked.customer, priceId: tracked.priceId, paymentMethodId: 'pm_card_visa', userId: tracked.metadata.reclaim_user_id, plan: 'growth' }, 'other')
    await deliver()
    expect(live().map((s) => s.id)).toEqual([tracked.id])
    expect(stripe.subscriptions.get(extra.id)!.status).toBe('canceled')
    expect(await plan(client)).toBe('growth')
  })

  it('when the tracked subscription ends but another is still paid, the paid one takes over', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    const tracked = live()[0]
    const flat = [...stripe.prices.values()].find((p) => p.lookupKey === 'reclaim_flat_monthly')!
    // Made by an operator in the dashboard: no Reclaim metadata, so it is left alone.
    const manual = await stripe.createSubscription({ customerId: tracked.customer, priceId: flat.id, paymentMethodId: 'pm_card_visa', userId: 'operator', plan: 'flat' }, 'manual')
    await deliver()
    expect(await plan(client)).toBe('growth')
    stripe.exhaustRetries(tracked.id)
    await deliver()
    expect(await plan(client)).toBe('flat')
    expect(live().map((s) => s.id)).toEqual([manual.id])
  })

  it('deleting the account cancels every subscription that could still charge', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    const tracked = live()[0]
    for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'] as const) {
      const extra = await stripe.createSubscription({ customerId: tracked.customer, priceId: tracked.priceId, paymentMethodId: 'pm_card_visa', userId: 'someone', plan: 'growth' }, `extra-${status}`)
      stripe.subscriptions.get(extra.id)!.status = status
    }
    expect((await client.post('/api/account/delete', { confirmEmail: 'pilot@example.com' })).status).toBe(200)
    expect(live()).toEqual([])
  })

  it('a subscribe that overlaps deletion cannot leave a subscription behind', async () => {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_authenticationRequired' })
    stripe.latency = 15
    const [deleted] = await Promise.all([client.post('/api/account/delete', { confirmEmail: 'pilot@example.com' }), client.post('/api/billing/subscribe', { plan: 'flat', paymentMethodId: 'pm_card_visa' })])
    expect(deleted.status).toBe(200)
    expect(live()).toEqual([])
  })
})

describe('updating the card', () => {
  async function pastDue(status: 'past_due' | 'unpaid' = 'past_due') {
    const client = await signedIn()
    await client.post('/api/billing/subscribe', { plan: 'growth', paymentMethodId: 'pm_card_visa' })
    const sub = [...stripe.subscriptions.values()][0]
    stripe.failRenewal(sub.id)
    sub.status = status
    await deliver()
    return { client, sub }
  }

  it('a past-due customer’s new card is saved and the open bill is paid with it', async () => {
    const { client, sub } = await pastDue()
    const res = await client.post('/api/billing/card', { paymentMethodId: 'pm_card_new' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'active', billing: { status: 'active' } })
    expect(sub.defaultPaymentMethod).toBe('pm_card_new')
    expect(stripe.calls).toContain('payInvoice')
    expect([...stripe.customers.values()][0].defaultPaymentMethod).toBe('pm_card_new')
  })

  it('3-D Secure on the new card is finished in the browser, then confirmed', async () => {
    const { client, sub } = await pastDue()
    const res = await client.post('/api/billing/card', { paymentMethodId: 'pm_card_authenticationRequired' })
    expect(res.body).toMatchObject({ status: 'requires_action', clientSecret: expect.any(String), subscriptionId: sub.id })
    expect((await client.post('/api/billing/card/confirm', { subscriptionId: sub.id })).status).toBe(402)
    stripe.completeAuthentication(sub.id)
    const confirmed = await client.post('/api/billing/card/confirm', { subscriptionId: sub.id })
    expect(confirmed.status).toBe(200)
    expect(confirmed.body.billing.status).toBe('active')
  })

  it('a declined new card says so and keeps the plan during Stripe’s retries', async () => {
    const { client } = await pastDue()
    const res = await client.post('/api/billing/card', { paymentMethodId: 'pm_card_chargeDeclined' })
    expect(res.status).toBe(402)
    expect(res.body.message).toMatch(/declined/)
    expect(await plan(client)).toBe('growth')
  })

  it('an unpaid subscription comes back, and a paid-up one changes card without being charged', async () => {
    const { client } = await pastDue('unpaid')
    expect(await plan(client)).toBe('free')
    expect((await client.post('/api/billing/card', { paymentMethodId: 'pm_card_new' })).status).toBe(200)
    expect(await plan(client)).toBe('growth')
    stripe.calls = []
    expect((await client.post('/api/billing/card', { paymentMethodId: 'pm_card_newer' })).status).toBe(200)
    expect(stripe.calls).not.toContain('payInvoice')
  })

  it('needs a subscription and a Stripe card id', async () => {
    const client = await signedIn()
    expect((await client.post('/api/billing/card', { paymentMethodId: 'pm_card_visa' })).status).toBe(409)
    expect((await client.post('/api/billing/card', { paymentMethodId: '4242' })).status).toBe(400)
  })
})

describe('Stripe REST client', () => {
  it('form-encodes nested params the way Stripe expects', () => {
    expect(decodeURIComponent(formEncode({ items: [{ price: 'p_1' }], expand: ['latest_invoice.payment_intent'], metadata: { a: 'b' }, skip: undefined }))).toBe(
      'items[0][price]=p_1&expand[0]=latest_invoice.payment_intent&metadata[a]=b'
    )
  })

  it('reads the period end from either API shape', () => {
    expect(normalizeSubscription({ id: 's', customer: 'c', status: 'active', current_period_end: 10, items: { data: [{ id: 'si', price: { id: 'p' } }] } }).currentPeriodEnd).toBe(10)
    expect(normalizeSubscription({ id: 's', customer: 'c', status: 'active', items: { data: [{ id: 'si', price: 'p', current_period_end: 20 }] } })).toMatchObject({ currentPeriodEnd: 20, priceId: 'p' })
  })

  it('pins the API version, sends idempotency keys and surfaces card errors', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      if (url.endsWith('/attach')) return new Response(JSON.stringify({ error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } }), { status: 402 })
      return new Response(JSON.stringify({ id: 'cus_1' }), { status: 200 })
    }) as typeof fetch
    const client = createStripeClient('sk_test_x', fetchImpl)
    await client.createCustomer({ email: 'a@b.c', name: 'A', userId: 'u1' }, 'key-1')
    const headers = seen[0].init.headers as Record<string, string>
    expect(headers['Stripe-Version']).toBe('2024-06-20')
    expect(headers['Idempotency-Key']).toBe('key-1')
    await expect(client.attachPaymentMethod('pm_1', 'cus_1')).rejects.toMatchObject({ type: 'card_error', message: 'Your card was declined.' })
  })
})
