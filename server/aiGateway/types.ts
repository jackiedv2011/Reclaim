import type { z } from 'zod'
import type { Permission, TenantContext } from '../tenant.ts'
import type { ValidationCode } from './validators.ts'
import type { Pseudonymizer } from './pseudonymize.ts'

/** What a task may read: the tenant's own saved audit, resolved by the server. */
export interface TaskScope {
  tenant: TenantContext
  projectId: string
  findingId: string | null
  /** The decrypted saved audit, or null when it isn't on this account. */
  project: Record<string, unknown> | null
}

export interface BuiltPacket<P> {
  packet: P
  /** Restores pseudonymised values locally after validation. */
  names: Pseudonymizer
  /** Record ids the output may cite. */
  sourceIds: string[]
  /** Amounts (USD minor units) the output may state. */
  amountsMinor: number[]
}

export type BuildResult<P> = { ok: true; built: BuiltPacket<P> } | { ok: false; code: string; reason: string; status?: number }

/**
 * One registered AI task: everything about what it may see, what it may say
 * and what happens when it can't run. Adding a task means adding one of these;
 * there is no other path to a model.
 */
export interface AiTask<I, P, O, R> {
  id: string
  version: string
  /** Shown on the consent screen and bound into every consent. */
  purpose: string
  /** Human-readable list of every field the packet can contain. Its hash is what a standing consent covers. */
  fields: readonly string[]
  permission: Permission
  /** Which consents may cover this task. Default both; tasks that read documents allow only a one-time packet consent. */
  consentScopes?: ReadonlyArray<'packet' | 'field_set'>
  inputSchema: z.ZodType<I>
  outputSchema: z.ZodType<O>
  system: string
  maxPacketChars: number
  maxOutputTokens: number
  /** Supplier-facing text gets the stricter outbound checks. */
  build(scope: TaskScope, input: I): BuildResult<P>
  /** Codes for every rule the output breaks; empty when it may be shown. */
  validate(output: O, built: BuiltPacket<P>): ValidationCode[]
  /** The result with real names restored. Runs only after validation passed. */
  finalize(output: O, built: BuiltPacket<P>): R
  /** The private, deterministic answer used when AI is off, unavailable or rejected. Null when there is none. */
  fallback(scope: TaskScope, input: I): R | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAiTask = AiTask<any, any, any, any>
