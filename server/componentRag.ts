export interface RagComponentIndexItem {
  index: number
  id: string
  type: string
  name: string
  text?: string
  desktop: number[]
  mobile: number[]
  spatial: {
    desktop: string
    mobile: string
  }
  neighborIds: string[]
}

export interface RagCandidate extends RagComponentIndexItem {
  ragScore: number
  ragSignals: string[]
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>
  error?: { message?: string }
  message?: string
}

interface RetrieveOptions {
  query: string
  componentIndex: RagComponentIndexItem[]
  apiKey: string
  baseUrl: string
  model: string
  signal: AbortSignal
  topK?: number
}

interface EmbeddingCacheEntry {
  vector: number[]
  updatedAt: number
}

const TYPE_LABELS: Record<string, string> = {
  Text: '文本 标题 说明 文案',
  Image: '图片 图像 主视觉 背景',
  Button: '按钮 行动按钮 CTA',
  Input: '输入框 输入项',
  Form: '表单 联系 报名 提交',
  Chart: '图表 数据可视化 柱状图 折线图 饼图'
}
const CACHE_TTL = 15 * 60 * 1000
const MAX_CACHE_ENTRIES = 1024
const EMBEDDING_BATCH_SIZE = 128
const embeddingCache = new Map<string, EmbeddingCacheEntry>()

const normalizeText = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim()

const tokenize = (value: string) => {
  const normalized = normalizeText(value)
  const tokens = new Set(normalized.match(/[a-z0-9_-]+|[\u4e00-\u9fff]/g) || [])
  const chinese = [...normalized].filter((char) => /[\u4e00-\u9fff]/.test(char))
  for (let index = 0; index + 1 < chinese.length; index += 1) {
    tokens.add(`${chinese[index]}${chinese[index + 1]}`)
  }
  return tokens
}

const lexicalScore = (query: string, document: string) => {
  const normalizedQuery = normalizeText(query)
  const normalizedDocument = normalizeText(document)
  if (!normalizedQuery) return 0
  const queryTokens = tokenize(normalizedQuery)
  const documentTokens = tokenize(normalizedDocument)
  let matches = 0
  queryTokens.forEach((token) => {
    if (documentTokens.has(token)) matches += token.length > 1 ? 1.5 : 0.5
  })
  const denominator = [...queryTokens].reduce((sum, token) => sum + (token.length > 1 ? 1.5 : 0.5), 0) || 1
  const tokenScore = Math.min(1, matches / denominator)
  const exactBoost = normalizedDocument.includes(normalizedQuery) ? 0.35 : 0
  return Math.min(1, tokenScore + exactBoost)
}

const cosineSimilarity = (first: number[], second: number[]) => {
  if (!first.length || first.length !== second.length) return 0
  let dot = 0
  let firstNorm = 0
  let secondNorm = 0
  for (let index = 0; index < first.length; index += 1) {
    dot += first[index] * second[index]
    firstNorm += first[index] ** 2
    secondNorm += second[index] ** 2
  }
  return firstNorm && secondNorm ? dot / Math.sqrt(firstNorm * secondNorm) : 0
}

const componentDocument = (item: RagComponentIndexItem, itemMap: Map<string, RagComponentIndexItem>) => {
  const neighbors = item.neighborIds
    .map((id) => itemMap.get(id))
    .filter((value): value is RagComponentIndexItem => Boolean(value))
    .map((value) => `${value.name || value.id}(${TYPE_LABELS[value.type] || value.type},ID:${value.id})`)
    .join('、')
  return [
    `组件ID:${item.id}`,
    `类型:${TYPE_LABELS[item.type] || item.type}`,
    `名称:${item.name || '未命名'}`,
    item.text ? `文案:${item.text}` : '',
    `桌面位置:${item.spatial.desktop};矩形:${item.desktop.join(',')}`,
    `手机位置:${item.spatial.mobile};矩形:${item.mobile.join(',')}`,
    neighbors ? `空间邻居:${neighbors}` : ''
  ].filter(Boolean).join('；')
}

const pruneCache = () => {
  const now = Date.now()
  for (const [key, entry] of embeddingCache) {
    if (now - entry.updatedAt > CACHE_TTL) embeddingCache.delete(key)
  }
  while (embeddingCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = [...embeddingCache.entries()]
      .sort((first, second) => first[1].updatedAt - second[1].updatedAt)[0]?.[0]
    if (!oldestKey) break
    embeddingCache.delete(oldestKey)
  }
}

const requestEmbeddings = async (
  inputs: string[],
  options: Pick<RetrieveOptions, 'apiKey' | 'baseUrl' | 'model' | 'signal'>
) => {
  const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: options.model, input: inputs, encoding_format: 'float' }),
    signal: options.signal
  })
  const payload = await response.json() as EmbeddingResponse
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.message || `Embedding API ${response.status}`)
  }
  const ordered = Array.isArray(payload.data)
    ? [...payload.data].sort((first, second) => Number(first.index) - Number(second.index))
    : []
  const vectors = ordered.map((item) => item.embedding).filter((value): value is number[] => (
    Array.isArray(value) && value.length > 0 && value.every(Number.isFinite)
  ))
  if (vectors.length !== inputs.length) throw new Error('Embedding 返回数量与输入文档数量不一致。')
  return vectors
}

const embedDocuments = async (documents: string[], options: RetrieveOptions) => {
  const vectors: number[][] = []
  for (let offset = 0; offset < documents.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = documents.slice(offset, offset + EMBEDDING_BATCH_SIZE)
    vectors.push(...await requestEmbeddings(batch, options))
  }
  return vectors
}

const rankCandidates = (
  query: string,
  componentIndex: RagComponentIndexItem[],
  documents: string[],
  queryVector?: number[],
  documentVectors?: number[][]
) => componentIndex.map((item, index) => {
  const lexical = lexicalScore(query, documents[index])
  const vector = queryVector && documentVectors?.[index]
    ? Math.max(0, cosineSimilarity(queryVector, documentVectors[index]))
    : 0
  const score = queryVector ? vector * 0.82 + lexical * 0.18 : lexical
  const signals = [
    vector ? `语义相似度 ${vector.toFixed(3)}` : '',
    lexical ? `关键词匹配 ${lexical.toFixed(3)}` : ''
  ].filter(Boolean)
  return { ...item, ragScore: Number(score.toFixed(4)), ragSignals: signals }
}).sort((first, second) => second.ragScore - first.ragScore || first.index - second.index)

const expandWithSpatialNeighbors = (
  ranked: RagCandidate[],
  itemMap: Map<string, RagComponentIndexItem>,
  topK: number
) => {
  const selected = new Map<string, RagCandidate>()
  const seeds = ranked.slice(0, Math.max(4, topK - 4))
  seeds.forEach((candidate) => selected.set(candidate.id, candidate))
  for (const seed of seeds) {
    for (const neighborId of seed.neighborIds) {
      if (selected.size >= topK) break
      const neighbor = itemMap.get(neighborId)
      if (!neighbor || selected.has(neighborId)) continue
      selected.set(neighborId, {
        ...neighbor,
        ragScore: Number(Math.max(0, seed.ragScore - 0.05).toFixed(4)),
        ragSignals: [`空间邻近 ${seed.name || seed.id}`]
      })
    }
  }
  for (const candidate of ranked) {
    if (selected.size >= topK) break
    if (!selected.has(candidate.id)) selected.set(candidate.id, candidate)
  }
  return [...selected.values()].sort((first, second) => second.ragScore - first.ragScore)
}

export const retrieveComponentsWithRag = async (options: RetrieveOptions) => {
  const itemMap = new Map(options.componentIndex.map((item) => [item.id, item]))
  const documents = options.componentIndex.map((item) => componentDocument(item, itemMap))
  const topK = Math.min(options.topK || 16, options.componentIndex.length)
  pruneCache()

  const lexicalFallback = (warning?: string) => ({
    mode: 'lexical' as const,
    ...(warning ? { warning } : {}),
    candidates: expandWithSpatialNeighbors(
      rankCandidates(options.query, options.componentIndex, documents),
      itemMap,
      topK
    )
  })
  if (!options.apiKey) return lexicalFallback('Embedding 未启用')

  try {
    const documentKeys = documents.map((document) => `${options.model}\n${document}`)
    const missingIndexes = documentKeys.flatMap((key, index) => embeddingCache.has(key) ? [] : [index])
    const vectors = await embedDocuments(
      [options.query, ...missingIndexes.map((index) => documents[index])],
      options
    )
    const queryVector = vectors[0]
    missingIndexes.forEach((documentIndex, vectorIndex) => {
      embeddingCache.set(documentKeys[documentIndex], {
        vector: vectors[vectorIndex + 1],
        updatedAt: Date.now()
      })
    })
    const documentVectors = documentKeys.map((key) => {
      const cached = embeddingCache.get(key)
      if (!cached) throw new Error('组件向量缓存写入失败。')
      cached.updatedAt = Date.now()
      return cached.vector
    })
    pruneCache()
    return {
      mode: 'vector' as const,
      candidates: expandWithSpatialNeighbors(
        rankCandidates(options.query, options.componentIndex, documents, queryVector, documentVectors),
        itemMap,
        topK
      )
    }
  } catch (error) {
    if (options.signal.aborted) throw error
    return lexicalFallback(error instanceof Error ? error.message.slice(0, 240) : 'Embedding 请求失败')
  }
}
