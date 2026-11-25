/**
 * HTTP for J3 durable jobs, scheduler, reminders and digests.
 * Registered once in app.ts; this group answers only the paths it owns and
 * returns null for everything else.
 */
import type { RouteGroup, WorkstreamDeps } from '../workstream.ts'

export function createJobRoutes(deps: WorkstreamDeps): RouteGroup {
  void deps
  return async () => null
}
