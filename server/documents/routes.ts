/**
 * HTTP for J5 document intake, extraction and evidence intelligence.
 * Registered once in app.ts; this group answers only the paths it owns and
 * returns null for everything else.
 */
import type { RouteGroup, WorkstreamDeps } from '../workstream.ts'

export function createDocumentRoutes(deps: WorkstreamDeps): RouteGroup {
  void deps
  return async () => null
}
