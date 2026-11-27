import { createHash } from 'node:crypto'
import { openSecret, sealSecret } from './crypto.ts'

type Keys = { current: Buffer; previous: Buffer | null } | null

/**
 * Sensitive JSON at rest (proposal payloads, inbound replies, documents):
 * sealed under DATA_KEY with the owning tenant and row bound in, the same
 * scheme as stored audits (projectStore.ts). Without a key (development and
 * tests only; production refuses to start without one) it is stored as JSON.
 */
export interface Sealer {
  seal(context: string, value: unknown): string
  open<T>(context: string, stored: string): T
  readonly encrypted: boolean
}

export function createSealer(keys: Keys): Sealer {
  return {
    encrypted: keys !== null,
    seal(context, value) {
      const json = JSON.stringify(value)
      return keys ? sealSecret(json, keys.current, context) : json
    },
    open<T>(context: string, stored: string): T {
      if (!stored.startsWith('v1.')) return JSON.parse(stored) as T
      if (!keys) throw new Error('This record is encrypted and DATA_KEY is not set.')
      try {
        return JSON.parse(openSecret(stored, keys.current, context)) as T
      } catch (err) {
        if (keys.previous) return JSON.parse(openSecret(stored, keys.previous, context)) as T
        throw err
      }
    },
  }
}

/** Key-order-independent JSON, so equal values always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
export const hashJson = (value: unknown) => sha256(canonicalJson(value))
