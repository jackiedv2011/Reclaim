/**
 * HTTP for J3 durable jobs, scheduler, reminders and digests.
 * Registered once in app.ts; this group answers only the paths it owns and
 * returns null for everything else. Data APIs only: Aditya owns the screens.
 *
 * Every route is for the signed-in tenant only. Queuing a scan does not run
 * it: jobs run when a worker calls `runDue` (J3-jobs.md).
 */
import { z } from 'zod'
import { HttpError, json, type Request, type Response } from '../http.ts'
import { requirePermission } from '../tenant.ts'
import type { RouteGroup, WorkstreamDeps } from '../workstream.ts'
import { JOB_KINDS } from './handlers.ts'
import { isTimeZone } from './notifications.ts'
import { JOB_STATUSES, type JobStatus } from './runner.ts'
import { createJobSystem } from './system.ts'

async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Send JSON.')
  const parsed = schema.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'The request is malformed.', 'validation')
  return parsed.data
}

const Preferences = z.object({
  digestEnabled: z.boolean(),
  timeZone: z.string().max(64).refine(isTimeZone),
  localHour: z.number().int().min(0).max(23),
}).strict()

export function createJobRoutes(deps: WorkstreamDeps): RouteGroup {
  const system = createJobSystem({ db: deps.db, projects: deps.projects, approvals: deps.approvals })

  return async (req: Request): Promise<Response | null> => {
    const path = req.url.pathname
    const method = req.method
    if (path !== '/api/jobs' && !path.startsWith('/api/jobs/') && path !== '/api/notifications' && !path.startsWith('/api/notifications/')) return null
    const user = deps.requireUser(req)
    const tenant = deps.tenantFor(user)
    const now = deps.now()

    // ---------- jobs ----------
    if (path === '/api/jobs' && method === 'GET') {
      requirePermission(tenant, 'case.read')
      const status = req.url.searchParams.get('status')
      if (status !== null && !JOB_STATUSES.includes(status as JobStatus)) throw new HttpError(400, 'Unknown status.', 'validation')
      return json(200, { jobs: system.runner.list(tenant.tenantId, { status: (status ?? undefined) as JobStatus | undefined }) })
    }
    if (path === '/api/jobs/scan' && method === 'POST') {
      requirePermission(tenant, 'jobs.manage')
      // A double click inside the same minute queues one scan.
      const { job, created } = system.enqueue(tenant.tenantId, JOB_KINDS.scan, {}, { idempotencyKey: `scan:manual:${Math.floor(now / 60_000)}`, runAt: now, now })
      return json(created ? 202 : 200, { job })
    }
    const jobMatch = path.match(/^\/api\/jobs\/([\w-]{1,100})(?:\/(cancel|events))?$/)
    if (jobMatch) {
      const [, id, action] = jobMatch
      if (!action && method === 'GET') {
        requirePermission(tenant, 'case.read')
        const job = system.runner.get(tenant.tenantId, id)
        if (!job) throw new HttpError(404, 'That job is not in this account.')
        return json(200, { job })
      }
      if (action === 'events' && method === 'GET') {
        requirePermission(tenant, 'case.read')
        if (!system.runner.get(tenant.tenantId, id)) throw new HttpError(404, 'That job is not in this account.')
        return json(200, { events: system.runner.events(tenant.tenantId, id) })
      }
      if (action === 'cancel' && method === 'POST') {
        requirePermission(tenant, 'jobs.manage')
        const job = system.runner.cancel(tenant.tenantId, id, now)
        if (!job) throw new HttpError(404, 'That job is not in this account.')
        if (!['cancelled', 'leased'].includes(job.status)) throw new HttpError(409, `This job is already ${job.status}.`, 'job_finished')
        return json(200, { job })
      }
    }

    // ---------- notifications ----------
    if (path === '/api/notifications' && method === 'GET') {
      requirePermission(tenant, 'case.read')
      const unreadOnly = req.url.searchParams.get('unread') === '1'
      return json(200, { notifications: system.notifications.list(tenant.tenantId, { unreadOnly }), unread: system.notifications.unreadCount(tenant.tenantId) })
    }
    if (path === '/api/notifications/preferences' && method === 'GET') {
      requirePermission(tenant, 'case.read')
      return json(200, { preferences: system.notifications.preferences(tenant.tenantId) })
    }
    if (path === '/api/notifications/preferences' && method === 'PUT') {
      requirePermission(tenant, 'jobs.manage')
      const input = await body(req, Preferences)
      return json(200, { preferences: system.notifications.setPreferences(tenant.tenantId, input, now) })
    }
    const readMatch = path.match(/^\/api\/notifications\/([\w-]{1,100})\/read$/)
    if (readMatch && method === 'POST') {
      requirePermission(tenant, 'case.read')
      const n = system.notifications.markRead(tenant.tenantId, readMatch[1], now)
      if (!n) throw new HttpError(404, 'That notification is not in this account.')
      return json(200, { notification: n })
    }
    throw new HttpError(404, 'Not found.')
  }
}
