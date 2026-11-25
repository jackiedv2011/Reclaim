import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setFetch } from '@/lib/auth/apiAuthService'
import { AuthProvider } from '@/lib/auth/AuthContext'
import { redirectTo } from '@/pages/authRedirect'
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage'
import { LoginPage } from '@/pages/LoginPage'
import { ResetPasswordPage } from '@/pages/ResetPasswordPage'
import { SignupPage } from '@/pages/SignupPage'
import { VerifyEmailPage } from '@/pages/VerifyEmailPage'

vi.mock('@/pages/authRedirect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/pages/authRedirect')>()),
  redirectTo: vi.fn(),
}))

type Answer = () => Promise<Response>
const json = (status: number, body: unknown): Answer => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const badGateway: Answer = async () => new Response('<html><h1>502 Bad Gateway</h1></html>', { status: 502, headers: { 'Content-Type': 'text/html' } })
const captivePortal: Answer = async () => new Response('<html>Sign in to Wi-Fi</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
const offline: Answer = async () => {
  throw new TypeError('Failed to fetch')
}
const user = { id: 'u1', firstName: 'Pat', lastName: 'Lee', name: 'Pat Lee', email: 'pat@example.com', company: 'Lee Co', createdAt: 1, emailVerified: true, termsAcceptedAt: 1, termsVersion: 't', methods: ['password'], plan: 'free', onboardingSeenAt: 1, onboardingProfile: null }

/** Answers one path; everything else says "not logged in". */
let answers: Record<string, Answer> = {}

beforeEach(() => {
  answers = {}
  setFetch((async (input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    return (answers[path] ?? json(401, { message: 'Not logged in.', code: 'unauthenticated' }))()
  }) as typeof fetch)
  vi.mocked(redirectTo).mockClear()
})
afterEach(() => {
  // An unhandled rejection anywhere here also fails the run (vitest reports it).
  cleanup()
  setFetch((...args) => fetch(...args))
  window.localStorage.clear()
  window.sessionStorage.clear()
})

function mount(page: React.ReactElement, path = '/login') {
  window.history.pushState({}, '', path)
  return render(<AuthProvider>{page}</AuthProvider>)
}

const TROUBLE = /Reclaim is having trouble/
const UNREACHABLE = /Couldn’t reach Reclaim/

describe('logging in', () => {
  async function tryLogin(answer: Answer) {
    answers['/api/auth/login'] = answer
    mount(<LoginPage />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pat@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-battery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    const alert = await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled()
    return alert
  }

  it('a proxy error page is not called a wrong password', async () => {
    const alert = await tryLogin(badGateway)
    expect(alert).toHaveTextContent(TROUBLE)
    expect(alert).not.toHaveTextContent(/match/)
  })

  it('neither is a sign-in page some network put in the way', async () => {
    expect(await tryLogin(captivePortal)).toHaveTextContent(TROUBLE)
  })

  it('offline says so, and the button works again', async () => {
    expect(await tryLogin(offline)).toHaveTextContent(UNREACHABLE)
  })

  it('a wrong password is still called one', async () => {
    expect(await tryLogin(json(401, { message: "That email and password don't match.", code: 'invalid_credentials' }))).toHaveTextContent(/don't match/)
  })

  it('resending the confirmation link only claims success when it was asked for', async () => {
    await tryLogin(json(403, { message: 'Confirm your email address first.', code: 'email_unverified' }))
    answers['/api/auth/resend-verification'] = offline
    fireEvent.click(screen.getByRole('button', { name: /Send the confirmation link again/ }))
    expect(await screen.findByText(UNREACHABLE)).toBeInTheDocument()
    expect(screen.queryByText(/on its way/)).not.toBeInTheDocument()
    answers['/api/auth/resend-verification'] = json(200, { ok: true })
    fireEvent.click(screen.getByRole('button', { name: /Send the confirmation link again/ }))
    expect(await screen.findByText(/on its way/)).toBeInTheDocument()
  })
})

describe('confirming an email', () => {
  it('offline ends with a message and a retry, which works', async () => {
    answers['/api/auth/verify-email'] = offline
    mount(<VerifyEmailPage />, '/verify-email?token=tok-1')
    expect(await screen.findByText(UNREACHABLE)).toBeInTheDocument()
    answers['/api/auth/verify-email'] = json(200, { user })
    answers['/api/projects'] = json(200, { projects: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(redirectTo).toHaveBeenCalledWith('/audit'))
  })

  it('a used link says why, and offers a new one rather than a retry', async () => {
    answers['/api/auth/verify-email'] = json(400, { message: 'This link has already been used. Request a new one.', code: 'token_used' })
    mount(<VerifyEmailPage />, '/verify-email?token=tok-2')
    expect(await screen.findByText(/already been used/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    answers['/api/auth/resend-verification'] = badGateway
    fireEvent.click(screen.getByRole('button', { name: 'Send a new link' }))
    expect(await screen.findByText(TROUBLE)).toBeInTheDocument()
  })
})

describe('the other forms', () => {
  it('forgot password', async () => {
    answers['/api/auth/forgot-password'] = offline
    mount(<ForgotPasswordPage />, '/forgot-password')
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pat@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByText(UNREACHABLE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeEnabled()
    answers['/api/auth/forgot-password'] = json(200, { ok: true })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByText(/reset link is on its way/)).toBeInTheDocument()
  })

  it('reset password', async () => {
    answers['/api/auth/reset-password'] = badGateway
    mount(<ResetPasswordPage />, '/reset-password?token=t')
    for (const label of ['New password', 'Confirm new password']) fireEvent.change(screen.getByLabelText(label), { target: { value: 'correct-horse-battery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }))
    expect(await screen.findByText(TROUBLE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update password' })).toBeEnabled()
  })

  it('sign up', async () => {
    answers['/api/auth/signup'] = offline
    mount(<SignupPage />, '/signup')
    for (const [label, value] of [['First name', 'Pat'], ['Last name', 'Lee'], ['Work email', 'pat@example.com'], ['Company name', 'Lee Co'], ['Password', 'correct-horse-battery'], ['Confirm password', 'correct-horse-battery']]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } })
    }
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText(UNREACHABLE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled()
  })
})
