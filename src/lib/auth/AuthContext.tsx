import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as api from '@/lib/auth/apiAuthService'
import * as guest from '@/lib/auth/localAuthService'
import type { AuthError, AuthOutcome, AuthUser } from '@/lib/auth/types'
import { TERMS_VERSION } from '@/legal/terms'
import { setStorageScope } from '@/lib/storageScope'
import { forgetScope, hasUnsavedWork, loadAccountProjects, loadOverflow } from '@/ledger/projects'
import { projectSync, ServerAnswer } from '@/ledger/projectSync'
import { entitlementsFor, type Entitlements, type Plan } from '@/lib/plans'
import { readProfile, type OnboardingProfile } from '../../../server/onboarding.ts'

// A guest lives for the tab, so its onboarding does too.
const GUEST_SEEN_KEY = 'reclaim.tour.seen'
const GUEST_PROFILE_KEY = 'reclaim.onboarding.v1'
const GUEST_TOUR_KEY = 'reclaim.dashboard-tour.seen'

function withGuestOnboarding(user: AuthUser): AuthUser {
  try {
    const seen = window.sessionStorage.getItem(GUEST_SEEN_KEY) === '1'
    const profile = readProfile(window.sessionStorage.getItem(GUEST_PROFILE_KEY))
    const tourSeen = window.sessionStorage.getItem(GUEST_TOUR_KEY) === '1'
    const withTour = tourSeen ? { ...user, tourSeenAt: user.tourSeenAt ?? Date.now() } : user
    return seen ? { ...withTour, onboardingSeenAt: user.onboardingSeenAt ?? Date.now(), onboardingProfile: profile } : withTour
  } catch {
    return user
  }
}

export type AuthStatus = 'loading' | 'ready'

/** What the last attempt to load the account's audits did not bring. */
export interface AuditsProblem {
  /** The account could not be read at all: what is on screen is only what this browser holds. */
  unreachable: boolean
  message: string
}

interface AuthContextValue {
  user: AuthUser | null
  /** `loading` until the server has said whether there is a session. Gates wait on it. */
  status: AuthStatus
  isGuest: boolean
  providers: api.Providers | null
  /** The server's statement of what this account may do. Guests get Free limits locally. */
  entitlements: Entitlements | null
  refreshEntitlements: () => Promise<Entitlements | null>
  /**
   * Re-read the account and its entitlements from the server — after a plan
   * change, and on its own when the tab regains focus, so a plan that ended
   * (a cancelled period, a failed payment) locks without a reload.
   */
  refreshAccount: () => Promise<void>
  markOnboardingSeen: () => Promise<void>
  /** The dashboard tour was finished or skipped: on the account (once, everywhere), or in the tab for a guest. */
  markTourSeen: () => Promise<void>
  /** Stores onboarding's answers (on the account, or in the tab for a guest) and marks it done. */
  saveOnboarding: (profile: OnboardingProfile) => Promise<void>
  /** Development only: flip the account's plan. */
  setDevPlan: (plan: Plan) => Promise<void>
  signUp: (input: Omit<Parameters<typeof api.signUp>[0], 'termsVersion'>) => Promise<api.SignUpResult>
  verifyEmail: (token: string) => Promise<AuthOutcome>
  resendVerification: (email: string) => Promise<void>
  logIn: (input: { email: string; password: string; rememberMe: boolean }) => Promise<api.LogInResult>
  continueAsGuest: () => void
  logOut: () => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
  resetPassword: (token: string, newPassword: string, confirmPassword: string) => Promise<AuthOutcome>
  /** Downloads everything the account holds, after any unsaved changes reach the server. */
  exportAccountData: () => Promise<void>
  /** Set when the account's audits could not all be loaded. An empty list with this set is not an empty account. */
  auditsProblem: AuditsProblem | null
  reloadAudits: () => Promise<void>
  /** Deletes the account on the server, then everything cached for it in this browser. */
  deleteAccount: (confirmEmail: string) => Promise<{ ok: true } | AuthError>
  /** Accepts the current Terms and Privacy Policy (shown when they changed since the account accepted). */
  acceptTerms: () => Promise<AuthOutcome>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * Point the local cache at this account and fill it from the server. Runs
 * before `user` is published so the workspace never renders another
 * account's (or an empty) cache.
 */
async function enterAccount(user: AuthUser): Promise<AuditsProblem | null> {
  setStorageScope(user.id)
  await loadOverflow()
  // A guest's audits in this browser are offered to the account (legacyMigration.ts); the large ones are in the database.
  await loadOverflow('reclaim.u.guest.')
  projectSync.restore()
  const problem = await loadAudits()
  projectSync.retry()
  return problem
}

async function loadAudits(): Promise<AuditsProblem | null> {
  try {
    const { failed } = await loadAccountProjects()
    if (!failed.length) return null
    return { unreachable: false, message: failed.length === 1 ? 'One of your audits couldn’t be opened. The others are here, and nothing was deleted.' : `${failed.length} of your audits couldn’t be opened. The others are here, and nothing was deleted.` }
  } catch (err) {
    console.warn('Reclaim: could not load audits from the server —', err instanceof Error ? err.message : err)
    return {
      unreachable: true,
      message: err instanceof ServerAnswer ? 'Your audits couldn’t be loaded: the server didn’t answer as expected. They are still in your account.' : 'Your audits couldn’t be loaded. Check your connection; they are still in your account.',
    }
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [providers, setProviders] = useState<api.Providers | null>(null)
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null)
  const [auditsProblem, setAuditsProblem] = useState<AuditsProblem | null>(null)
  const mounted = useRef(true)

  const refreshEntitlements = useCallback(async () => {
    const next = await api.fetchEntitlements()
    if (mounted.current && next) setEntitlements(next)
    return next
  }, [])

  const signedInId = user && !user.isGuest ? user.id : null
  const refreshAccount = useCallback(async () => {
    const [next, ent] = await Promise.all([api.getSession(), api.fetchEntitlements()])
    if (!mounted.current || !next || next.id !== signedInId) return
    // Same object when nothing changed, so the workspace doesn't re-render for nothing.
    setUser((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    if (ent) setEntitlements((prev) => (prev && JSON.stringify(prev) === JSON.stringify(ent) ? prev : ent))
  }, [signedInId])

  useEffect(() => {
    if (!signedInId) return
    const onFocus = () => {
      if (document.visibilityState !== 'hidden') void refreshAccount()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    const timer = window.setInterval(onFocus, 5 * 60 * 1000)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      window.clearInterval(timer)
    }
  }, [signedInId, refreshAccount])

  useEffect(() => {
    mounted.current = true
    void api.fetchProviders().then((p) => mounted.current && setProviders(p))
    ;(async () => {
      const guestUser = guest.getSession()
      // A guest tab can come back signed in (Google sends it here with a session): the account wins.
      const serverUser = await api.getSession()
      if (guestUser?.isGuest && !serverUser) {
        setStorageScope('guest')
        await loadOverflow()
        if (mounted.current) {
          setEntitlements(entitlementsFor('free', 0))
          setUser(withGuestOnboarding(guestUser))
        }
      } else {
        if (serverUser) {
          guest.logOut()
          const problem = await enterAccount(serverUser)
          if (mounted.current) setAuditsProblem(problem)
          const ent = await api.fetchEntitlements()
          if (mounted.current) setEntitlements(ent)
        }
        if (mounted.current) setUser(serverUser)
      }
      if (mounted.current) setStatus('ready')
    })()
    return () => {
      mounted.current = false
    }
  }, [])

  const adopt = useCallback(async (next: AuthUser) => {
    guest.logOut()
    setAuditsProblem(await enterAccount(next))
    const ent = await api.fetchEntitlements()
    setEntitlements(ent)
    setUser(next)
  }, [])

  const reloadAudits = useCallback(async () => {
    if (!signedInId) return
    const problem = await loadAudits()
    projectSync.retry()
    if (mounted.current) setAuditsProblem(problem)
    window.dispatchEvent(new CustomEvent('reclaim:projects-changed', { detail: { id: null } }))
  }, [signedInId])

  const unreachable = auditsProblem?.unreachable ?? false
  useEffect(() => {
    if (!signedInId || !unreachable) return
    const onOnline = () => void reloadAudits()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [signedInId, unreachable, reloadAudits])

  const markOnboardingSeen = useCallback(async () => {
    if (user?.isGuest) {
      window.sessionStorage.setItem(GUEST_SEEN_KEY, '1')
      setUser({ ...user, onboardingSeenAt: Date.now() })
      return
    }
    const next = await api.markOnboardingSeen()
    if (next) setUser(next)
  }, [user])

  const markTourSeen = useCallback(async () => {
    if (!user || user.tourSeenAt) return
    // Shown as seen at once, so the tour never reopens while the request is in flight.
    setUser({ ...user, tourSeenAt: Date.now() })
    if (user.isGuest) {
      try {
        window.sessionStorage.setItem(GUEST_TOUR_KEY, '1')
      } catch {
        /* storage refused: it still holds for this tab */
      }
      return
    }
    const next = await api.markTourSeen()
    if (next && mounted.current) setUser(next)
  }, [user])

  const saveOnboarding = useCallback(
    async (profile: OnboardingProfile) => {
      if (!user) return
      if (user.isGuest) {
        try {
          window.sessionStorage.setItem(GUEST_SEEN_KEY, '1')
          window.sessionStorage.setItem(GUEST_PROFILE_KEY, JSON.stringify(profile))
        } catch {
          /* storage refused: the answers still hold for this render */
        }
        setUser({ ...user, onboardingSeenAt: Date.now(), onboardingProfile: profile })
        return
      }
      const next = await api.saveOnboarding(profile)
      // If the save failed, onboarding still ends: nobody is held on step 8 by a network error.
      setUser(next ?? { ...user, onboardingSeenAt: Date.now(), onboardingProfile: profile })
    },
    [user]
  )

  const setDevPlan = useCallback(
    async (plan: Plan) => {
      const next = await api.setDevPlan(plan)
      if (next) {
        setUser(next)
        await refreshEntitlements()
      }
    },
    [refreshEntitlements]
  )

  const signUp = useCallback<AuthContextValue['signUp']>(
    async (input) => {
      const result = await api.signUp({ ...input, termsVersion: TERMS_VERSION })
      if (result.ok && !result.requiresVerification) await adopt(result.user)
      return result
    },
    [adopt]
  )

  const verifyEmail = useCallback<AuthContextValue['verifyEmail']>(
    async (token) => {
      const result = await api.verifyEmail(token)
      if (result.ok) await adopt(result.user)
      return result
    },
    [adopt]
  )

  const logIn = useCallback<AuthContextValue['logIn']>(
    async (input) => {
      const result = await api.logIn(input)
      if (result.ok) await adopt(result.user)
      return result
    },
    [adopt]
  )

  const continueAsGuest = useCallback(() => {
    setStorageScope('guest')
    setEntitlements(entitlementsFor('free', 0))
    const g = guest.continueAsGuest()
    setUser(withGuestOnboarding(g))
  }, [])

  const logOut = useCallback(async () => {
    const leaving = user
    if (leaving && !leaving.isGuest) {
      await projectSync.flush()
      await api.logOut()
      // Nothing that has not reached the server is ever cleared: it stays for
      // this account's next log-in, which sends it.
      if (!hasUnsavedWork()) forgetScope(leaving.id)
    } else if (leaving?.isGuest) {
      forgetScope('guest')
    }
    guest.logOut()
    projectSync.reset(Boolean(leaving && !leaving.isGuest))
    setStorageScope(null)
    setAuditsProblem(null)
    setEntitlements(null)
    setUser(null)
  }, [user])

  const resetPassword = useCallback<AuthContextValue['resetPassword']>(
    async (token, password, confirmPassword) => {
      const result = await api.resetPassword(token, password, confirmPassword)
      if (result.ok) await adopt(result.user)
      return result
    },
    [adopt]
  )

  const exportAccountData = useCallback(async () => {
    await projectSync.flush()
    window.location.assign(api.ACCOUNT_EXPORT_URL)
  }, [])

  const deleteAccount = useCallback<AuthContextValue['deleteAccount']>(
    async (confirmEmail) => {
      const leaving = user
      if (!leaving || leaving.isGuest) return { ok: false, message: 'Only a signed-in account can be deleted.' }
      // Nothing is written back while this is asked. Only once the account is
      // gone are its unsent saves dropped: a refusal leaves everything as it was.
      projectSync.pause()
      let deleted = false
      try {
        const result = await api.deleteAccount(confirmEmail)
        if (!result.ok) return result
        deleted = true
      } finally {
        if (!deleted) projectSync.resume()
      }
      projectSync.reset()
      forgetScope(leaving.id)
      guest.logOut()
      setStorageScope(null)
      setAuditsProblem(null)
      setEntitlements(null)
      setUser(null)
      return { ok: true }
    },
    [user]
  )

  const acceptTerms = useCallback<AuthContextValue['acceptTerms']>(async () => {
    const result = await api.acceptTerms(TERMS_VERSION)
    if (result.ok) setUser(result.user)
    return result
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      isGuest: user?.isGuest ?? false,
      providers,
      entitlements,
      refreshEntitlements,
      refreshAccount,
      markOnboardingSeen,
      markTourSeen,
      saveOnboarding,
      setDevPlan,
      signUp,
      verifyEmail,
      resendVerification: api.resendVerification,
      logIn,
      continueAsGuest,
      logOut,
      requestPasswordReset: api.requestPasswordReset,
      resetPassword,
      exportAccountData,
      auditsProblem,
      reloadAudits,
      deleteAccount,
      acceptTerms,
    }),
    [user, status, providers, entitlements, refreshEntitlements, refreshAccount, markOnboardingSeen, markTourSeen, saveOnboarding, setDevPlan, signUp, verifyEmail, logIn, continueAsGuest, logOut, resetPassword, exportAccountData, auditsProblem, reloadAudits, deleteAccount, acceptTerms]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

/** For surfaces that also render outside the provider (tests, isolated mounts). */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext)
}

/**
 * What the current session may do. Inside the app there is always a
 * provider; outside one (isolated component tests) nothing is gated, so the
 * workspace renders in full.
 */
export function useEntitlements(): Entitlements {
  const ctx = useContext(AuthContext)
  if (!ctx) return entitlementsFor('growth', 0)
  return ctx.entitlements ?? entitlementsFor('free', 0)
}
