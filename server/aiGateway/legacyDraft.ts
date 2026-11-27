/**
 * The original `DraftService` (server/ai.ts), used as a provider for the draft
 * task only. Kept so existing injections keep working; it now receives the
 * minimised, pseudonymised packet, never the raw case.
 */
import type { DraftService } from '../ai.ts'
import { AiProviderError, AiTransientError, type AiProvider } from './providers.ts'
import { DRAFT_TASK, type DraftPacket } from './tasks/draftRequest.ts'

export function draftServiceProvider(drafts: DraftService, model = 'draft-service'): AiProvider {
  return {
    name: 'draft-service',
    model,
    tasks: new Set([DRAFT_TASK]),
    async complete(req) {
      const p = req.packet as DraftPacket
      try {
        const output = await drafts.draft({
          vendor: p.supplier, findingType: p.checkType, findingTitle: p.checkDescription, explanation: p.checkDescription,
          evidenceStrength: p.evidenceStrength, amountFlagged: p.amountSupported, amountRequested: p.amountRequested, method: p.method,
          recoveryStage: 'confirmed',
          rows: p.payments.map((r) => ({ invoiceNumber: r.invoice, invoiceDate: r.invoiceDate, paymentDate: r.paymentDate ?? '', invoiceAmount: r.invoiceAmount, amountPaid: r.amountPaid, terms: r.terms })),
          userContext: p.reviewerNote ?? '',
          sender: { businessName: p.senderBusiness ?? '', senderName: p.senderName ?? '', senderEmail: '' },
        })
        return { output }
      } catch (err) {
        if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ai_busy') throw new AiTransientError('busy')
        throw new AiProviderError('draft failed')
      }
    },
  }
}
