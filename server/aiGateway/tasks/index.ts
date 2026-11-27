import type { AiExecutionService } from '../service.ts'
import { draftRecoveryRequestTask } from './draftRequest.ts'

/**
 * Tasks every server has. Workstream route groups (inbound/, documents/)
 * register their own tasks from their create*Routes function, so adding one
 * never needs an edit here.
 */
export function registerAiTasks(ai: AiExecutionService): AiExecutionService {
  return ai.register(draftRecoveryRequestTask)
}
