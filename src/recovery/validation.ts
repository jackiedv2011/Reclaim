/**
 * Rules the screens and the server both check. One copy, so a value the screen
 * accepts is never refused after the person has moved on.
 */

/** The same pattern the Gmail send path uses, so an approved address can always be sent to. */
const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]{2,}$/
const EMAIL_MAX = 254

/** One plain email address. */
export function validEmail(value: string): boolean {
  const email = value.trim()
  return email.length <= EMAIL_MAX && EMAIL.test(email)
}

/** Text lengths the server stores; the fields stop at the same point. */
export const LIMITS = { subject: 300, text: 5000, reference: 1000, identifier: 300 } as const

/** A dollar amount with no fraction of a cent. */
export const isWholeCents = (value: number) => Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) <= 0.000001
