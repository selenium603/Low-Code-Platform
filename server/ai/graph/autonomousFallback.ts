import { createHash } from 'node:crypto'

import type { AutonomousFallback, ClarificationProposal } from '../../../src/types/aiPatch'
import type { RagCandidate, RagComponentIndexItem } from '../context/componentIndex'
export { isPureAddRequest } from './editActionAnalysis'

export type CandidateEvidence = Extract<AutonomousFallback, { kind: 'select_best_candidate' }>['evidence'][number]

export interface RankedComponentCandidate {
  id: string
  score: number
  evidence: CandidateEvidence[]
}

const typeHints: Array<[RegExp, string]> = [
  [/图表|chart/i, 'Chart'],
  [/表单|form/i, 'Form'],
  [/按钮|button/i, 'Button'],
  [/图片|图像|image/i, 'Image'],
  [/输入框|input/i, 'Input'],
  [/标题|正文|文本|文案|text/i, 'Text']
]

const normalized = (value: string) => value.trim().toLocaleLowerCase()

export const rankComponentCandidates = (
  request: string,
  candidates: Array<RagCandidate | RagComponentIndexItem>
): RankedComponentCandidate[] => {
  const requestText = normalized(request)
  const hintedTypes = new Set(typeHints.filter(([pattern]) => pattern.test(request)).map(([, type]) => type))
  const typeCounts = candidates.reduce<Record<string, number>>((counts, candidate) => {
    counts[candidate.type] = (counts[candidate.type] || 0) + 1
    return counts
  }, {})
  return candidates.map((candidate, index) => {
    const evidence: CandidateEvidence[] = []
    let score = 0
    const name = normalized(candidate.name || '')
    const text = normalized('text' in candidate ? String(candidate.text || '') : '')
    if (requestText.includes(normalized(candidate.id))) { score += 1_000; evidence.push('stable_id') }
    if (name.length >= 2 && requestText.includes(name)) { score += 800; evidence.push('exact_name') }
    if (text.length >= 2 && requestText.includes(text)) { score += 700; evidence.push('exact_text') }
    if (hintedTypes.has(candidate.type)) {
      score += typeCounts[candidate.type] === 1 ? 500 : 100
      evidence.push(typeCounts[candidate.type] === 1 ? 'unique_type' : 'lexical')
    }
    if ('ragScore' in candidate && Number.isFinite(candidate.ragScore)) {
      score += Math.max(0, Number(candidate.ragScore)) * 100
      evidence.push('rag')
    }
    score += Math.max(0, candidates.length - index) / Math.max(1, candidates.length)
    evidence.push('spatial_order')
    return { id: candidate.id, score, evidence: [...new Set(evidence)] }
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
}

export const proposalIdFor = (proposal: Omit<ClarificationProposal, 'proposalId'>) => {
  const payload = JSON.stringify({
    source: proposal.source,
    code: proposal.code,
    question: proposal.question,
    fallback: proposal.fallback
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 20)
}

export const createProposal = (
  proposal: Omit<ClarificationProposal, 'proposalId'>
): ClarificationProposal => ({ ...proposal, proposalId: proposalIdFor(proposal) })

export const fallbackForAmbiguousCandidates = (
  request: string,
  candidates: Array<RagCandidate | RagComponentIndexItem>
): AutonomousFallback => {
  const ranked = rankComponentCandidates(request, candidates)
  const best = ranked[0]
  const second = ranked[1]
  const hasDeterministicLead = Boolean(best && best.evidence.some((item) => (
    item === 'stable_id' || item === 'exact_name' || item === 'exact_text' || item === 'unique_type'
  ))) && (!second || best.score > second.score)
  return hasDeterministicLead && best
    ? { kind: 'select_best_candidate', orderedCandidateIds: ranked.map((item) => item.id), evidence: best.evidence }
    : { kind: 'select_best_candidate', orderedCandidateIds: [], evidence: [] }
}
