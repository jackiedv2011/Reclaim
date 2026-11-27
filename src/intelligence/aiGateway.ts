/**
 * The only seam through which product intelligence may ever reach a model.
 *
 * Jagan's workstream owns AI execution (AIExecutionService: task registry,
 * per-task packet allowlist, tenant AI policy, provider calls, invocation log).
 * This file defines what the CPO layer would ask of it, and ships the only
 * implementation this workstream is allowed to ship: disabled. There is no
 * provider SDK import anywhere in src/intelligence, and there must not be.
 *
 * Every deterministic answer, insight and figure works with this gateway
 * disabled. Any optional AI output is advisory text that is validated against
 * the deterministic packet it was given (no new numbers, no new citations) and
 * is always shown alongside, never instead of, the deterministic result.
 */
import type { TenantContext } from './contracts.ts'

/** Tasks this layer could request, each with its own minimal, allowlisted packet (J-5). */
export type AiTask = 'summarize_insight' | 'interpret_question'

/** Tenant AI policy as proposed in the audit roadmap; 'off' is the default for every tenant. */
export type TenantAiPolicy = 'off' | 'drafting_only' | 'full'

export interface AiTaskRequest {
  task: AiTask
  /** Pre-built, minimised facts. Never raw ledgers, bank details, emails or credentials. */
  packet: Record<string, string | number | boolean | null | string[]>
  /** Citation IDs the output may reference; anything else is rejected. */
  allowedCitations: string[]
}

export type AiTaskResult =
  | { status: 'ok'; text: string; citations: string[]; model: string; invocationId: string }
  | { status: 'disabled' | 'policy_off' | 'unavailable' | 'rejected'; reason: string }

export interface AiGatewayPort {
  readonly enabled: boolean
  policy(ctx: TenantContext): TenantAiPolicy
  run(ctx: TenantContext, request: AiTaskRequest): Promise<AiTaskResult>
}

export const DISABLED_AI_GATEWAY: AiGatewayPort = {
  enabled: false,
  policy: () => 'off',
  run: async () => ({ status: 'disabled', reason: 'External AI is off. No founder or customer authorization exists for this task.' }),
}

const MONEY_OR_NUMBER = /(?:[$€£]\s?\d|\d[\d,]*(?:\.\d+)?\s?(?:%|percent|usd|eur|gbp|dollars?)\b|\b\d{2,}[\d,]*(?:\.\d+)?\b)/i
const LINK_OR_ADDRESS = /(https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+)/i

/**
 * Validates optional AI text against its packet: it may not introduce a number
 * that is not in the packet, a link or address, or a citation outside the
 * allowlist. Returns null when acceptable, else the reason.
 */
export function rejectUnsupportedAiText(text: string, request: AiTaskRequest, citations: string[]): string | null {
  if (LINK_OR_ADDRESS.test(text)) return 'links_or_addresses_not_allowed'
  if (citations.some((c) => !request.allowedCitations.includes(c))) return 'citation_not_in_packet'
  const packetText = JSON.stringify(request.packet)
  for (const match of text.matchAll(new RegExp(MONEY_OR_NUMBER.source, 'gi'))) {
    const digits = match[0].replace(/[^\d.]/g, '').replace(/\.0+$/, '')
    if (digits && !packetText.includes(digits)) return 'number_not_in_packet'
  }
  return null
}
