/**
 * The inbound-reply webhook (J4): `POST /api/inbound/webhook/:provider`.
 *
 * No session: the caller proves itself with an HMAC-SHA256 over
 * `${timestamp}.${rawBody}` under `settings.inboundWebhookSecret`, compared in
 * constant time, with the timestamp within ±5 minutes. A signature is accepted
 * once (replay table) and a provider message id is stored once (dedup), so a
 * retried delivery is answered 200 and does nothing.
 *
 * The provider is not chosen yet (docs/workstream-recovery-ai/J4-inbound.md).
 * `fixture` is a local JSON envelope standing in for one; a real provider is
 * one more parser producing the same `InboundEnvelope`.
 *
 * Who the message is for comes only from the hashed routing token in `To`.
 * Neither `From` nor the token alone proves who sent it: a message is
 * accepted only when DKIM and DMARC passed, the From domain is the domain the
 * request was sent to, the token is live and for the case's current request,
 * and the case is waiting on the supplier. Anything else is quarantined:
 * stored for a person to read, flagged, and nothing is proposed from it.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { HttpError, json, type Request, type Response } from '../http.ts'
import { systemContext } from '../tenant.ts'
import { storedCase } from '../recoveryFacts.ts'
import type { WorkstreamDeps } from '../workstream.ts'
import { sanitizeEmailBody, sanitizeLine, stripQuoted, instructionLike } from './sanitize.ts'
import { classifyReply, vendorUpdateFor, CATEGORY_LABEL, type ReplyClassification } from './classify.ts'
import { TOKEN_PATTERN, type AttachmentMeta, type Authentication, type InboundStore } from './store.ts'

export const MAX_WEBHOOK_BYTES = 1024 * 1024
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000
export const SIGNATURE_HEADER = 'x-reclaim-signature'
export const TIMESTAMP_HEADER = 'x-reclaim-timestamp'
export const PROVIDERS = new Set(['fixture'])

/** `v1=<hex>` for the fixture format; tests and a local sender use this. */
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
}

export type SignatureCheck = { ok: true; signature: string } | { ok: false; code: 'inbound_signature_missing' | 'inbound_signature_invalid' | 'inbound_signature_expired' }

export function verifySignature(secret: string, headers: Request['headers'], rawBody: string, now: number): SignatureCheck {
  const header = headers[SIGNATURE_HEADER]
  const stamp = headers[TIMESTAMP_HEADER]
  if (typeof header !== 'string' || typeof stamp !== 'string' || !header || !stamp) return { ok: false, code: 'inbound_signature_missing' }
  if (!/^\d{9,11}$/.test(stamp)) return { ok: false, code: 'inbound_signature_invalid' }
  const ts = Number(stamp)
  if (Math.abs(now - ts * 1000) > SIGNATURE_TOLERANCE_MS) return { ok: false, code: 'inbound_signature_expired' }
  const expected = Buffer.from(createHmac('sha256', secret).update(`${stamp}.${rawBody}`).digest('hex'), 'utf8')
  // Several `v1=` values are allowed so a secret can be rotated without dropping mail.
  for (const part of header.split(',').map((p) => p.trim()).slice(0, 5)) {
    const m = /^v1=([a-f0-9]{64})$/.exec(part)
    if (!m) continue
    const given = Buffer.from(m[1], 'utf8')
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, signature: m[1] }
  }
  return { ok: false, code: 'inbound_signature_invalid' }
}

const AUTH_RESULT = z.string().trim().toLowerCase().max(20).catch('unknown')
const EnvelopeSchema = z.object({
  messageId: z.string().trim().min(1).max(998),
  to: z.union([z.string().max(4000), z.array(z.string().max(998)).max(50)]),
  from: z.string().max(998),
  subject: z.string().max(4000).optional().default(''),
  text: z.string().max(MAX_WEBHOOK_BYTES).nullable().optional(),
  html: z.string().max(MAX_WEBHOOK_BYTES).nullable().optional(),
  authentication: z.object({ spf: AUTH_RESULT, dkim: AUTH_RESULT, dmarc: AUTH_RESULT }).partial().optional().default({}),
  attachments: z.array(z.object({
    filename: z.string().max(500).optional().default(''),
    contentType: z.string().max(200).optional().default('application/octet-stream'),
    size: z.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    /** Fixture only: bytes are hashed and dropped, never stored, opened or executed. */
    contentBase64: z.string().max(MAX_WEBHOOK_BYTES).optional(),
  })).max(20).optional().default([]),
})
export type InboundEnvelope = z.infer<typeof EnvelopeSchema>

/** One mailbox from a From header, or null when it isn't exactly one well-formed address. */
export function parseFrom(header: string): { address: string; domain: string; name: string } | null {
  const value = header.replace(/[\r\n]+/g, ' ').trim()
  const angled = /^(?:"?([^"<>]*?)"?\s*)?<([^<>\s@,;]+@[^<>\s@,;]+)>$/.exec(value)
  const bare = /^([^<>\s@,;"]+@[^<>\s@,;"]+)$/.exec(value)
  const address = (angled?.[2] ?? bare?.[1])?.toLowerCase()
  if (!address) return null
  const domain = address.slice(address.lastIndexOf('@') + 1).replace(/\.$/, '')
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) return null
  return { address, domain, name: sanitizeLine(angled?.[1] ?? '', 120) }
}

const domainOf = (email: string | null | undefined) => {
  if (!email) return null
  const at = email.lastIndexOf('@')
  return at > 0 ? email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '') : null
}

function attachmentMeta(list: InboundEnvelope['attachments']): AttachmentMeta[] {
  return list.map((a) => {
    let digest = a.sha256?.toLowerCase() ?? null
    let size = a.size ?? 0
    if (a.contentBase64 !== undefined) {
      const bytes = Buffer.from(a.contentBase64, 'base64')
      digest = createHash('sha256').update(bytes).digest('hex')
      size = bytes.length
    }
    return { name: sanitizeLine(a.filename, 200) || 'attachment', declaredType: sanitizeLine(a.contentType, 100).toLowerCase(), size, sha256: digest, quarantined: true as const }
  })
}

const ok = (status: string, id?: string) => json(200, { ok: true, status, ...(id ? { id } : {}) })

export async function handleWebhook(deps: WorkstreamDeps, store: InboundStore, req: Request, provider: string): Promise<Response> {
  const { inboundWebhookSecret: secret, inboundDomain } = deps.settings
  if (!PROVIDERS.has(provider)) throw new HttpError(404, 'Not found.')
  if (!secret || !inboundDomain) throw new HttpError(503, 'Inbound replies are not set up on this server.', 'inbound_unavailable')
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > MAX_WEBHOOK_BYTES) throw new HttpError(413, 'Message too large.', 'inbound_too_large')
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_WEBHOOK_BYTES) throw new HttpError(413, 'Message too large.', 'inbound_too_large')

  const now = deps.now()
  const check = verifySignature(secret, req.headers, raw, now)
  if (!check.ok) throw new HttpError(401, 'Signature check failed.', check.code)
  if (store.seenBefore(check.signature)) return ok('duplicate')

  let envelope: InboundEnvelope
  try {
    const parsed = EnvelopeSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) throw new Error('shape')
    envelope = parsed.data
  } catch {
    throw new HttpError(400, 'The message envelope is malformed.', 'inbound_malformed')
  }
  if (store.hasMessage(provider, envelope.messageId)) return ok('duplicate')

  const auth: Authentication = { spf: envelope.authentication.spf ?? 'none', dkim: envelope.authentication.dkim ?? 'none', dmarc: envelope.authentication.dmarc ?? 'none' }
  const toLine = Array.isArray(envelope.to) ? envelope.to.join(', ') : envelope.to
  const domain = inboundDomain.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tokens = new Set([...toLine.toLowerCase().matchAll(new RegExp(`reply\\+(${TOKEN_PATTERN})@${domain}(?![a-z0-9.-])`, 'g'))].map((m) => m[1]))
  if (tokens.size !== 1) return ok('unrouted', store.insertUnrouted(provider, envelope.messageId, [tokens.size ? 'ambiguous_route' : 'no_route'], auth))
  const [token] = tokens
  const route = store.routeByToken(token)
  if (!route) return ok('unrouted', store.insertUnrouted(provider, envelope.messageId, ['unknown_route'], auth))

  // From here the message belongs to one tenant and one case; every check adds a reason, and any reason quarantines.
  const reasons: string[] = []
  if (auth.dkim !== 'pass') reasons.push('dkim_not_pass')
  if (auth.dmarc !== 'pass') reasons.push('dmarc_not_pass')
  if (route.revoked_at !== null) reasons.push('route_revoked')
  const from = parseFrom(envelope.from)
  if (!from) reasons.push('from_unparseable')
  const c = storedCase(deps.projects.get(route.user_id, route.project_id), route.finding_id)
  const generation = c ? c.state.activeRequestGeneration ?? 1 : null
  if (!c) reasons.push('case_missing')
  else {
    if (route.generation !== generation) reasons.push('old_generation')
    if (c.state.recoveryStage !== 'requested') reasons.push('case_not_requested')
    const recipientDomain = domainOf(c.state.recoverySentEmail?.to ?? c.state.recoveryRecipientEmail)
    if (!recipientDomain) reasons.push('no_recorded_recipient')
    else if (from && from.domain !== recipientDomain) reasons.push('from_domain_mismatch')
  }

  const body = sanitizeEmailBody({ text: envelope.text, html: envelope.html })
  const reply = stripQuoted(body.text)
  if (instructionLike(reply.text) || instructionLike(sanitizeLine(envelope.subject))) reasons.push('instruction_like_text')
  if (body.truncated) reasons.push('body_truncated')
  const attachments = attachmentMeta(envelope.attachments)
  const receivedAt = now
  let classification: ReplyClassification | null = null
  if (!reasons.length && c) {
    classification = classifyReply(reply.text, { requestedAmount: c.state.requestedAmount ?? null, requestedMethod: c.state.requestedResolution ?? null, receivedAt })
  }
  const status = reasons.length ? 'quarantined' : 'accepted'
  const id = store.insert({
    tenantId: route.user_id, projectId: route.project_id, findingId: route.finding_id, generation, provider, providerMessageId: envelope.messageId,
    status, reasons, auth, routeHash: route.token_hash, receivedAt,
    content: () => ({ from: from?.address ?? null, fromName: from?.name ?? '', subject: sanitizeLine(envelope.subject), text: body.text, reply: reply.text, attachments, classification }),
  })

  if (status === 'accepted' && classification) {
    const input = vendorUpdateFor(classification, { messageId: id, receivedAt, origin: 'inbound' })
    if (input) {
      try {
        const proposal = deps.approvals.propose(systemContext(route.user_id, 'inbound'), {
          projectId: route.project_id, findingId: route.finding_id, origin: 'inbound',
          payload: { kind: 'case_command', command: 'vendor_update', input },
          reason: `A supplier reply (inbound message ${id}) reads as ${CATEGORY_LABEL[classification.category]}. Suggested by fixed rules; read the reply first.`,
          sourceRefs: [`inbound:${id}`], dedupeKey: `inbound:${id}:rules`,
        })
        store.setProposal(route.user_id, id, proposal.id, null)
      } catch (err) {
        // The message is stored either way; only the code is kept, never the error text.
        store.setProposal(route.user_id, id, null, err instanceof HttpError ? err.code ?? `http_${err.status}` : 'proposal_failed')
      }
    } else store.setProposal(route.user_id, id, null, `no_proposal_${classification.category}`)
  }
  return ok(status, id)
}
