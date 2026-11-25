/**
 * HTTP for J4 inbound supplier replies and reply classification.
 * Registered once in app.ts; this group answers only the paths it owns and
 * returns null for everything else.
 */
import type { RouteGroup, WorkstreamDeps } from '../workstream.ts'

export function createInboundRoutes(deps: WorkstreamDeps): RouteGroup {
  void deps
  return async () => null
}
