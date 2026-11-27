/**
 * AI execution: the only route from Reclaim's data to a model.
 *
 * For every invocation, in this order: the tenant's policy, the actor's
 * permission, the input schema, a packet built by the task from the server's
 * own copy of the case, a consent that covers exactly that, budgets, the
 * provider call (bounded time and one retry), output schema and validators,
 * then local restoration of real names. Every invocation is recorded in the
 * ledger; nothing it sent or received is.
 *
 * Every failure falls back to the task's deterministic answer where it has one.
 */
import { HttpError } from '../http.ts'
import { requirePermission, type TenantContext } from '../tenant.ts'
import { hashJson, sha256 } from '../sealedJson.ts'
import { AiPolicyStore, AUTOMATIC_EXTERNAL_AI_ENABLED, type ConsentRow } from './policy.ts'
import { InvocationLedger } from './ledger.ts'
import { AiTransientError, type AiProvider } from './providers.ts'
import type { AnyAiTask, BuiltPacket, TaskScope } from './types.ts'
import type { DatabaseSync } from 'node:sqlite'

export interface AiLimits {
  perDay: number
  tokensPerDay: number
  concurrent: number
  timeoutMs: number
  /** Retries on a transient provider error. Bounded: never more than 2. */
  retries: number
}
export const DEFAULT_LIMITS: AiLimits = { perDay: 60, tokensPerDay: 400_000, concurrent: 2, timeoutMs: 60_000, retries: 1 }

export type TaskOutcome<R> =
  | { source: 'ai'; result: R; invocationId: string }
  | { source: 'deterministic'; result: R | null; reason: string; code: string; invocationId?: string }

export interface PreviewResult {
  task: string; purpose: string; fields: readonly string[]; fieldSetHash: string; packetHash: string
  /** Exactly what would be sent, pseudonymised. Shown to the person before they consent. */
  packet: unknown
  provider: string | null; model: string | null
  policy: { mode: string; version: number }
  automaticProcessing: 'disabled'
}

const DAY = 86_400_000

export class AiExecutionService {
  readonly policies: AiPolicyStore
  readonly ledger: InvocationLedger
  private readonly tasks = new Map<string, AnyAiTask>()
  private readonly providers: AiProvider[]
  private readonly limits: AiLimits
  private readonly now: () => number
  private readonly getProject: (tenantId: string, projectId: string) => Record<string, unknown> | null

  constructor(deps: { db: DatabaseSync; providers: Array<AiProvider | null>; getProject: (tenantId: string, projectId: string) => Record<string, unknown> | null; limits?: Partial<AiLimits>; now?: () => number }) {
    this.now = deps.now ?? Date.now
    this.policies = new AiPolicyStore(deps.db, this.now)
    this.ledger = new InvocationLedger(deps.db)
    this.ledger.recoverInterrupted(this.now())
    this.providers = deps.providers.filter((p): p is AiProvider => p !== null)
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits, retries: Math.min(2, deps.limits?.retries ?? DEFAULT_LIMITS.retries) }
    this.getProject = deps.getProject
  }

  register(task: AnyAiTask): this {
    if (this.tasks.has(task.id)) throw new Error(`AI task ${task.id} registered twice`)
    this.tasks.set(task.id, task)
    return this
  }

  task(id: string): AnyAiTask {
    const task = this.tasks.get(id)
    if (!task) throw new HttpError(404, 'No such AI task.', 'ai_task_unknown')
    return task
  }

  registry() {
    return [...this.tasks.values()].map((t) => ({ id: t.id, version: t.version, purpose: t.purpose, fields: t.fields, fieldSetHash: this.fieldSetHash(t), permission: t.permission, provider: this.providerFor(t.id)?.name ?? null, model: this.providerFor(t.id)?.model ?? null }))
  }

  providerFor(taskId: string): AiProvider | null {
    return this.providers.find((p) => p.tasks === null || p.tasks.has(taskId)) ?? null
  }

  fieldSetHash(task: AnyAiTask): string {
    return sha256(JSON.stringify([task.id, task.version, task.purpose, [...task.fields].sort()]))
  }

  private scope(tenant: TenantContext, projectId: string, findingId: string | null): TaskScope {
    return { tenant, projectId, findingId, project: this.getProject(tenant.tenantId, projectId) }
  }

  private build(task: AnyAiTask, scope: TaskScope, rawInput: unknown): { input: unknown; built: BuiltPacket<unknown>; packetHash: string } {
    const parsed = task.inputSchema.safeParse(rawInput)
    if (!parsed.success) throw new HttpError(400, 'The task input is malformed.', 'validation')
    const result = task.build(scope, parsed.data)
    if (!result.ok) throw new HttpError(result.status ?? 403, result.reason, result.code)
    const size = JSON.stringify(result.built.packet).length
    if (size > task.maxPacketChars) throw new HttpError(413, 'This case has too much data for the task. Use the deterministic summary instead.', 'ai_packet_too_large')
    return { input: parsed.data, built: result.built, packetHash: hashJson({ task: task.id, version: task.version, packet: result.built.packet }) }
  }

  /** What would be sent, for a person to read before consenting. Nothing is sent and nothing is recorded. */
  preview(tenant: TenantContext, taskId: string, projectId: string, findingId: string | null, input: unknown): PreviewResult {
    const task = this.task(taskId)
    requirePermission(tenant, task.permission)
    const { built, packetHash } = this.build(task, this.scope(tenant, projectId, findingId), input)
    const provider = this.providerFor(task.id)
    const policy = this.policies.get(tenant.tenantId)
    return { task: task.id, purpose: task.purpose, fields: task.fields, fieldSetHash: this.fieldSetHash(task), packetHash, packet: built.packet, provider: provider?.name ?? null, model: provider?.model ?? null, policy: { mode: policy.mode, version: policy.version }, automaticProcessing: 'disabled' }
  }

  consent(tenant: TenantContext, taskId: string, scope: { scope: 'packet' | 'field_set'; packetHash?: string; projectId?: string | null; findingId?: string | null }): ConsentRow {
    requirePermission(tenant, 'ai.manage')
    const task = this.task(taskId)
    const provider = this.providerFor(task.id)
    if (!provider) throw new HttpError(503, 'No AI provider is configured for this task.', 'ai_unavailable')
    if (!(task.consentScopes ?? ['packet', 'field_set']).includes(scope.scope)) throw new HttpError(400, 'This task needs a one-time consent for the exact data it will send.', 'ai_consent_scope')
    return this.policies.grant(tenant, { task: task.id, purpose: task.purpose, fieldSetHash: this.fieldSetHash(task), provider: provider.name, model: provider.model, ...scope })
  }

  /**
   * Run a task a person asked for. `trigger: 'automatic'` exists so a job can
   * ask, and is refused while automatic processing is disabled.
   */
  async run<R>(tenant: TenantContext, taskId: string, request: { projectId: string; findingId: string | null; input: unknown; consentId?: string | null; trigger?: 'user' | 'automatic' }): Promise<TaskOutcome<R>> {
    const task = this.task(taskId)
    requirePermission(tenant, task.permission)
    const scope = this.scope(tenant, request.projectId, request.findingId)
    const fallback = (code: string, reason: string, invocationId?: string): TaskOutcome<R> => {
      const parsed = task.inputSchema.safeParse(request.input)
      return { source: 'deterministic', result: parsed.success ? (task.fallback(scope, parsed.data) as R | null) : null, code, reason, invocationId }
    }
    if ((request.trigger ?? 'user') === 'automatic' && !AUTOMATIC_EXTERNAL_AI_ENABLED) return fallback('ai_automatic_disabled', 'Automatic external AI processing is not enabled.')
    const policy = this.policies.get(tenant.tenantId)
    if (policy.mode === 'off') return fallback('ai_off', 'External AI is off for this account.')
    const { built, packetHash } = this.build(task, scope, request.input)
    const provider = this.providerFor(task.id)
    if (!provider) return fallback('ai_unavailable', 'No AI provider is configured.')
    const consent = this.policies.resolve(tenant.tenantId, { scopes: task.consentScopes ?? ['packet', 'field_set'], task: task.id, purpose: task.purpose, fieldSetHash: this.fieldSetHash(task), provider: provider.name, model: provider.model, packetHash, projectId: request.projectId, findingId: request.findingId }, request.consentId)
    if (!consent.ok) throw new HttpError(consent.code === 'ai_off' ? 403 : 409, consent.reason, consent.code)

    const started = this.now()
    const base = { task: task.id, task_version: task.version, provider: provider.name, model: provider.model, actor: tenant.actorLabel, policy_version: policy.version, consent_id: consent.consent.id, project_id: request.projectId, finding_id: request.findingId, packet_hash: packetHash, started_at: started }
    if (this.ledger.running(tenant.tenantId) >= this.limits.concurrent || this.ledger.countSince(tenant.tenantId, started - DAY) >= this.limits.perDay || this.ledger.tokensSince(tenant.tenantId, started - DAY) >= this.limits.tokensPerDay) {
      const id = this.ledger.start(tenant.tenantId, base)
      this.ledger.finish(tenant.tenantId, id, { outcome: 'budget', at: started, attempts: 0 })
      return fallback('ai_budget', 'This account has reached its AI limit for now.', id)
    }
    this.policies.markUsed(tenant.tenantId, consent.consent)
    const invocationId = this.ledger.start(tenant.tenantId, base)
    let attempts = 0
    let usage: { inputTokens: number; outputTokens: number } | undefined
    const finish = (outcome: 'ok' | 'rejected' | 'refused' | 'failed' | 'timeout', codes: string[] = []) =>
      this.ledger.finish(tenant.tenantId, invocationId, { outcome, at: this.now(), codes, attempts, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null })

    let output: unknown
    for (;;) {
      attempts++
      const signal = AbortSignal.timeout(this.limits.timeoutMs)
      try {
        const response = await provider.complete({ task: task.id, system: task.system, packet: built.packet, outputSchema: task.outputSchema, maxOutputTokens: task.maxOutputTokens, signal })
        usage = response.usage
        if (response.refused) {
          finish('refused', ['refused'])
          return fallback('ai_refused', 'The model declined this task.', invocationId)
        }
        output = response.output
        break
      } catch (err) {
        if (signal.aborted) {
          finish('timeout')
          return fallback('ai_timeout', 'The AI provider took too long.', invocationId)
        }
        if (err instanceof AiTransientError && attempts <= this.limits.retries) continue
        finish('failed', [err instanceof AiTransientError ? 'busy' : 'provider_error'])
        console.error('ai task failed:', task.id, err instanceof AiTransientError ? 'busy' : 'provider_error')
        return fallback(err instanceof AiTransientError ? 'ai_busy' : 'ai_failed', 'The AI provider did not answer.', invocationId)
      }
    }
    const parsed = task.outputSchema.safeParse(output)
    if (!parsed.success) {
      finish('rejected', ['malformed'])
      return fallback('ai_rejected', 'The AI output did not have the expected shape, so it was discarded.', invocationId)
    }
    const codes = task.validate(parsed.data, built)
    if (codes.length) {
      finish('rejected', codes)
      return fallback('ai_rejected', `The AI output broke Reclaim's rules (${codes.join(', ')}), so it was discarded.`, invocationId)
    }
    const result = task.finalize(parsed.data, built) as R
    finish('ok')
    return { source: 'ai', result, invocationId }
  }
}
