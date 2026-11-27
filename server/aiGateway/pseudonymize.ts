/**
 * Stand-ins for commercially sensitive values in a model packet. The model
 * writes `[[SUPPLIER]]` or `[[INVOICE_1]]`; Reclaim puts the real value back
 * locally after the output has passed validation. The mapping never leaves
 * the server and is never logged.
 *
 * This is pseudonymisation, not anonymity: amounts, a rule type and the
 * shape of a case still describe a real business. Never promise more.
 */
export class Pseudonymizer {
  private readonly byValue = new Map<string, string>()
  private readonly byToken = new Map<string, string>()
  private readonly counters = new Map<string, number>()

  /** The token for `value` under `kind`; the same value always gets the same token. `single` kinds get no number. */
  token(kind: string, value: string, single = false): string {
    const key = `${kind}\u0000${value}`
    const existing = this.byValue.get(key)
    if (existing) return existing
    const n = (this.counters.get(kind) ?? 0) + 1
    this.counters.set(kind, n)
    const name = single ? kind : `${kind}_${n}`
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid token kind ${kind}`)
    this.byValue.set(key, name)
    this.byToken.set(name, value)
    return name
  }

  /** `[[NAME]]` for embedding in a packet. */
  ref(kind: string, value: string, single = false): string {
    return `[[${this.token(kind, value, single)}]]`
  }

  get tokens(): string[] {
    return [...this.byToken.keys()]
  }

  /** Real values back in, after validation. Unknown tokens are left as they are (the validator has refused them already). */
  restore(text: string): string {
    return text.replace(/\[\[([A-Z][A-Z0-9_]*)\]\]/g, (whole, name: string) => this.byToken.get(name) ?? whole)
  }
}

const DAY = 86_400_000

/** "12 days after the first payment" instead of a date, when the exact day isn't needed. */
export function relativeDays(from: string, to: string): number | null {
  const a = Date.parse(from)
  const b = Date.parse(to)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DAY) : null
}
