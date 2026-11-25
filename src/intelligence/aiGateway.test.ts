import { describe, expect, it } from 'vitest'
import { DISABLED_AI_GATEWAY, rejectUnsupportedAiText, type AiTaskRequest } from './aiGateway.ts'
import { fixtureContext } from './fixtures/synthetic.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const request: AiTaskRequest = { task: 'summarize_insight', packet: { vendor: 'Fixture Coffee Co', amount: '4980.00', median: '1300.00' }, allowedCitations: ['insight:1'] }

describe('AI gateway seam', () => {
  it('ships disabled, with policy off for every tenant', async () => {
    const ctx = fixtureContext()
    expect(DISABLED_AI_GATEWAY.enabled).toBe(false)
    expect(DISABLED_AI_GATEWAY.policy(ctx)).toBe('off')
    expect((await DISABLED_AI_GATEWAY.run(ctx, request)).status).toBe('disabled')
  })

  it('rejects numbers, links, addresses and citations the packet does not contain', () => {
    expect(rejectUnsupportedAiText('Payments in the covered records rose to 4980.00.', request, ['insight:1'])).toBeNull()
    expect(rejectUnsupportedAiText('The supplier owes you $9,999.', request, [])).toBe('number_not_in_packet')
    expect(rejectUnsupportedAiText('That is 12% above usual.', request, [])).toBe('number_not_in_packet')
    expect(rejectUnsupportedAiText('Pay at https://example.test now', request, [])).toBe('links_or_addresses_not_allowed')
    expect(rejectUnsupportedAiText('Email billing@example.test', request, [])).toBe('links_or_addresses_not_allowed')
    expect(rejectUnsupportedAiText('See record 7.', request, ['record:7'])).toBe('citation_not_in_packet')
  })

  it('no module in src/intelligence imports a model provider SDK', () => {
    const dir = join(process.cwd(), 'src/intelligence')
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    for (const file of files) expect(readFileSync(join(dir, file), 'utf8')).not.toMatch(/@anthropic-ai|openai|server\/ai\.ts/)
  })
})
