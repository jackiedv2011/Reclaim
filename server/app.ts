import { canonicalCurrency, isoDay, storedDay } from '../src/lib/format.ts'
import { createServer, type Server } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './db.ts'
import { ProjectStore } from './projectStore.ts'
import { CaseCommands } from './caseCommands.ts'
import { accountRoutes } from './account.ts'
import { AuthService, normalizeEmail } from './auth.ts'
import { DevMailer, GmailMailer, ResendMailer, type Mailer } from './mailer.ts'
import { createGoogleClient, type GoogleClient } from './google.ts'
import { DraftRequestSchema, type DraftService } from './ai.ts'
import { answerCaseQuestion } from './assistant.ts'
import type { ServerConfig } from './config.ts'
import { HttpError, RateLimiter, compressed, isCrossSiteWrite, json, redirect, serializeCookie, toRequest, writeResponse, type Request, type Response } from './http.ts'
import { newToken, openSecret, sealSecret } from './crypto.ts'
import { createQuickBooksClient, migrateQuickBooksLink, syncLedger, QuickBooksReconnectError, QuickBooksUnauthorizedError, type QuickBooksClient, type QuickBooksTokens } from './quickbooks.ts'
import { entitlementsFor, isPlan, monthStart, planOf, PLAN_LIMITS, type Plan } from './plans.ts'
import { AUDIT_TOO_LARGE, MAX_AUDIT_BYTES, checkRepeat, repeatMessage, rowFingerprint } from './uploads.ts'
import { createBilling } from './billing.ts'
import { createStripeClient, type StripeApi } from './stripe.ts'
import { createGmailClient, createGmailRoutes, type GmailClient } from './gmail.ts'
import { createLedgerRoutes } from './ledgerRoutes.ts'
import { resealLedger } from './ledger.ts'
import { OnboardingProfileSchema } from './onboarding.ts'
import { serveStatic } from './staticFiles.ts'
// Recovery automation and secure AI workstream (docs/workstream-recovery-ai).
import { tenantForUser } from './tenant.ts'
import { createSealer } from './sealedJson.ts'
import { AiExecutionService } from './aiGateway/service.ts'
import { createAnthropicProvider, type AiProvider } from './aiGateway/providers.ts'
import { draftServiceProvider } from './aiGateway/legacyDraft.ts'
import { registerAiTasks } from './aiGateway/tasks/index.ts'
import { ApprovalService } from './approvals.ts'
import { createRecoveryRoutes } from './recoveryRoutes.ts'
import { createJobRoutes } from './jobs/routes.ts'
import { createInboundRoutes } from './inbound/routes.ts'
import { createDocumentRoutes } from './documents/routes.ts'
import { DEFAULT_WORKSTREAM_SETTINGS, type WorkstreamDeps, type WorkstreamSettings } from './workstream.ts'

const SESSION_COOKIE = 'reclaim_session'
const OAUTH_STATE_COOKIE = 'reclaim_oauth_state'
const QBO_STATE_COOKIE = 'reclaim_qbo_state'
const QBO_PATH = '/api/integrations/quickbooks'

export interface AppDependencies {
  config: ServerConfig
  db?: DatabaseSync
  mailer?: Mailer
  google?: GoogleClient | null
  /** The original draft service; now a provider for the draft task only, fed the minimised packet. */
  drafts?: DraftService | null
  /** The provider for every AI task (tests pass a mock). Defaults to Anthropic when ANTHROPIC_API_KEY is set. */
  aiProvider?: AiProvider | null
  /** Inbound webhook and reply-domain switches; all off unless a test or a founder-approved setup passes them. */
  workstream?: Partial<WorkstreamSettings>
  quickbooks?: QuickBooksClient | null
  /** Stripe (tests pass FakeStripe). Defaults to the REST client when STRIPE_SECRET_KEY is set. */
  stripe?: StripeApi | null
  gmail?: GmailClient | null
  /** The clock Gmail follow-ups are timed by (tests). */
  now?: () => number
  /** Directory of built static files to serve alongside the API (production). */
  staticDir?: string | null
}

export interface App {
  server: Server
  db: DatabaseSync
  auth: AuthService
  mailer: Mailer
  /** Resolves when background success-fee billing has caught up (tests). */
  billingIdle(): Promise<void>
  listen(port?: number): Promise<number>
  close(): Promise<void>
}

export function createApp(deps: AppDependencies): App {
  const { config } = deps
  const db = deps.db ?? openDatabase(config.databasePath)
  const projects = new ProjectStore(db, config.dataKeys)
  const sealedNow = projects.migrate()
  if (sealedNow) console.log(`  encrypted ${sealedNow} stored audits at rest`)
  const sealedLedger = resealLedger(db, config.dataKeys)
  if (sealedLedger) console.log(`  sealed ${sealedLedger} server ledger rows at rest`)
  const caseCommands = new CaseCommands(db, projects)
  caseCommands.migrateLegacy()
  const mailer = deps.mailer ?? (config.resend ? new ResendMailer(config.resend.apiKey, config.resend.from) : config.gmail ? new GmailMailer(config.gmail.user, config.gmail.appPassword) : new DevMailer(db))
  const google = deps.google !== undefined ? deps.google : config.google ? createGoogleClient(config.google.clientId, config.google.clientSecret) : null
  const aiProvider = deps.aiProvider !== undefined ? deps.aiProvider : config.anthropicApiKey ? createAnthropicProvider(config.anthropicApiKey, config.anthropicModel) : null
  const ai = registerAiTasks(new AiExecutionService({ db, providers: [deps.drafts ? draftServiceProvider(deps.drafts) : null, aiProvider], getProject: (tenantId, projectId) => projects.get(tenantId, projectId), now: deps.now }))
  const quickbooks = deps.quickbooks !== undefined ? deps.quickbooks : config.quickbooks ? createQuickBooksClient(config.quickbooks.clientId, config.quickbooks.clientSecret, fetch, config.quickbooks.environment) : null
  const auth = new AuthService(db, mailer, {
    appOrigin: config.appOrigin,
    requireEmailVerification: config.requireEmailVerification,
    sessionMs: config.sessionDays * 24 * 60 * 60 * 1000,
    rememberMeMs: config.rememberMeDays * 24 * 60 * 60 * 1000,
  })
  const credentialLimiter = new RateLimiter(20, 60 * 1000)
  // Per address, whatever IP asks: stops password guessing spread over many IPs,
  // and stops anyone using Reclaim to flood someone's inbox with its emails.
  const loginEmailLimiter = new RateLimiter(10, 15 * 60 * 1000)
  const mailLimiter = new RateLimiter(5, 60 * 60 * 1000)
  const draftLimiter = new RateLimiter(30, 60 * 60 * 1000)
  const contactLimiter = new RateLimiter(5, 60 * 60 * 1000)
  const quickbooksSyncLimiter = new RateLimiter(20, 60 * 60 * 1000)
  const gmailSendLimiter = new RateLimiter(30, 60 * 60 * 1000)
  const gmailClient = deps.gmail !== undefined ? deps.gmail : config.gmailSend ? createGmailClient(config.gmailSend.clientId, config.gmailSend.clientSecret) : null
  const gmailRoutes = createGmailRoutes({ db, appOrigin: config.appOrigin, production: config.production, gmail: gmailClient && config.gmailSend ? { client: gmailClient, tokenKey: config.gmailSend.tokenKey } : null, userFor: (req) => auth.userForSession(req.cookies[SESSION_COOKIE]), getProject: (userId, projectId) => projects.get(userId, projectId), listProjects: (userId) => projects.list(userId), allowSend: (id) => gmailSendLimiter.check(`gmail:${id}`), now: deps.now })

  const sessionCookie = (token: string, maxAge: number) => serializeCookie(SESSION_COOKIE, token, { maxAge, secure: config.production })
  const clearSessionCookie = () => serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: config.production })
  const publicUser = (row: NonNullable<ReturnType<AuthService['findUserById']>>) => auth.toPublic(row)

  const requireUser = (req: Request) => {
    const user = auth.userForSession(req.cookies[SESSION_COOKIE])
    if (!user) throw new HttpError(401, 'You need to log in.', 'unauthenticated')
    return user
  }
  // Plan usage is counted from audit_starts: one row per audit the server
  // accepted, stamped with the server's clock. Deleting an audit does not
  // delete its start, and nothing the client sends (a back-dated createdAt)
  // can move a start out of the current month.
  const auditsThisMonth = (userId: string) =>
    (db.prepare('SELECT COUNT(*) AS n FROM audit_starts WHERE user_id = ? AND started_at >= ?').get(userId, monthStart()) as { n: number }).n
  const entitlements = (user: { id: string; plan: string }) => entitlementsFor(planOf(user.plan), auditsThisMonth(user.id))

  // Free-track repeat uploads: every payment row an account has uploaded, and which audit it went to.
  const projectFingerprints = (project: Record<string, unknown>): string[] => {
    const records = ((project.environment as { records?: unknown[] }).records ?? []) as Array<Record<string, unknown>>
    return records
      .filter((r) => typeof r.vendor === 'string' && typeof r.amountPaid === 'number' && typeof r.paymentDate === 'string')
      .map((r) => rowFingerprint({ vendor: r.vendor as string, invoiceNumber: (r.invoiceNumber as string | null) ?? null, paymentDate: r.paymentDate as string, amountPaid: r.amountPaid as number }))
  }
  const assertNotRepeat = (user: { id: string; plan: string }, projectId: string, fingerprints: string[]) => {
    if (!PLAN_LIMITS[planOf(user.plan)].blocksRepeatUploads) return
    const owner = db.prepare('SELECT project_id FROM upload_rows WHERE user_id = ? AND fingerprint = ?')
    // Only rows new to this audit are judged; re-saving an audit's own rows is not an upload.
    const fresh = fingerprints.filter((fp) => (owner.get(user.id, fp) as { project_id: string } | undefined)?.project_id !== projectId)
    const check = checkRepeat(fresh, (fp) => owner.get(user.id, fp) !== undefined)
    if (check.repeat) throw new HttpError(409, repeatMessage(check), 'repeat_upload', { feature: 'repeat_upload' })
  }
  const rememberUpload = (userId: string, projectId: string, fingerprints: string[]) => {
    const insert = db.prepare('INSERT OR IGNORE INTO upload_rows (user_id, fingerprint, project_id, first_seen) VALUES (?, ?, ?, ?)')
    const now = Date.now()
    for (const fp of new Set(fingerprints)) insert.run(userId, fp, projectId, now)
  }
  const recordAuditStart = (userId: string, projectId: string) =>
    db.prepare('INSERT INTO audit_starts (user_id, project_id, started_at) VALUES (?, ?, ?)').run(userId, projectId, Date.now())
  /** An audit on the wire may be gzipped, up to the size the browser promises to stay under. */
  const auditBody = { maxDecompressed: MAX_AUDIT_BYTES, tooLarge: AUDIT_TOO_LARGE }
  /** The client already holds what it sent, and an audit can be 100 MB: it may ask not to have it echoed. */
  const wantsMinimal = (req: Request) => /\breturn=minimal\b/.test(String(req.headers.prefer ?? ''))
  /** The audit, its place in the plan's count and its row fingerprints, together or not at all. */
  const storeUpload = (userId: string, projectId: string, fingerprints: string[], project: Record<string, unknown>, isNew: boolean): number => {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (isNew) recordAuditStart(userId, projectId)
      const revision = projects.upsert(userId, project)
      rememberUpload(userId, projectId, fingerprints)
      db.exec('COMMIT')
      return revision
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  const requireJson = (req: Request) => {
    if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Send JSON.')
  }
  // What a refused caller is told to wait: each limiter's own window, and nothing shorter.
  const waits = new Map<RateLimiter, string>([
    [credentialLimiter, 'a minute'],
    [loginEmailLimiter, '15 minutes'],
  ])
  const limit = (limiter: RateLimiter, key: string) => {
    if (!limiter.check(key)) throw new HttpError(429, `Too many attempts. Wait ${waits.get(limiter) ?? 'an hour'} and try again.`, 'rate_limited')
  }
  const ledgerImportLimiter = new RateLimiter(60, 60 * 60 * 1000)
  const ledgerRoutes = createLedgerRoutes({ db, keys: config.dataKeys, enabled: config.serverLedger === true, requireUser, requireJson, limitImport: (userId) => limit(ledgerImportLimiter, `ledger-import:${userId}`) })

  // QuickBooks Online (GET-only adapter, write-capable OAuth scope; sandbox or production per QBO_ENVIRONMENT). Tokens are sealed at rest under a
  // key from the environment; they are never logged and never sent to the browser.
  const qbo = quickbooks && config.quickbooks ? { client: quickbooks, key: config.quickbooks.tokenKey } : null
  const qboRedirectUri = `${config.appOrigin}${QBO_PATH}/callback`
  migrateQuickBooksLink(db)
  type ConnectionRow = { realm_id: string; company_name: string; tokens_sealed: string; connected_at: number; last_sync_at: number | null; linked_project_id: string | null }
  const sealContext = (userId: string, realmId: string) => `quickbooks:${userId}:${realmId}`
  const qboConnection = (userId: string) =>
    db.prepare("SELECT realm_id, company_name, tokens_sealed, connected_at, last_sync_at, linked_project_id FROM integration_connections WHERE user_id = ? AND provider = 'quickbooks'").get(userId) as ConnectionRow | undefined
  const dropQboConnection = (userId: string) => db.prepare("DELETE FROM integration_connections WHERE user_id = ? AND provider = 'quickbooks'").run(userId)
  const qboTokens = (userId: string, row: ConnectionRow): QuickBooksTokens => {
    try {
      return JSON.parse(openSecret(row.tokens_sealed, qbo!.key, sealContext(userId, row.realm_id))) as QuickBooksTokens
    } catch {
      // Wrong key, altered row, or a row moved between accounts: never usable.
      throw new QuickBooksReconnectError('Stored QuickBooks tokens could not be opened.')
    }
  }
  /** Tells Intuit to cancel the connection. Deleting the sealed tokens afterwards still ends Reclaim's access if this fails. */
  const revokeQuickBooks = async (userId: string) => {
    const row = qboConnection(userId)
    if (!row || !qbo) return
    try {
      await qbo.client.revoke(qboTokens(userId, row).refreshToken)
    } catch (err) {
      console.error('quickbooks revoke failed:', err instanceof Error ? err.message : 'unknown error')
    }
  }
  const billing = createBilling({ db, auth, requireUser, stripe: deps.stripe !== undefined ? deps.stripe : config.stripe ? createStripeClient(config.stripe.secretKey) : null, webhookSecret: config.stripe?.webhookSecret ?? null })
  const revokeIntegrations = async (userId: string) => {
    await revokeQuickBooks(userId)
    await gmailRoutes.revoke(userId)
  }
  const accountContext = { db, projects, requireUser, publicUser, clearSessionCookie, revokeIntegrations, endSubscription: billing.closeAccount }
  /** A usable access token, refreshed and re-sealed when it is about to expire (or when `force`d after a 401). */
  async function qboAccessToken(userId: string, row: ConnectionRow, force = false): Promise<string> {
    const tokens = qboTokens(userId, row)
    if (!force && tokens.accessExpiresAt - Date.now() > 60_000) return tokens.accessToken
    const fresh = await qbo!.client.refresh(tokens.refreshToken)
    db.prepare("UPDATE integration_connections SET tokens_sealed = ? WHERE user_id = ? AND provider = 'quickbooks'")
      .run(sealSecret(JSON.stringify(fresh), qbo!.key, sealContext(userId, row.realm_id)), userId)
    return fresh.accessToken
  }

  async function route(req: Request): Promise<Response> {
    const path = req.url.pathname
    const method = req.method
    if (isCrossSiteWrite(req, config.appOrigin, config.production)) throw new HttpError(403, 'This request came from another site.', 'cross_site')

    // ---------- discovery ----------
    if (path === '/api/auth/providers' && method === 'GET') {
      return json(200, { google: google !== null, ai: ai.providerFor('draft_recovery_request') !== null, emailDelivery: mailer.kind, requireEmailVerification: config.requireEmailVerification, devMailbox: config.devMailbox })
    }

    // ---------- landing-site contact form ----------
    if (path === '/api/contact' && method === 'POST') {
      requireJson(req)
      limit(contactLimiter, `contact:${req.ip}`)
      const body = await req.json<Record<string, unknown>>()
      const text = (key: string, max: number) => (typeof body[key] === 'string' ? (body[key] as string).trim().slice(0, max) : '')
      const name = text('name', 120)
      const email = text('email', 254)
      const role = text('role', 80)
      const message = text('message', 4000)
      const systems = Array.isArray(body.systems) ? body.systems.filter((s): s is string => typeof s === 'string').slice(0, 12).map((s) => s.slice(0, 60)) : []
      const kind = body.kind === 'audit' ? 'Get started' : 'Talk to us'
      const fields: Record<string, string> = {}
      if (!name) fields.name = 'Please enter your name.'
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fields.email = 'Please enter a valid work email.'
      if (!role) fields.role = 'Please select your role.'
      if (Object.keys(fields).length) return json(400, { message: 'Check the highlighted fields.', code: 'validation', fields })
      // Header-safe: no line breaks in the subject.
      const subject = `${kind}: ${name} (${role})`.replace(/[\r\n]+/g, ' ')
      await mailer.send({
        to: config.contactEmail,
        replyTo: email,
        subject,
        body: [`${kind} form on the Reclaim website`, '', `Name: ${name}`, `Email: ${email}`, `Role: ${role}`, `Systems: ${systems.join(', ') || '—'}`, '', message ? `Message:\n${message}` : 'No message.'].join('\n'),
      })
      return json(200, { ok: true })
    }

    // ---------- email/password ----------
    if (path === '/api/auth/signup' && method === 'POST') {
      requireJson(req)
      limit(credentialLimiter, `signup:${req.ip}`)
      const body = await req.json<Record<string, unknown>>()
      const fields = auth.validateSignUp(body)
      if (Object.keys(fields).length) return json(400, { message: 'Check the highlighted fields.', code: 'validation', fields })
      limit(mailLimiter, `signup:${normalizeEmail(body.email as string)}`)
      const result = await auth.signUp({
        firstName: body.firstName as string,
        lastName: body.lastName as string,
        email: body.email as string,
        company: body.company as string,
        password: body.password as string,
        termsVersion: typeof body.termsVersion === 'string' ? body.termsVersion : null,
      })
      if (result.sessionUserId) {
        const session = auth.createSession(result.sessionUserId, false)
        return json(201, { requiresVerification: false, user: result.user }, { 'Set-Cookie': sessionCookie(session.token, session.maxAgeSeconds) })
      }
      return json(201, { requiresVerification: result.requiresVerification, email: normalizeEmail(body.email as string) })
    }

    if (path === '/api/auth/verify-email' && method === 'POST') {
      requireJson(req)
      const { token } = await req.json<{ token?: string }>()
      const user = auth.verifyEmail(token ?? '')
      const session = auth.createSession(user.id, false)
      return json(200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(session.token, session.maxAgeSeconds) })
    }

    if (path === '/api/auth/resend-verification' && method === 'POST') {
      requireJson(req)
      limit(credentialLimiter, `resend:${req.ip}`)
      const { email } = await req.json<{ email?: string }>()
      // Over the per-address limit nothing is sent, and the answer is the same.
      if (typeof email === 'string' && mailLimiter.check(`resend:${normalizeEmail(email)}`)) await auth.resendVerification(email)
      return json(200, { ok: true })
    }

    if (path === '/api/auth/login' && method === 'POST') {
      requireJson(req)
      limit(credentialLimiter, `login:${req.ip}`)
      const { email, password, rememberMe } = await req.json<{ email?: string; password?: string; rememberMe?: boolean }>()
      if (typeof email !== 'string' || typeof password !== 'string') throw new HttpError(400, 'Enter your email and password.')
      limit(loginEmailLimiter, `login:${normalizeEmail(email)}`)
      const user = await auth.logIn(email, password)
      const session = auth.createSession(user.id, rememberMe === true)
      return json(200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(session.token, session.maxAgeSeconds) })
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      auth.revokeSession(req.cookies[SESSION_COOKIE])
      return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie() })
    }

    if (path === '/api/auth/me' && method === 'GET') {
      const user = auth.userForSession(req.cookies[SESSION_COOKIE])
      if (!user) return json(401, { message: 'Not logged in.', code: 'unauthenticated' }, { 'Set-Cookie': clearSessionCookie() })
      return json(200, { user: publicUser(user) })
    }

    if (path === '/api/auth/forgot-password' && method === 'POST') {
      requireJson(req)
      limit(credentialLimiter, `forgot:${req.ip}`)
      const { email } = await req.json<{ email?: string }>()
      if (typeof email === 'string' && email.trim() && mailLimiter.check(`forgot:${normalizeEmail(email)}`)) await auth.requestPasswordReset(email)
      // Same answer whether or not the address is registered.
      return json(200, { ok: true })
    }

    if (path === '/api/auth/reset-password' && method === 'POST') {
      requireJson(req)
      limit(credentialLimiter, `reset:${req.ip}`)
      const { token, password, confirmPassword } = await req.json<{ token?: string; password?: string; confirmPassword?: string }>()
      const user = await auth.resetPassword(token ?? '', password ?? '', confirmPassword ?? '')
      const session = auth.createSession(user.id, false)
      return json(200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(session.token, session.maxAgeSeconds) })
    }

    // ---------- google sign-in ----------
    if (path === '/api/auth/google' && method === 'GET') {
      if (!google) throw new HttpError(503, 'Google sign-in is not configured on this server.', 'google_unavailable')
      const { token: state } = newToken()
      const url = google.authorizationUrl({ redirectUri: `${config.appOrigin}/api/auth/google/callback`, state })
      return redirect(url, { 'Set-Cookie': serializeCookie(OAUTH_STATE_COOKIE, state, { maxAge: 600, secure: config.production }) })
    }

    if (path === '/api/auth/google/callback' && method === 'GET') {
      const clearState = serializeCookie(OAUTH_STATE_COOKIE, '', { maxAge: 0, secure: config.production })
      const back = (error: string) => redirect(`/login?error=${error}`, { 'Set-Cookie': clearState })
      if (!google) return back('google_unavailable')
      const params = req.url.searchParams
      const error = params.get('error')
      if (error === 'access_denied') return back('google_cancelled')
      if (error) return back('google_failed')
      const code = params.get('code')
      const state = params.get('state')
      if (!code || !state || state !== req.cookies[OAUTH_STATE_COOKIE]) return back('google_state')
      try {
        const identity = await google.exchangeCode({ code, redirectUri: `${config.appOrigin}/api/auth/google/callback` })
        const user = auth.userForGoogleIdentity(identity, null)
        const session = auth.createSession(user.id, true)
        return redirect('/audit', { 'Set-Cookie': [sessionCookie(session.token, session.maxAgeSeconds), clearState] })
      } catch (err) {
        if (err instanceof HttpError && err.code === 'google_email_unverified') return back('google_email_unverified')
        console.error('google sign-in failed:', err instanceof Error ? err.message : 'unknown error')
        return back('google_failed')
      }
    }

    // ---------- QuickBooks Online (GET-only adapter; OAuth permission also permits writes) ----------
    if (path === QBO_PATH && method === 'GET') {
      const user = requireUser(req)
      if (!qbo) return json(200, { available: false })
      const row = qboConnection(user.id)
      return json(200, { available: true, environment: qbo.client.environment, connected: Boolean(row), companyName: row?.company_name ?? null, connectedAt: row?.connected_at ?? null, lastSyncAt: row?.last_sync_at ?? null, linkedAuditId: row?.linked_project_id ?? null })
    }

    if (path === `${QBO_PATH}/connect` && method === 'GET') {
      const user = auth.userForSession(req.cookies[SESSION_COOKIE])
      if (!user) return redirect('/login?next=%2Faudit%3Fentry%3Dupload')
      if (!qbo) return redirect('/audit?entry=upload&quickbooks=unavailable')
      const { token: state } = newToken()
      const url = qbo.client.authorizationUrl({ redirectUri: qboRedirectUri, state })
      // The state names the account that started, so a callback can only finish its own user's connection.
      return redirect(url, { 'Set-Cookie': serializeCookie(QBO_STATE_COOKIE, `${state}.${user.id}`, { maxAge: 600, secure: config.production, path: QBO_PATH }) })
    }

    if (path === `${QBO_PATH}/callback` && method === 'GET') {
      const clearState = serializeCookie(QBO_STATE_COOKIE, '', { maxAge: 0, secure: config.production, path: QBO_PATH })
      const back = (status: string) => redirect(`/audit?entry=upload&quickbooks=${status}`, { 'Set-Cookie': clearState })
      if (!qbo) return back('unavailable')
      const user = auth.userForSession(req.cookies[SESSION_COOKIE])
      if (!user) return back('signed_out')
      const params = req.url.searchParams
      if (params.get('error') === 'access_denied') return back('cancelled')
      if (params.get('error')) return back('failed')
      const code = params.get('code')
      const state = params.get('state')
      const realmId = params.get('realmId')
      const expected = req.cookies[QBO_STATE_COOKIE]
      if (!code || !state || !realmId || !/^\d+$/.test(realmId) || !expected || expected !== `${state}.${user.id}`) return back('state')
      try {
        const tokens = await qbo.client.exchangeCode({ code, redirectUri: qboRedirectUri })
        const company = await qbo.client.companyInfo(realmId, tokens.accessToken)
        const companyName = typeof company.CompanyName === 'string' ? company.CompanyName.slice(0, 200) : ''
        db.prepare(`INSERT INTO integration_connections (user_id, provider, realm_id, company_name, tokens_sealed, connected_at, last_sync_at)
          VALUES (?, 'quickbooks', ?, ?, ?, ?, NULL)
          ON CONFLICT(user_id, provider) DO UPDATE SET
            -- Reconnecting the same company keeps its audit; a different company starts unlinked.
            linked_project_id = CASE WHEN integration_connections.realm_id = excluded.realm_id THEN integration_connections.linked_project_id ELSE NULL END,
            realm_id = excluded.realm_id, company_name = excluded.company_name,
            tokens_sealed = excluded.tokens_sealed, connected_at = excluded.connected_at, last_sync_at = NULL`)
          .run(user.id, realmId, companyName, sealSecret(JSON.stringify(tokens), qbo.key, sealContext(user.id, realmId)), Date.now())
        return back('connected')
      } catch (err) {
        console.error('quickbooks connect failed:', err instanceof Error ? err.message : 'unknown error')
        return back('failed')
      }
    }

    if (path === `${QBO_PATH}/sync` && method === 'POST') {
      const user = requireUser(req)
      if (!qbo) throw new HttpError(503, 'QuickBooks is not set up on this server.', 'quickbooks_unavailable')
      limit(quickbooksSyncLimiter, user.id)
      const row = qboConnection(user.id)
      if (!row) throw new HttpError(409, 'Connect QuickBooks first.', 'quickbooks_not_connected')
      // The client says when it last pulled this company into the audit it is importing into; recent enough means only changes.
      const body = await req.json<{ since?: unknown }>().catch(() => ({}) as { since?: unknown })
      const since = typeof body.since === 'number' && Number.isFinite(body.since) ? body.since : null
      // Taken before reading, so anything changed during the pull is picked up next time.
      const pulledAt = Date.now()
      try {
        let accessToken = await qboAccessToken(user.id, row)
        let result
        try {
          result = await syncLedger(qbo.client, row.realm_id, accessToken, since, pulledAt)
        } catch (err) {
          if (!(err instanceof QuickBooksUnauthorizedError)) throw err
          accessToken = await qboAccessToken(user.id, qboConnection(user.id)!, true)
          result = await syncLedger(qbo.client, row.realm_id, accessToken, since, pulledAt)
        }
        db.prepare("UPDATE integration_connections SET last_sync_at = ? WHERE user_id = ? AND provider = 'quickbooks'").run(Date.now(), user.id)
        return json(200, { companyName: row.company_name, ...result })
      } catch (err) {
        if (err instanceof QuickBooksReconnectError || err instanceof QuickBooksUnauthorizedError) {
          dropQboConnection(user.id)
          throw new HttpError(409, 'QuickBooks needs to be connected again.', 'quickbooks_reconnect')
        }
        console.error('quickbooks sync failed:', err instanceof Error ? err.message : 'unknown error')
        throw new HttpError(502, 'QuickBooks didn’t respond as expected. Try again in a minute.', 'quickbooks_failed')
      }
    }

    // Which audit this connection keeps up to date when the user signs in.
    if (path === `${QBO_PATH}/link` && method === 'POST') {
      const user = requireUser(req)
      requireJson(req)
      const { auditId } = await req.json<{ auditId?: unknown }>()
      if (typeof auditId !== 'string' || !/^[\w-]{1,100}$/.test(auditId)) throw new HttpError(400, 'Send the audit to link.')
      if (!qboConnection(user.id)) throw new HttpError(409, 'Connect QuickBooks first.', 'quickbooks_not_connected')
      // Only an audit this account has saved on the server can be linked (audit S8).
      if (!db.prepare('SELECT 1 FROM projects WHERE user_id = ? AND id = ?').get(user.id, auditId)) throw new HttpError(404, 'That audit was not found.', 'audit_not_found')
      db.prepare("UPDATE integration_connections SET linked_project_id = ? WHERE user_id = ? AND provider = 'quickbooks'").run(auditId, user.id)
      return json(200, { ok: true, linkedAuditId: auditId })
    }

    if (path === `${QBO_PATH}/disconnect` && method === 'POST') {
      const user = requireUser(req)
      await revokeQuickBooks(user.id)
      dropQboConnection(user.id)
      return json(200, { ok: true })
    }

    // ---------- billing (server/billing.ts) ----------
    const billed = await billing.route(req)
    if (billed) return billed

    // ---------- data rights: export, delete account, accept changed terms (account.ts) ----------
    const accountResponse = await accountRoutes(req, accountContext)
    if (accountResponse) return accountResponse

    // ---------- plan / entitlements ----------
    if (path === '/api/account/entitlements' && method === 'GET') {
      const user = requireUser(req)
      return json(200, entitlements(user))
    }

    if (path === '/api/account/onboarding-seen' && method === 'POST') {
      const user = requireUser(req)
      auth.markOnboardingSeen(user.id)
      return json(200, { user: publicUser(auth.findUserById(user.id)!) })
    }

    if (path === '/api/account/tour-seen' && method === 'POST') {
      const user = requireUser(req)
      auth.markTourSeen(user.id)
      return json(200, { user: publicUser(auth.findUserById(user.id)!) })
    }

    if (path === '/api/account/onboarding' && method === 'POST') {
      const user = requireUser(req)
      requireJson(req)
      const parsed = OnboardingProfileSchema.safeParse(await req.json())
      if (!parsed.success) throw new HttpError(400, 'Some onboarding answers were not recognised.', 'validation')
      auth.saveOnboarding(user.id, parsed.data)
      return json(200, { user: publicUser(auth.findUserById(user.id)!) })
    }

    // Upgrading is not wired to any payment yet. This endpoint exists so the
    // client has one honest place to ask, and the answer is "not yet".
    if (path === '/api/account/upgrade' && method === 'POST') {
      requireUser(req)
      return json(501, { message: 'Paid plans are coming soon. No payment was taken.', code: 'coming_soon' })
    }

    // Development only: flip an account's plan to exercise the Pro surface.
    if (path === '/api/dev/plan' && method === 'POST') {
      if (!config.devMailbox) throw new HttpError(404, 'Not found.')
      const user = requireUser(req)
      requireJson(req)
      const { plan } = await req.json<{ plan?: unknown }>()
      if (!isPlan(plan)) throw new HttpError(400, 'plan must be "free", "growth" or "flat".')
      auth.setPlan(user.id, plan as Plan)
      return json(200, { user: publicUser(auth.findUserById(user.id)!), entitlements: entitlements({ id: user.id, plan }) })
    }

    // ---------- account data ----------
    if (path === '/api/projects' && method === 'GET') {
      const user = requireUser(req)
      // The index: enough for a browser to tell which of its copies are current, then fetch the others one at a time.
      if (req.url.searchParams.get('index') === '1') return json(200, { revisions: projects.revisions(user.id) })
      const { projects: saved, unreadable } = projects.listAll(user.id)
      const revisions = projects.revisions(user.id)
      return json(200, { projects: saved, revisions: Object.fromEntries(saved.map((project) => [project.id, revisions[project.id as string]])), unreadable })
    }

    const commandMatch = path.match(/^\/api\/projects\/([\w-]+)\/case-commands$/)
    if (commandMatch && method === 'POST') {
      const user = requireUser(req)
      requireJson(req)
      const result = caseCommands.execute(user.id, user.email, commandMatch[1], await req.json())
      billing.recordRecoveries(user.id, result.project)
      if (wantsMinimal(req)) return json(200, { revision: result.revision, replayed: result.replayed, ...changedCase(result.project, await req.json()) })
      return json(200, result)
    }

    const projectMatch = path.match(/^\/api\/projects\/([\w-]+)$/)
    if (projectMatch && method === 'GET') {
      const user = requireUser(req)
      const revision = projects.revision(user.id, projectMatch[1])
      if (revision === null) throw new HttpError(404, 'That audit is not in this account.', 'project_not_found')
      return json(200, { project: projects.get(user.id, projectMatch[1]), revision })
    }
    if (projectMatch && method === 'PUT') {
      const user = requireUser(req)
      requireJson(req)
      const project = await req.json<Record<string, unknown>>(auditBody)
      if (project.id !== projectMatch[1] || !isProjectShape(project)) throw new HttpError(400, 'Malformed project.')
      const existing = projects.get(user.id, project.id as string)
      const currentRevision = projects.revision(user.id, project.id as string)
      if (existing) {
        const removed = new Set(((existing.environment as { removedImports?: string[] } | undefined)?.removedImports ?? []))
        const incomingImports = ((project.environment as { imports?: Array<{ id?: unknown }> } | undefined)?.imports ?? []).map((batch) => String(batch?.id))
        if (incomingImports.some((batch) => removed.has(batch))) throw new HttpError(409, 'A file in this version was removed from the audit on another device. Use the saved version, then add any new file again.', 'import_removed')
        if (req.headers['if-match'] === undefined && JSON.stringify(existing) === JSON.stringify(project)) {
          return json(200, { ok: true, revision: currentRevision, project: existing, replayed: true })
        }
        const expected = Number(req.headers['if-match'])
        if (!Number.isSafeInteger(expected) || expected !== currentRevision) throw new HttpError(409, 'This project changed on another device. Reload and review before saving.', 'revision_conflict', { revision: String(currentRevision) })
        if (caseContentChanged(existing, project)) throw new HttpError(409, 'This version would change a finding that already has a decision or evidence, so it was not saved over the audit in your account.', 'case_command_required')
      } else if (req.headers['if-match'] !== undefined && db.prepare('SELECT 1 FROM audit_starts WHERE user_id = ? AND project_id = ?').get(user.id, project.id as string)) {
        // The client last saw it on the server: a stale save must not bring back a deleted audit.
        throw new HttpError(404, 'This audit was deleted on another device.', 'project_deleted')
      } else if (caseContentChanged(null, project)) {
        throw new HttpError(400, 'New projects cannot carry pre-approved cases or evidence. Import historical projects through the account import flow.', 'case_command_required')
      }
      // Check, count and store with no await in between, so two concurrent
      // uploads cannot both slip under the limit.
      const isNew = !existing
      if (isNew && !entitlements(user).canStartAudit) {
        const limit = PLAN_LIMITS[planOf(user.plan)].auditsPerMonth
        throw new HttpError(402, `The Free plan includes ${limit} audits a month. Upgrade to Pro for unlimited audits.`, 'plan_limit', { feature: 'audits' })
      }
      const fingerprints = projectFingerprints(project)
      assertNotRepeat(user, project.id as string, fingerprints)
      const revision = storeUpload(user.id, project.id as string, fingerprints, project, isNew)
      billing.recordRecoveries(user.id, project)
      return json(200, wantsMinimal(req) ? { ok: true, revision } : { ok: true, revision, project })
    }
    if (projectMatch && method === 'DELETE') {
      const user = requireUser(req)
      projects.delete(user.id, projectMatch[1])
      return json(200, { ok: true })
    }

    if (path === '/api/projects/import' && method === 'POST') {
      const user = requireUser(req)
      requireJson(req)
      const { projects: incoming } = await req.json<{ projects?: Array<Record<string, unknown>> }>(auditBody)
      if (!Array.isArray(incoming)) throw new HttpError(400, 'Send projects to import.')
      const imported: string[] = []
      const skipped: string[] = []
      // Past the plan's monthly limit: not stored, and reported so the client keeps its local copy.
      const blocked: string[] = []
      for (const project of incoming) {
        if (typeof project.id !== 'string' || !/^[\w-]+$/.test(project.id) || !isProjectShape(project)) {
          throw new HttpError(400, 'Malformed project.')
        }
      }
      for (const project of incoming) {
        const id = project.id as string
        if (projects.exists(user.id, id)) {
          skipped.push(id)
          continue
        }
        const fingerprints = projectFingerprints(project)
        if (!entitlements(user).canStartAudit) {
          blocked.push(id)
          continue
        }
        try {
          assertNotRepeat(user, id, fingerprints)
        } catch {
          blocked.push(id)
          continue
        }
        storeUpload(user.id, id, fingerprints, quarantineLegacyProject(project), true)
        billing.recordRecoveries(user.id, project, { imported: true })
        imported.push(id)
      }
      return json(200, { imported, skipped, blocked })
    }

    // ---------- ai drafting ----------
    if (path === '/api/assistant/ask' && method === 'POST') {
      const user = requireUser(req)
      requireJson(req)
      limit(draftLimiter, `assistant:${user.id}`)
      const body = await req.json<{ projectId?: unknown; findingId?: unknown; question?: unknown }>()
      if (typeof body.projectId !== 'string' || !/^[\w-]{1,100}$/.test(body.projectId) || typeof body.findingId !== 'string' || body.findingId.length > 150 || !body.findingId || typeof body.question !== 'string' || body.question.length > 500 || !body.question.trim()) throw new HttpError(400, 'Choose a case and enter a short question.', 'validation')
      return json(200, answerCaseQuestion(db, projects, user.id, body.projectId, body.findingId, body.question))
    }
    if (path === '/api/ai/draft' && method === 'POST') {
      const user = requireUser(req)
      if (!entitlements(user).limits.aiDrafts) throw new HttpError(402, 'AI recovery drafts are part of the Pro plan.', 'plan_limit', { feature: 'ai' })
      if (!ai.providerFor('draft_recovery_request')) throw new HttpError(503, 'AI drafting is not configured on this server.', 'ai_unavailable')
      requireJson(req)
      limit(draftLimiter, `draft:${user.id}`)
      const parsed = DraftRequestSchema.safeParse(await req.json())
      if (!parsed.success) throw new HttpError(400, 'The case data is malformed.', 'validation')
      // Only the ids, the amount and method asked for, the tone note and the sender's names are used; every fact comes from the stored case.
      const { projectId, findingId, amountRequested, method: resolution, userContext, sender } = parsed.data
      return recovery.draft(req, user, { projectId, findingId, amountRequested, method: resolution, userContext, sender: { businessName: sender.businessName, senderName: sender.senderName } })
    }

    // ---------- dev mailbox ----------
    if (path === '/api/dev/mailbox' && method === 'GET') {
      if (!config.devMailbox) throw new HttpError(404, 'Not found.')
      const to = req.url.searchParams.get('to')
      if (!to) throw new HttpError(400, 'Which address?')
      const rows = db.prepare('SELECT id, to_email, subject, body, link, created_at FROM mailbox WHERE to_email = ? ORDER BY id DESC LIMIT 20').all(normalizeEmail(to))
      return json(200, { messages: rows })
    }

    const gmailResponse = await gmailRoutes.route(req)
    if (gmailResponse) return gmailResponse

    const ledgerResponse = await ledgerRoutes.route(req)
    if (ledgerResponse) return ledgerResponse
    for (const group of workstreamRoutes) {
      const handled = await group(req)
      if (handled) return handled
    }

    if (path.startsWith('/api/')) throw new HttpError(404, 'Not found.')

    // ---------- static site (production) ----------
    if (deps.staticDir && (method === 'GET' || method === 'HEAD')) return serveStatic(deps.staticDir, req)
    throw new HttpError(404, 'Not found.')
  }

  // ---------- recovery automation and secure AI (workstream J1–J5) ----------
  const approvals = new ApprovalService({ db, sealer: createSealer(config.dataKeys), getProject: (tenantId, projectId) => projects.get(tenantId, projectId), revision: (tenantId, projectId) => projects.revision(tenantId, projectId), now: deps.now })
  approvals.recoverInterrupted()
  const workstream: WorkstreamDeps = {
    db, projects, caseCommands, ai, approvals, sealer: createSealer(config.dataKeys),
    requireUser, tenantFor: tenantForUser,
    afterCaseCommand: (userId, project) => billing.recordRecoveries(userId, project),
    // An internal call to this server's own routes, as the same signed-in person and with the same checks.
    dispatch: (req, method, path, payload) => route({ ...req, method, url: new URL(path, req.url), headers: { ...req.headers, 'content-type': 'application/json' }, json: async <T>() => payload as T, text: async () => JSON.stringify(payload) }),
    now: deps.now ?? Date.now,
    settings: { ...DEFAULT_WORKSTREAM_SETTINGS, ...deps.workstream },
  }
  const recovery = createRecoveryRoutes(workstream)
  const workstreamRoutes = [recovery.route, createJobRoutes(workstream), createInboundRoutes(workstream), createDocumentRoutes(workstream)]

  const server = createServer(async (rawReq, rawRes) => {
    const options = { noStore: (rawReq.url ?? '').startsWith('/api/'), hsts: config.production }
    try {
      const req = await toRequest(rawReq, { trustProxy: config.trustProxy })
      // Every route reads its body as an object; `null`, a list or a bare value is the caller's mistake, not a crash.
      const readJson = req.json
      req.json = async <T>(...limits: Parameters<typeof readJson>) => {
        const body: unknown = await readJson(...limits)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object.', 'validation')
        return body as T
      }
      const response = await route(req)
      writeResponse(rawRes, await compressed(response, rawReq.headers['accept-encoding']), options)
    } catch (err) {
      if (err instanceof HttpError) {
        writeResponse(rawRes, json(err.status, { message: err.message, code: err.code, fields: err.fields }), options)
        return
      }
      // Never echo the error object: it could contain a token or a body.
      console.error('unhandled server error:', err instanceof Error ? err.message : 'unknown')
      writeResponse(rawRes, json(500, { message: 'Something went wrong on our side.', code: 'server_error' }), options)
    }
  })

  return {
    server,
    db,
    auth,
    mailer,
    billingIdle: () => billing.idle(),
    listen(port = config.port) {
      return new Promise((resolve) => server.listen(port, () => resolve((server.address() as { port: number }).port)))
    },
    close() {
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    },
  }
}

/**
 * Just enough structure that every client can revive what it pulls back: a
 * stored `environment: null` would otherwise break the account's audit list
 * on every device the next time it loads.
 */
function isProjectShape(project: Record<string, unknown>): boolean {
  const env = project.environment as Record<string, unknown> | null
  if (typeof project.name !== 'string' || project.name.length > 300) return false
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false
  const result = env.result as Record<string, unknown> | null
  return Array.isArray(env.records) && !!result && typeof result === 'object' && Array.isArray(result.findings)
}

/** The legacy whole-project route is for ledger/source changes, never case facts. */
type Plain = Record<string, unknown>

/**
 * What a payment row says, however the version of the app that saved it wrote
 * it down: dates as days (they were once instants), currency by its code. Its
 * place in the files it came from is not part of what it says. A transaction ID
 * may be learned later, but never changed.
 */
function samePayment(before: Plain, after: Plain | undefined): boolean {
  if (!after) return false
  const day = (value: unknown) => {
    const date = typeof value === 'string' ? storedDay(value) : null
    return date && !Number.isNaN(date.getTime()) ? isoDay(date) : value ?? null
  }
  const said = (record: Plain) => JSON.stringify([
    record.vendor, record.invoiceNumber ?? null, day(record.paymentDate), day(record.invoiceDate), record.invoiceAmount ?? null, record.amountPaid,
    typeof record.currency === 'string' ? canonicalCurrency(record.currency) : null, record.terms ?? null, record.bankAccountLast4 ?? null, record.transactionType ?? null,
    record.quickbooks ?? null, (record.source as Plain | undefined)?.raw ?? null,
  ])
  const learned = (key: string) => before[key] == null || before[key] === after[key]
  const identified = before.externalTransactionId == null && after.externalTransactionId != null
  return said(identified ? { ...before, quickbooks: null } : before) === said(identified ? { ...after, quickbooks: null } : after) && ['externalTransactionId', 'company', 'sourceAccount', 'stableSupplierId'].every(learned)
}

const NEEDS_CHECKING = { requiresRevalidation: true, potentialAmountMinor: null, classification: 'review_needed', class: 'review' } as const

/** The same finding, or the same finding marked to be checked again because its payments changed. That only ever takes away what was decided. */
function sameOrToBeChecked(before: Plain, after: Plain | undefined, claimedElsewhere: boolean): boolean {
  if (!after) return false
  const rows = (finding: Plain) => ((finding.relatedRecords ?? []) as { id: string }[]).map((record) => record.id).sort()
  const rest = ({ relatedRecords: _rows, ...finding }: Plain) => finding
  if (JSON.stringify(rows(before)) !== JSON.stringify(rows(after))) return false
  if (sameJson(rest(before), rest(after))) return true
  const { suppressionReason: was, ...old } = rest(before)
  const { suppressionReason: why, ...now } = rest(after)
  // Marked to be checked: a reason is given, and one it already had stands.
  if (typeof why === 'string' && why.trim() !== '' && (was == null || was === why)) return sameJson({ ...old, ...NEEDS_CHECKING }, now)
  // Raised again from its own payments: no longer replaced, but still to be checked, and never while a newer finding holds its payments.
  return typeof was === 'string' && why == null && !claimedElsewhere && sameJson({ ...old, ...NEEDS_CHECKING }, now)
}

/** Equal whatever order the keys were written in. */
function sameJson(a: unknown, b: unknown): boolean {
  const ordered = (_key: string, value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([x], [y]) => (x < y ? -1 : 1))) : value)
  return JSON.stringify(a, ordered) === JSON.stringify(b, ordered)
}

function caseContentChanged(previous: Plain | null, incoming: Plain): boolean {
  type Found = Plain & { id: string; relatedRecords?: Array<{ id: string }> }
  type CaseEnvironment = { caseStates?: Record<string, Plain>; records?: Array<Plain & { id: string }>; retiredRecords?: Array<Plain & { id: string }>; result?: { findings?: Found[] } }
  const env = (incoming.environment ?? {}) as CaseEnvironment
  if (!previous) return Object.keys(env.caseStates ?? {}).length > 0 || (env.result?.findings ?? []).some((finding) => finding.evidence != null || finding.classification === 'recovery_candidate' || finding.potentialAmountMinor != null)
  const old = (previous.environment ?? {}) as CaseEnvironment
  const oldStates = old.caseStates ?? {}
  const newStates = env.caseStates ?? {}
  const oldFindings = new Map((old.result?.findings ?? []).map((finding) => [finding.id, finding]))
  const newFindings = new Map((env.result?.findings ?? []).map((finding) => [finding.id, finding]))
  for (const id of new Set([...Object.keys(oldStates), ...Object.keys(newStates)])) {
    if (sameJson(oldStates[id], newStates[id])) continue
    if (!oldStates[id] || !newStates[id]) return true
    const checkAgain = { ...oldStates[id], requiresRevalidation: true }
    const unapproved = { ...checkAgain, approvedAt: null }
    if (!sameJson(checkAgain, newStates[id]) && !sameJson(unapproved, newStates[id])) return true
  }
  const protectedIds = new Set([
    ...Object.keys(oldStates),
    ...(old.result?.findings ?? []).filter((finding) => finding.evidence != null).map((finding) => finding.id),
  ])
  const byId = (records: Array<Plain & { id: string }>) => new Map(records.map((record) => [record.id, record]))
  const oldRecords = byId([...(old.retiredRecords ?? []), ...(old.records ?? [])])
  // A payment taken out of the audit is kept aside, so what was decided on it can still be read.
  const newRecords = byId([...(env.retiredRecords ?? []), ...(env.records ?? [])])
  for (const id of protectedIds) {
    const before = oldFindings.get(id)
    const after = newFindings.get(id)
    const rows = new Set((before?.relatedRecords ?? []).map((record) => record.id))
    const claimedElsewhere = (env.result?.findings ?? []).some((other) => other.id !== id && (other.relatedRecords ?? []).filter((record) => rows.has(record.id)).length >= 2)
    if (!before || !sameOrToBeChecked(before, after, claimedElsewhere)) return true
    // Its payments may change only on the way to being checked again.
    if (newStates[id]?.requiresRevalidation === true && after?.requiresRevalidation === true) continue
    for (const record of before.relatedRecords ?? []) {
      const original = oldRecords.get(record.id)
      if (!original || !samePayment(original, newRecords.get(record.id))) return true
    }
  }
  // Two findings standing at once on the same payments, one of them decided, would be two claims on the same money.
  const live = (env.result?.findings ?? []).filter((finding) => !finding.suppressionReason)
  for (const decided of live.filter((finding) => newStates[finding.id]?.decision || finding.evidence != null)) {
    const rows = new Set((decided.relatedRecords ?? []).map((record) => record.id))
    if (live.some((other) => other.id !== decided.id && (other.relatedRecords ?? []).filter((record) => rows.has(record.id)).length >= 2)) return true
  }
  return (env.result?.findings ?? []).some((finding) => !sameJson(finding.evidence ?? null, oldFindings.get(finding.id)?.evidence ?? null))
}

/** Just the case a command changed, for a client that already holds the rest of the audit. */
function changedCase(project: Record<string, unknown>, command: unknown) {
  const findingId = (command as { findingId: string }).findingId
  const env = project.environment as { caseStates?: Record<string, unknown>; result?: { findings?: Array<{ id: string }> } }
  return { updatedAt: project.updatedAt, case: { findingId, state: env.caseStates?.[findingId] ?? null, finding: env.result?.findings?.find((f) => f.id === findingId) ?? null } }
}

/** Historical browser data remains visible, but its approvals are assertions. */
function quarantineLegacyProject(project: Record<string, unknown>): Record<string, unknown> {
  const env = project.environment as Record<string, unknown>
  const states = (env.caseStates ?? {}) as Record<string, Record<string, unknown>>
  return { ...project, environment: { ...env, caseStates: Object.fromEntries(Object.entries(states).map(([id, state]) => [id, {
    ...state,
    ...(state.approvedAt ? { legacyApprovedAt: state.approvedAt } : {}),
    ...(typeof state.recoveredAmount === 'number' ? { legacyRecoveredAmount: state.recoveredAmount } : {}),
    approvedAt: null,
    requiresRevalidation: true,
  }])) } }
}
