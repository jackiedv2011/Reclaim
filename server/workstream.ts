/**
 * What the recovery/AI workstream's route groups share. app.ts builds one of
 * these and hands it to each group; each group answers the paths it owns
 * and returns null for the rest (the same pattern as gmail.ts and account.ts).
 *
 * Route groups: recoveryRoutes.ts (AI gateway, approvals), jobs/ (J3),
 * inbound/ (J4), documents/ (J5). Registered once in app.ts so the groups
 * never need to touch it again.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Request, Response } from './http.ts'
import type { ProjectStore } from './projectStore.ts'
import type { CaseCommands } from './caseCommands.ts'
import type { TenantContext } from './tenant.ts'
import type { UserRow } from './db.ts'
import type { Sealer } from './sealedJson.ts'
import type { AiExecutionService } from './aiGateway/service.ts'
import type { ApprovalService } from './approvals.ts'

export type RouteGroup = (req: Request) => Promise<Response | null>

export interface WorkstreamDeps {
  db: DatabaseSync
  projects: ProjectStore
  caseCommands: CaseCommands
  sealer: Sealer
  ai: AiExecutionService
  approvals: ApprovalService
  /** The signed-in user; throws 401 otherwise. */
  requireUser(req: Request): UserRow
  /** Server-derived tenant and permissions for a signed-in user. */
  tenantFor(user: UserRow): TenantContext
  /** Runs after any case command the workstream executes (billing bookkeeping). */
  afterCaseCommand(userId: string, project: Record<string, unknown>): void
  /**
   * Calls another route of this server as the same signed-in person, so an
   * approved action goes through exactly the checks a click would (used to
   * reach the Gmail send routes without duplicating them).
   */
  dispatch(req: Request, method: string, path: string, body: unknown): Promise<Response>
  now(): number
  settings: WorkstreamSettings
}

/**
 * Switches for the parts that talk to the outside world. All off by default:
 * none of them is read from the environment until a founder approves the
 * provider, domain and data handling (docs/workstream-recovery-ai/pilot-checklist.md).
 */
export interface WorkstreamSettings {
  /** HMAC secret for the inbound-reply webhook. Null: the webhook answers 503. */
  inboundWebhookSecret: string | null
  /** Domain for per-case reply addresses (reply+<token>@domain). Null: no routing addresses are issued. */
  inboundDomain: string | null
}
export const DEFAULT_WORKSTREAM_SETTINGS: WorkstreamSettings = { inboundWebhookSecret: null, inboundDomain: null }
