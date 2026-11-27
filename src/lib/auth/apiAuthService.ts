import type { AuthError, AuthOutcome, AuthUser } from '@/lib/auth/types'
import type { Entitlements, Plan } from '@/lib/plans'
import type { OnboardingProfile } from '../../../server/onboarding.ts'

/**
 * The browser side of the account system. Every call goes to the Reclaim
 * server, which owns the users table, the password hashes and the sessions.
 * The session itself is an HttpOnly cookie the browser carries automatically;
 * nothing about it is readable from JavaScript.
 */
export interface Providers {
  google: boolean
  ai: boolean
  emailDelivery: 'dev' | 'resend' | 'gmail'
  requireEmailVerification: boolean
  devMailbox: boolean
}

export interface ServerUser {
  id: string
  firstName: string
  lastName: string
  name: string
  email: string
  company: string
  createdAt: number
  emailVerified: boolean
  termsAcceptedAt: number | null
  termsVersion: string | null
  methods: Array<'password' | 'google'>
  plan: Plan
  onboardingSeenAt: number | null
  onboardingProfile: OnboardingProfile | null
  tourSeenAt?: number | null
}

export type SignUpResult = { ok: true; requiresVerification: true; email: string } | { ok: true; requiresVerification: false; user: AuthUser } | AuthError
export type LogInResult = AuthOutcome | (AuthError & { code: 'email_unverified' })

let fetchImpl: typeof fetch = (...args) => fetch(...args)
/** Tests point this at a live server; the app uses same-origin `/api`. */
export function setFetch(impl: typeof fetch): void {
  fetchImpl = impl
}

export function toAuthUser(user: ServerUser): AuthUser {
  return { ...user, isGuest: false }
}

/** Same-origin JSON call through the current fetch (tests swap it via setFetch). */
export async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers)
  if (init.json !== undefined) headers.set('Content-Type', 'application/json')
  const res = await fetchImpl(path, { ...init, headers, credentials: 'same-origin', body: init.json !== undefined ? JSON.stringify(init.json) : init.body })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { status: res.status, body: body as T }
}

type Failure = { message?: string; code?: string; fields?: Record<string, string> }

const UNREACHABLE: AuthError = { ok: false, code: 'network', message: 'Couldn’t reach Reclaim. Check your connection and try again.' }
const TROUBLE: AuthError = { ok: false, code: 'server_error', message: 'Reclaim is having trouble right now. Try again in a minute.' }

/** True for a failure that says nothing about what was typed: the same request may work in a minute. */
export const isTemporary = (result: AuthError): boolean => result.code === 'network' || result.code === 'server_error'

/**
 * A call that never throws. Only an answer Reclaim itself wrote is shown as
 * the reason: a proxy's error page, or a network's own sign-in page, is not a
 * wrong password.
 */
async function ask<T>(path: string, json: unknown, okStatus = 200): Promise<{ ok: true; body: T } | AuthError> {
  let answer: { status: number; body: (T & Failure) | null }
  try {
    answer = await call<(T & Failure) | null>(path, { method: 'POST', json })
  } catch {
    return UNREACHABLE
  }
  const { status, body } = answer
  if (body === null || typeof body !== 'object') return TROUBLE
  if (status === okStatus) return { ok: true, body }
  if (typeof body.message !== 'string' || !body.message) return TROUBLE
  return { ok: false, message: body.message, fields: body.fields, code: body.code }
}

/** The signed-in account in an answer, or a failure. */
async function askForUser(path: string, json: unknown): Promise<AuthOutcome> {
  const result = await ask<{ user?: ServerUser }>(path, json)
  if (!result.ok) return result
  return result.body.user ? { ok: true, user: toAuthUser(result.body.user) } : TROUBLE
}

/** For account updates whose caller carries on without an answer. */
async function userOrNull(path: string, json?: unknown): Promise<AuthUser | null> {
  const result = await askForUser(path, json)
  return result.ok ? result.user : null
}

export async function fetchProviders(): Promise<Providers> {
  try {
    const { status, body } = await call<Providers>('/api/auth/providers')
    if (status === 200) return body
  } catch {
    // server unreachable — fall through
  }
  return { google: false, ai: false, emailDelivery: 'dev', requireEmailVerification: true, devMailbox: false }
}

export async function getSession(): Promise<AuthUser | null> {
  try {
    const { status, body } = await call<{ user: ServerUser }>('/api/auth/me')
    return status === 200 ? toAuthUser(body.user) : null
  } catch {
    return null
  }
}

export async function signUp(input: {
  firstName: string
  lastName: string
  email: string
  company: string
  password: string
  confirmPassword: string
  acceptedTerms: boolean
  termsVersion: string
}): Promise<SignUpResult> {
  const result = await ask<{ requiresVerification: boolean; email?: string; user?: ServerUser }>('/api/auth/signup', input, 201)
  if (!result.ok) return result
  const { requiresVerification, email, user } = result.body
  if (requiresVerification) return { ok: true, requiresVerification: true, email: email ?? input.email }
  return user ? { ok: true, requiresVerification: false, user: toAuthUser(user) } : TROUBLE
}

export async function verifyEmail(token: string): Promise<AuthOutcome> {
  return askForUser('/api/auth/verify-email', { token })
}

/** Throws with a message for the reader when the request didn't get through. */
export async function resendVerification(email: string): Promise<void> {
  await askOrThrow('/api/auth/resend-verification', { email })
}

async function askOrThrow(path: string, json: unknown): Promise<void> {
  const result = await ask(path, json)
  if (!result.ok) throw new Error(result.message)
}

/** What to show for an error thrown by one of the calls here. */
export const messageOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : TROUBLE.message)

export async function logIn(input: { email: string; password: string; rememberMe: boolean }): Promise<LogInResult> {
  return askForUser('/api/auth/login', input)
}

export async function logOut(): Promise<void> {
  try {
    await call('/api/auth/logout', { method: 'POST' })
  } catch {
    // The local session is cleared regardless; the server session expires on its own.
  }
}

/** Throws with a message for the reader when the request didn't get through. */
export async function requestPasswordReset(email: string): Promise<void> {
  await askOrThrow('/api/auth/forgot-password', { email })
}

export async function resetPassword(token: string, password: string, confirmPassword: string): Promise<AuthOutcome> {
  return askForUser('/api/auth/reset-password', { token, password, confirmPassword })
}

/** Development only: the emails the server would have sent to this address. */
export async function devMailbox(email: string): Promise<Array<{ subject: string; link: string | null; body: string }>> {
  try {
    const { status, body } = await call<{ messages: Array<{ subject: string; link: string | null; body: string }> } | null>(`/api/dev/mailbox?to=${encodeURIComponent(email)}`)
    return status === 200 ? (body?.messages ?? []) : []
  } catch {
    return []
  }
}

/** What this account may do right now — the server's answer, never a client-side guess. */
export async function fetchEntitlements(): Promise<Entitlements | null> {
  try {
    const { status, body } = await call<Entitlements>('/api/account/entitlements')
    return status === 200 ? body : null
  } catch {
    return null
  }
}

export async function markOnboardingSeen(): Promise<AuthUser | null> {
  return userOrNull('/api/account/onboarding-seen')
}

/** Records that the dashboard tour was finished or skipped, so it never opens again for this account. */
export async function markTourSeen(): Promise<AuthUser | null> {
  return userOrNull('/api/account/tour-seen')
}

/** Saves onboarding's answers on the account; also marks onboarding as done. */
export async function saveOnboarding(profile: OnboardingProfile): Promise<AuthUser | null> {
  return userOrNull('/api/account/onboarding', profile)
}

/** Asks the server to upgrade. Today the server answers "coming soon"; the message is shown as-is. */
export async function requestUpgrade(): Promise<{ ok: boolean; message: string }> {
  try {
    const { status, body } = await call<{ message?: string } | null>('/api/account/upgrade', { method: 'POST' })
    return { ok: status === 200, message: body?.message ?? 'Upgrading is coming soon.' }
  } catch {
    return { ok: false, message: UNREACHABLE.message }
  }
}

/** Development only: switch the signed-in account's plan to exercise the paid-plan surface. */
export async function setDevPlan(plan: Plan): Promise<AuthUser | null> {
  return userOrNull('/api/dev/plan', { plan })
}

/** Same-origin download of everything the account holds, as JSON (the server sets the filename). */
export const ACCOUNT_EXPORT_URL = '/api/account/export'

/** Deletes the account and all its data. The server checks the typed email; the session ends with it. */
export async function deleteAccount(confirmEmail: string): Promise<{ ok: true } | AuthError> {
  const result = await ask('/api/account/delete', { confirmEmail })
  return result.ok ? { ok: true } : result
}

/** Records acceptance of the Terms and Privacy Policy version shown to the person. */
export async function acceptTerms(termsVersion: string): Promise<AuthOutcome> {
  return askForUser('/api/account/accept-terms', { termsVersion })
}
