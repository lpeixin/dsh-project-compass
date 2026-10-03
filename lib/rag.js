/**
 * 本地 RAG 检索与问答层（FR7）。
 *
 * 检索链路：BM25（k1=1.2, b=0.75） + 向量余弦 → RRF 融合（k=60） → 重排
 * （符号名精确/前缀、路径命中、kind 权重、同文件去冗余、有区分度词项覆盖加成）。
 *
 * **证据闸门**（"没证据就说没证据"）：
 *   `answer()` 只有在结果片段里命中"有区分度的词项"（df/N ≤ 0.4 且非中文单字，
 *   或查询里出现完整符号名）时才会给出 medium/high；否则直接走"未找到证据"分支——
 *   confidence=low、citations 为空、正文明确写"未在项目索引中找到相关证据"，
 *   最近片段只作为"仅供人工核对、不构成证据"列出。这样可避免"无关问题也自信作答"。
 *
 * 设计约束：
 *   - 零外部依赖、无网络；`answer()` 默认抽取式，绝不隐式调用 LLM；
 *   - `searchIndex()` 是纯函数（不读盘、不写盘、不依赖时间），便于单测；
 *   - 索引缺失/损坏/版本不符一律降级（`loadIndex` 返回 undefined），永不抛错；
 *   - LLM 只在 `options.withLlm === true` 且 `options.llmClient.available()` 时启用，
 *     失败一律回退抽取式；片段是唯一事实来源，输出须带 `path:line` 引用。
 *
 * @module dsh-project-compass/rag
 */

import { chunkFile, chunkIR } from './chunk.js'
import { EMBED_DIM, cosine, embed, embedDerived, featureTokens, isCjkToken } from './embed.js'
import { indexFile } from './paths.js'
import { readJsonFile, writeJsonFile } from './store.js'
import { hashContent, mapLimit, nowIso, uniq } from './util.js'

/** 索引 schema 版本（契约 §6：Index.schemaVersion = 1）。 */
const INDEX_SCHEMA = 1

const DEFAULT_MAX_CHUNKS = 20000
const DEFAULT_CONCURRENCY = 8
const DEFAULT_HITS = 8

/**
 * 证据闸门参数。
 *   - MAX_DF_RATIO：词项的 df/N 超过该比例即视为"太常见"，不算有区分度的命中；
 *   - CJK 单字在查询已含中文二元组时不参与证据，且 BM25 里降权（假信号主要来源）；
 *   - COVERAGE_BONUS：命中一个有区分度词项给重排分加的固定量，保证真实命中挤进结果集。
 */
const DEFAULT_MAX_DF_RATIO = 0.4
const CJK_SINGLE_WEIGHT = 0.25
const COVERAGE_BONUS = 0.01
const MAX_COVERAGE_TERMS = 3
/**
 * df 绝对下限：出现在 ≤ 该数量分块里的词项永不判为"太常见"。
 * 小项目（十几二十个 chunk）里 df/N 天然偏高，没有下限会把真实业务词全部闸掉。
 */
const MIN_COMMON_DF = 3

/** 重排时的 kind 权重（契约 §6）。 */
const KIND_WEIGHT = { symbol: 1.2, 'file-header': 1.0, config: 0.9, doc: 0.8 }

/** kind 的中文标签（回答里出现，便于中文用户阅读）。 */
const KIND_LABEL = { symbol: '符号', 'file-header': '文件概览', config: '配置', doc: '文档' }

/* ------------------------------------------------------------------ *
 * 索引构建
 * ------------------------------------------------------------------ */

/**
 * 全量构建索引。永不抛错：IR 畸形时返回空索引。
 * @param {string} root 项目根（仅用于审计，构建过程不读盘）。
 * @param {object} ir 统一 IR。
 * @param {object} [options] { readText, dim, maxChunks, concurrency, maxChunksPerFile, maxChunkChars, onProgress }
 * @returns {Promise<object>} Index
 */
export async function buildIndex(root, ir, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const dim = normalizeDim(opts.dim)
  const warnings = []
  try {
    const maxChunks = toPositiveInt(opts.maxChunks, DEFAULT_MAX_CHUNKS)
    const concurrency = toPositiveInt(opts.concurrency, DEFAULT_CONCURRENCY)
    let chunks = chunkIR(ir, {
      readText: opts.readText,
      maxChunksPerFile: opts.maxChunksPerFile,
      maxChunkChars: opts.maxChunkChars,
    })
    if (chunks.length > maxChunks) {
      warnings.push(`分块数超过 maxChunks（${maxChunks}），已截断 ${chunks.length - maxChunks} 块。`)
      chunks = chunks.slice(0, maxChunks)
    }
    const vectors = await embedChunks(chunks, dim, concurrency, opts.onProgress)
    return assembleIndex(chunks, vectors, dim, { fileHashes: fileHashMap(ir), warnings })
  } catch (error) {
    return assembleIndex([], [], dim, { warnings: [`索引构建失败：${errorText(error)}`] })
  }
}

/**
 * 读取磁盘索引；缺失、损坏、版本不符、结构不一致一律返回 undefined。
 * @param {string} root 项目根。
 * @returns {Promise<object|undefined>} Index | undefined
 */
export async function loadIndex(root) {
  try {
    if (typeof root !== 'string' || root.length === 0) return undefined
    const raw = await readJsonFile(indexFile(root), undefined)
    return normalizeIndex(raw)
  } catch {
    return undefined
  }
}

/**
 * 原子落盘索引。
 * @param {string} root 项目根。
 * @param {object} index 索引对象。
 * @returns {Promise<string>} 索引文件绝对路径（写失败时不抛错）。
 */
export async function saveIndex(root, index) {
  // root 非法时无法定位状态目录：不落盘、返回空串（保持"永不抛错"）。
  if (typeof root !== 'string' || root.length === 0) return ''
  let target = ''
  try {
    target = indexFile(root)
    await writeJsonFile(target, index)
  } catch {
    // 落盘失败不影响内存中的检索结果，调用方可从返回值判断路径。
  }
  return target
}

/**
 * 增量更新：只重建 changedFiles 的分块与向量，保留其它文件；
 * 删除 IR 中已不存在文件的分块；df / avgLen / stats 全量重算。
 * 纯同步实现（向量化本身是同步的），不读盘。
 * @param {object} index 原索引（可为 undefined/损坏）。
 * @param {object} ir 最新 IR。
 * @param {string[]} changedFiles 变更文件 id 列表。
 * @param {object} [options] 与 chunkFile 相同（readText 必传，否则回退摘要文本）。
 * @returns {object} 新 Index
 */
export function updateIndex(index, ir, changedFiles, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const previous = normalizeIndex(index)
  const dim = normalizeDim(opts.dim ?? previous?.dim)

  try {
    const changed = new Set((Array.isArray(changedFiles) ? changedFiles : []).map((id) => String(id ?? '')).filter((id) => id.length > 0))
    const files = collectFiles(ir)
    const current = new Map(files.map((file) => [file.id, file.raw]))
    const symbolsByFile = groupSymbols(ir)
    const knownFiles = current.size > 0

    // 索引不可用、或 IR 没有文件清单（无法判断"已删除文件"）→ 全量重建。
    if (!previous || !knownFiles) {
      const chunks = chunkIR(ir, opts)
      const vectors = chunks.map((chunk) => embedDerived(chunk.text, dim).values)
      return assembleIndex(chunks, vectors, dim, { fileHashes: fileHashMap(ir) })
    }

    const pairs = []
    const fileHashes = new Map()
    for (let i = 0; i < previous.chunks.length; i += 1) {
      const chunk = previous.chunks[i]
      if (changed.has(chunk.fileId)) continue // 待重建
      if (knownFiles && !current.has(chunk.fileId)) continue // 文件已删除
      pairs.push({ chunk, vector: previous.vectors[i] ?? [] })
      const previousHash = previous.files?.[chunk.fileId]?.hash
      if (typeof previousHash === 'string' && previousHash.length > 0) fileHashes.set(chunk.fileId, previousHash)
    }

    for (const fileId of changed) {
      const file = current.get(fileId)
      if (file === undefined) continue // 已删除：只删不加
      for (const chunk of chunkFile(file, symbolsByFile.get(fileId) ?? [], opts)) {
        pairs.push({ chunk, vector: embedDerived(chunk.text, dim).values })
      }
    }

    for (const [fileId, hash] of fileHashMap(ir)) {
      if (knownFiles && !current.has(fileId)) continue
      fileHashes.set(fileId, hash) // IR 的 hash 优先（文件内容权威来源）
    }

    pairs.sort((a, b) => comparePairs(a, b))
    return assembleIndex(
      pairs.map((pair) => pair.chunk),
      pairs.map((pair) => pair.vector),
      dim,
      { fileHashes, builtAt: previous.builtAt ?? nowIso(), warnings: previous.warnings },
    )
  } catch (error) {
    return previous ?? assembleIndex([], [], dim, { warnings: [`增量更新失败：${errorText(error)}`] })
  }
}

/* ------------------------------------------------------------------ *
 * 检索（纯函数）
 * ------------------------------------------------------------------ */

/**
 * BM25 + 向量 + RRF + 重排。纯函数：不读盘、不写盘、不依赖时间。
 * @param {object} index 索引。
 * @param {string} query 查询文本（空查询/无词项返回 []）。
 * @param {object} [options] { limit, k1, b, rrfK, perFileLimit, perFilePenalty, maxDfRatio }
 * @returns {object[]} Hit[]（形状见契约 §6）
 */
export function searchIndex(index, query, options = {}) {
  try {
    const idx = normalizeIndex(index)
    if (!idx) return []
    const question = typeof query === 'string' ? query.trim() : ''
    if (question.length === 0) return []
    const total = idx.chunks.length
    if (total === 0) return []

    const opts = options && typeof options === 'object' ? options : {}
    const limit = toPositiveInt(opts.limit, DEFAULT_HITS)
    const k1 = toNumber(opts.k1, 1.2)
    const b = clamp(toNumber(opts.b, 0.75), 0, 1)
    const rrfK = toPositiveInt(opts.rrfK, 60)

    const queryTokens = uniq(featureTokens(question))
    if (queryTokens.length === 0) return []
    const queryLower = question.toLowerCase()
    const avgLen = idx.avgLen > 0 ? idx.avgLen : 1
    // 词项分类：有区分度（strong）/ 弱证据（weak，单字与超短词）/ 太常见（common）。
    const terms = classifyQueryTerms(queryTokens, idx.df, total, opts)
    const strongSet = new Set(terms.strong)

    const bm25 = new Array(total).fill(0)
    const vector = new Array(total).fill(0)
    const coverage = new Array(total).fill(0)
    const queryVector = embed(question, idx.dim)

    for (let i = 0; i < total; i += 1) {
      const chunk = idx.chunks[i]
      const length = chunk.tokens.length
      let score = 0
      let strongMatches = 0
      if (queryTokens.length > 0) {
        const counts = countTokens(chunk.tokens)
        for (const token of queryTokens) {
          let tf = counts.get(token) ?? 0
          // CJK 词项不在 util.tokenize 的输出里（契约要求 chunk.tokens 用 util.tokenize），
          // 因此这里对中文词项回退到正文扫描；ASCII 词项不做扫描，避免 O(N·len) 开销。
          if (tf === 0 && isCjkToken(token)) tf = countOccurrences(chunk.text, token)
          if (tf === 0) continue
          if (strongSet.has(token)) strongMatches += 1
          const df = Number(idx.df[token]) || 0
          const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
          const weight = terms.weights.get(token) ?? 1
          score += weight * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / avgLen)))
        }
      }
      bm25[i] = score
      vector[i] = cosine(queryVector, idx.vectors[i])
      coverage[i] = Math.min(strongMatches, MAX_COVERAGE_TERMS) * COVERAGE_BONUS
    }

    const rankedBm25 = ranking(bm25)
    const rankedVector = ranking(vector)
    const fused = new Array(total).fill(0)
    rankedBm25.forEach((position, rank) => {
      fused[position] += 1 / (rrfK + rank + 1)
    })
    rankedVector.forEach((position, rank) => {
      fused[position] += 1 / (rrfK + rank + 1)
    })

    const scored = []
    for (let i = 0; i < total; i += 1) {
      if (!(fused[i] > 0)) continue
      // 覆盖加成只进重排分（scores.rerank）；scores.fused 仍是纯 RRF，遵守契约。
      const base = (fused[i] + coverage[i]) * rerankMultiplier(idx.chunks[i], queryTokens, queryLower)
      scored.push({ index: i, base, adjusted: base })
    }
    if (scored.length === 0) return []
    scored.sort((a, b2) => b2.base - a.base || a.index - b2.index)

    // 同文件多命中：超过 perFileLimit 条后按 penalty 递减，抑制"一个文件霸榜"。
    const perFileLimit = toPositiveInt(opts.perFileLimit, 2)
    const penalty = clamp(toNumber(opts.perFilePenalty, 0.85), 0.1, 1)
    const perFile = new Map()
    for (const item of scored) {
      const fileId = idx.chunks[item.index].fileId
      const seen = perFile.get(fileId) ?? 0
      if (seen >= perFileLimit) item.adjusted = item.base * Math.pow(penalty, seen - perFileLimit + 1)
      perFile.set(fileId, seen + 1)
    }
    scored.sort((a, b2) => b2.adjusted - a.adjusted || b2.base - a.base || a.index - b2.index)

    return scored.slice(0, limit).map((item) => {
      const chunk = idx.chunks[item.index]
      return {
        chunkId: chunk.id,
        fileId: chunk.fileId,
        symbolId: chunk.symbolId,
        symbolName: chunk.symbolName,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
        scores: {
          bm25: round6(bm25[item.index]),
          vector: round6(vector[item.index]),
          fused: round6(fused[item.index]),
          rerank: round6(item.adjusted),
        },
      }
    })
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * 问答
 * ------------------------------------------------------------------ */

/**
 * 项目级问答。默认抽取式（mode: 'extractive'）；只有显式开启 LLM 时才走模型。
 * 永不抛错：任何异常都降级为"未找到证据"的回答。
 * @param {string} root 项目根（可为 null，此时只用内存索引）。
 * @param {object} ir 统一 IR。
 * @param {string} question 问题。
 * @param {object} [options] { index, limit, withLlm, llmClient, validator, signal, maxDfRatio }
 * @returns {Promise<object>} Answer（形状见契约 §6）
 */
export async function answer(root, ir, question, options = {}) {
  const started = Date.now()
  const opts = options && typeof options === 'object' ? options : {}
  const asked = String(question ?? '')
  const trimmed = asked.trim()

  try {
    let index = normalizeIndex(opts.index)
    if (!index && typeof root === 'string' && root.length > 0) index = await loadIndex(root)
    // 磁盘索引缺失或为空时，用调用方给的 IR 现场构建（不落盘，避免问答产生副作用）。
    if ((!index || index.chunks.length === 0) && ir) index = await buildIndex(root, ir, opts)

    if (!index || index.chunks.length === 0) {
      return emptyAnswer(asked, '未在项目索引中找到相关证据：本地索引不存在或为空。请先运行项目分析（analyze）构建索引后重试。', ['证据不足：索引不可用'], started)
    }

    const hits = searchIndex(index, trimmed, { limit: toPositiveInt(opts.limit, DEFAULT_HITS), maxDfRatio: opts.maxDfRatio })
    if (hits.length === 0) {
      return noEvidenceAnswer(asked, [], '检索未命中任何分块', started)
    }

    // 证据闸门：必须至少命中一个有区分度的词项（或命中精确符号名），否则不算证据。
    const queryTokens = uniq(featureTokens(trimmed))
    const evidence = evaluateEvidence(index, queryTokens, hits, trimmed.toLowerCase(), opts)
    if (evidence.matchedStrong.length === 0 && evidence.matchedWeak.length === 0 && !evidence.exactNameHit) {
      return noEvidenceAnswer(asked, hits, '检索未命中任何有区分度的词项', started)
    }

    const extractive = composeAnswer(asked, trimmed, hits, index, ir, evidence, started)
    const llm = await tryLlmAnswer(trimmed, hits, opts)
    if (llm && typeof llm.text === 'string' && llm.text.trim().length > 0) {
      return {
        ...extractive,
        answer: llm.text.trim(),
        mode: llm.mode,
        notes: [...extractive.notes, ...llm.notes],
      }
    }
    if (llm && llm.notes.length > 0) {
      return { ...extractive, notes: [...extractive.notes, ...llm.notes] }
    }
    return extractive
  } catch (error) {
    return emptyAnswer(asked, '未在项目索引中找到相关证据：问答过程出现异常，已降级处理。', [`检索异常：${errorText(error)}`], started)
  }
}

/**
 * 索引统计摘要。
 * @param {object} index 索引。
 * @returns {{chunks: number, files: number, tokens: number, dim: number, builtAt: string|null}}
 */
export function indexStats(index) {
  try {
    const chunks = Array.isArray(index?.chunks) ? index.chunks : []
    const files = index?.files && typeof index.files === 'object' ? Object.keys(index.files).length : 0
    let tokens = 0
    if (Number.isFinite(Number(index?.stats?.tokens))) {
      tokens = Math.max(0, Math.trunc(Number(index.stats.tokens)))
    } else {
      for (const chunk of chunks) tokens += Array.isArray(chunk?.tokens) ? chunk.tokens.length : 0
    }
    return {
      chunks: chunks.length,
      files,
      tokens,
      dim: normalizeDim(index?.dim),
      builtAt: typeof index?.builtAt === 'string' ? index.builtAt : null,
    }
  } catch {
    return { chunks: 0, files: 0, tokens: 0, dim: EMBED_DIM, builtAt: null }
  }
}

/* ------------------------------------------------------------------ *
 * 抽取式回答装配
 * ------------------------------------------------------------------ */

function composeAnswer(question, trimmed, hits, index, ir, evidence, started) {
  const chunkById = new Map(index.chunks.map((chunk) => [chunk.id, chunk]))
  const files = uniq(hits.map((hit) => hit.fileId))

  const lexical = hits.some((hit) => hit.scores.bm25 > 0)
  const confidence = decideConfidence(hits, evidence, lexical, trimmed.toLowerCase())
  const matchedTerms = [...evidence.matchedStrong, ...evidence.matchedWeak]

  const lines = []
  lines.push(`问题：${trimmed.length > 0 ? trimmed : '（空）'}`)
  lines.push('')
  lines.push(`基于本地索引检索到 ${hits.length} 条证据，涉及 ${files.length} 个文件：${files.slice(0, 6).join('、')}${files.length > 6 ? ' 等' : ''}。`)
  if (evidence.matchedStrong.length > 0) {
    lines.push(`命中的有区分度词项：${evidence.matchedStrong.slice(0, 6).map((term) => `\`${term}\``).join('、')}（df/N ≤ ${round2(evidence.maxRatio)}）。`)
  } else {
    lines.push(`只命中弱证据词项：${evidence.matchedWeak.slice(0, 6).map((term) => `\`${term}\``).join('、')}（单字/超短词，区分度低，不足以支撑高置信度）。`)
  }
  lines.push('')
  lines.push(confidence === 'low' ? '可能相关的实现（证据不足，未构成结论）：' : '最相关的实现：')
  hits.forEach((hit, i) => {
    const chunk = chunkById.get(hit.chunkId)
    const kind = chunk?.kind ?? 'symbol'
    const label = KIND_LABEL[kind] ?? kind
    const name = hit.symbolName ? `\`${hit.symbolName}\`` : `\`${hit.fileId}\``
    const span = hit.endLine > hit.startLine ? `${hit.startLine}-${hit.endLine}` : `${hit.startLine}`
    lines.push(`${i + 1}. ${name}（${label}）— \`${hit.fileId}:${span}\``)
  })

  const top = hits[0]
  const topSymbol = top.symbolName ? `\`${top.symbolName}\`` : `\`${top.chunkId}\``
  lines.push('')
  if (confidence === 'low') {
    // 低置信度不得出现"结论"式措辞
    lines.push(`证据不足：以下片段与「${trimmed.length > 0 ? trimmed : '（空）'}」相关度最高，但不构成结论（最高相关：${topSymbol}，\`${top.fileId}:${top.startLine}\`）。`)
  } else {
    lines.push(`结论：与「${trimmed.length > 0 ? trimmed : '（空）'}」最相关的是 ${topSymbol}（\`${top.fileId}:${top.startLine}\`${top.endLine > top.startLine ? `-${top.endLine}` : ''}）。`)
  }
  const excerpt = firstMeaningfulLine(top.text)
  if (excerpt.length > 0) lines.push(`关键片段：\`${clipText(excerpt, 160)}\``)

  const relatedSymbols = collectRelatedSymbols(hits, ir)
  const relatedFlows = collectRelatedFlows(hits, ir)

  const notes = []
  notes.push(`证据闸门：命中词项 ${matchedTerms.slice(0, 8).map((term) => `\`${term}\``).join('、') || '无'}（df/N ≤ ${round2(evidence.maxRatio)} 才算有区分度）。`)
  if (confidence === 'low') {
    notes.push(lexical
      ? '证据不足：命中片段少或融合分数偏低，以上结论仅供参考，请补充更具体的符号名或路径关键词。'
      : '证据不足：没有词面命中，仅凭向量相似度召回，可能问题用词与索引词汇不匹配。')
  }
  if (evidence.matchedStrong.length === 0) {
    notes.push('本问题没有命中任何有区分度的词项，置信度被限制在 medium 以下。')
  }
  if (hits.length < 3) notes.push(`命中片段不足 3 条（实际 ${hits.length} 条），建议补充关键词后重试。`)
  notes.push('本回答为抽取式（本地检索），未调用大模型。')

  return {
    question,
    answer: lines.join('\n'),
    citations: hits.map((hit, i) => ({
      path: hit.fileId,
      line: hit.startLine,
      symbol: hit.symbolName || undefined,
      text: clipText(compactText(hit.text), 220),
      score: hit.scores.rerank,
      why: i === 0
        ? (confidence === 'low'
          ? `仅作为最接近的片段供人工核对（证据不足，不构成结论）：${hit.fileId}:${hit.startLine}`
          : `支撑结论句：与问题最相关的实现位于 ${hit.fileId}:${hit.startLine}`)
        : `支撑第 ${i + 1} 条证据：${hit.symbolName || hit.chunkId}（${hit.fileId}:${hit.startLine}）`,
    })),
    confidence,
    mode: 'extractive',
    relatedSymbols,
    relatedFlows,
    evidence: hits.map((hit) => `${hit.fileId}:${hit.startLine}`),
    notes,
    elapsedMs: Date.now() - started,
  }
}

/** 索引不可用 / 内部异常时的兜底回答（不附任何片段）。 */
function emptyAnswer(question, message, notes, started) {
  return {
    question,
    answer: message,
    citations: [],
    confidence: 'low',
    mode: 'extractive',
    relatedSymbols: [],
    relatedFlows: [],
    evidence: [],
    notes,
    elapsedMs: Date.now() - started,
  }
}

/**
 * 无证据回答：明确说"未找到证据"，close hit 只作为"最接近的片段"列出供人工核对，
 * 绝不包装成"最相关的实现/结论"，citations 一律为空（引用 == 有据引用）。
 */
function noEvidenceAnswer(question, nearestHits, reason, started) {
  const trimmed = String(question ?? '').trim()
  const label = trimmed.length > 0 ? `（问题：${trimmed}）` : '（问题为空）'
  const lines = [`未在项目索引中找到相关证据${label}。${reason}。`]
  // 同一文件只列一次，避免"最近片段"三个位置全被同一文件占满
  const nearest = []
  const seenFiles = new Set()
  for (const hit of Array.isArray(nearestHits) ? nearestHits : []) {
    if (!hit || seenFiles.has(hit.fileId)) continue
    seenFiles.add(hit.fileId)
    nearest.push(hit)
    if (nearest.length >= 3) break
  }
  if (nearest.length > 0) {
    lines.push('')
    lines.push('以下是与问题分数最高、但**不构成证据**的片段，仅供人工核对：')
    nearest.forEach((hit, i) => {
      const name = hit.symbolName ? ` \`${hit.symbolName}\`` : ''
      lines.push(`${i + 1}. \`${hit.fileId}:${hit.startLine}\`${name}`)
    })
  }
  lines.push('')
  lines.push('建议改用具体的符号名、文件名或功能关键词重试。')
  return {
    question,
    answer: lines.join('\n'),
    citations: [],
    confidence: 'low',
    mode: 'extractive',
    relatedSymbols: [],
    relatedFlows: [],
    evidence: [],
    notes: [`证据不足：${reason}，不能据此得出结论。`],
    elapsedMs: Date.now() - started,
  }
}

/**
 * 置信度：必须命中"有区分度"的词项才可能 high。
 *   - 单个有区分度词项最多 medium（除非查询里出现完整符号名）；
 *   - 单字 / 超短词这类弱证据永不支撑 high；
 *   - 没有任何有区分度词项命中时不会走到这里（answer 会直接走无证据分支）。
 */
function decideConfidence(hits, evidence, lexical, queryLower) {
  const top = hits[0]?.scores?.rerank ?? 0
  const strong = evidence.matchedStrong.length
  const weak = evidence.matchedWeak.length
  const exactName = evidence.exactNameHit
  if (strong >= 1 && exactName && top >= 0.02) return 'high'
  if (strong >= 2 && lexical && hits.length >= 3 && top >= 0.03) return 'high'
  if ((strong >= 1 || weak >= 1) && top >= 0.015) return 'medium'
  return 'low'
}

function collectRelatedSymbols(hits, ir) {
  const symbols = Array.isArray(ir?.symbols) ? ir.symbols : []
  const byId = new Map()
  for (const symbol of symbols) {
    if (symbol && typeof symbol.id === 'string') byId.set(symbol.id, symbol)
  }
  const out = []
  const seen = new Set()
  for (const hit of hits) {
    if (!hit.symbolName) continue
    const key = hit.symbolId || `${hit.fileId}#${hit.symbolName}`
    if (seen.has(key)) continue
    seen.add(key)
    const found = hit.symbolId ? byId.get(hit.symbolId) : undefined
    out.push({
      id: found?.id ?? key,
      name: found?.name ?? hit.symbolName,
      fileId: found?.fileId ?? hit.fileId,
      line: Number.isFinite(Number(found?.line)) ? Math.trunc(Number(found.line)) : hit.startLine,
    })
    if (out.length >= 8) break
  }
  return out
}

/** flows 从 IR（ir.flows / ir.graph.flows / ir.graph.flow）按命中文件或符号匹配。 */
function collectRelatedFlows(hits, ir) {
  const candidates = []
  if (Array.isArray(ir?.flows)) candidates.push(...ir.flows)
  if (Array.isArray(ir?.graph?.flows)) candidates.push(...ir.graph.flows)
  if (ir?.graph?.flow && typeof ir.graph.flow === 'object') candidates.push(ir.graph.flow)
  if (candidates.length === 0) return []

  const fileSet = new Set(hits.map((hit) => hit.fileId))
  const symbolSet = new Set(hits.map((hit) => hit.symbolId).filter((id) => typeof id === 'string'))
  const out = []
  const seen = new Set()
  for (const flow of candidates) {
    if (!flow || typeof flow !== 'object') continue
    const matched = flowMatches(flow, fileSet, symbolSet)
    if (!matched) continue
    const id = String(flow.id ?? flow.name ?? '')
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: String(flow.name ?? flow.id ?? id),
      confidence: flow.confidence === 'high' || flow.confidence === 'medium' ? flow.confidence : 'low',
    })
    if (out.length >= 5) break
  }
  return out
}

function flowMatches(flow, fileSet, symbolSet) {
  const entry = flow.entry && typeof flow.entry === 'object' ? flow.entry : flow
  if (fileSet.has(entry.fileId)) return true
  if (typeof entry.symbolId === 'string' && symbolSet.has(entry.symbolId)) return true
  const steps = Array.isArray(flow.steps) ? flow.steps : []
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue
    if (fileSet.has(step.fileId)) return true
    if (typeof step.symbolId === 'string' && symbolSet.has(step.symbolId)) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * 可选 LLM 路径（默认关闭，失败即回退）
 * ------------------------------------------------------------------ */

async function tryLlmAnswer(question, hits, options) {
  const client = options.llmClient
  if (options.withLlm !== true || !client) return undefined
  try {
    if (typeof client.available !== 'function' || client.available() !== true) return undefined
  } catch {
    return undefined
  }
  if (typeof client.complete !== 'function') return undefined

  const fragments = hits.map((hit, i) => {
    const where = `${hit.fileId}:${hit.startLine}${hit.endLine > hit.startLine ? `-${hit.endLine}` : ''}`
    return `[片段 ${i + 1}] ${where}${hit.symbolName ? ` #${hit.symbolName}` : ''}\n${clipText(hit.text, 1200)}`
  }).join('\n\n')

  const system = [
    '你是项目代码问答助手。只允许使用"可用片段"中的信息作答，严禁引入片段之外的任何事实、推测或常识。',
    '每一条结论后必须附 `路径:行号` 形式的引用（例如 lib/rag.js:42），无法引用就不要写。',
    '如果片段不足以回答问题，直接回答"证据不足"，不要编造。',
  ].join('\n')

  const prompt = [
    `问题：${question}`,
    '',
    '可用片段（唯一事实来源）：',
    fragments,
    '',
    '请用中文作答，逐条给出结论并标注引用。',
  ].join('\n')

  try {
    const result = await client.complete({ system, prompt, maxTokens: 900, temperature: 0, signal: options.signal })
    const text = typeof result?.text === 'string' ? result.text.trim() : ''
    if (text.length === 0) return { notes: ['LLM 返回为空，已回退抽取式回答。'] }

    if (options.validator && typeof options.validator.checkText === 'function') {
      let check
      try {
        check = options.validator.checkText(text)
      } catch {
        check = undefined
      }
      if (check && check.ok === false) {
        const dropped = Array.isArray(check.dropped) ? check.dropped.length : 0
        return { notes: [`LLM 回答未通过引用校验（${dropped} 条无据声明），已回退抽取式回答。`] }
      }
    }
    return { text, mode: 'llm', notes: ['答案由 LLM 基于检索片段合成（片段为唯一事实来源）。'] }
  } catch (error) {
    return { notes: [`LLM 调用失败，已回退抽取式回答：${errorText(error)}`] }
  }
}

/* ------------------------------------------------------------------ *
 * 向量化与索引装配
 * ------------------------------------------------------------------ */

async function embedChunks(chunks, dim, concurrency, onProgress) {
  const total = chunks.length
  let done = 0
  const report = (phase) => {
    if (typeof onProgress !== 'function') return
    try {
      onProgress({ phase, done, total })
    } catch {
      // 回调异常不影响索引构建
    }
  }
  if (total === 0) {
    report('done')
    return []
  }
  const results = await mapLimit(chunks, concurrency, async (chunk) => {
    const vector = embedDerived(chunk.text, dim).values
    done += 1
    report('embed')
    return vector
  })
  report('done')
  return results.map((values, i) => (Array.isArray(values) ? values : embedDerived(chunks[i].text, dim).values))
}

/** 由 chunk 与向量装配索引（df / avgLen / files / stats 全量重算）。 */
function assembleIndex(chunks, vectors, dim, extra = {}) {
  const list = Array.isArray(chunks) ? chunks : []
  const df = Object.create(null)
  const fileBuckets = new Map()
  let tokenTotal = 0

  for (let i = 0; i < list.length; i += 1) {
    const chunk = list[i]
    const tokens = Array.isArray(chunk?.tokens) ? chunk.tokens : []
    tokenTotal += tokens.length
    for (const token of new Set(featureTokens(chunk?.text))) {
      df[token] = (df[token] ?? 0) + 1
    }
    const bucket = fileBuckets.get(chunk.fileId)
    if (bucket === undefined) fileBuckets.set(chunk.fileId, { chunkIds: [chunk.id] })
    else bucket.chunkIds.push(chunk.id)
  }

  const fileHashes = extra.fileHashes instanceof Map ? extra.fileHashes : new Map()
  const files = {}
  for (const fileId of [...fileBuckets.keys()].sort()) {
    const bucket = fileBuckets.get(fileId)
    const hash = fileHashes.get(fileId)
    files[fileId] = {
      hash: typeof hash === 'string' && hash.length > 0 ? hash : hashContent(bucket.chunkIds.join('|')),
      chunkIds: bucket.chunkIds,
    }
  }

  const avgLen = list.length > 0 ? tokenTotal / list.length : 0
  return {
    schemaVersion: INDEX_SCHEMA,
    builtAt: typeof extra.builtAt === 'string' ? extra.builtAt : nowIso(),
    dim: normalizeDim(dim),
    chunks: list,
    vectors: Array.isArray(vectors) ? vectors : [],
    df: { ...df },
    avgLen,
    files,
    stats: { chunks: list.length, tokens: tokenTotal, files: Object.keys(files).length },
    // 附加字段（契约 §0.4 要求降级时写 warnings；不属于 §6 的必需字段，消费方可忽略）。
    warnings: Array.isArray(extra.warnings) ? extra.warnings.filter((item) => typeof item === 'string') : [],
  }
}

/* ------------------------------------------------------------------ *
 * 索引校验（损坏/版本不符 → undefined）
 * ------------------------------------------------------------------ */

function normalizeIndex(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  if (Math.trunc(Number(raw.schemaVersion)) !== INDEX_SCHEMA) return undefined
  if (!Array.isArray(raw.chunks) || !Array.isArray(raw.vectors)) return undefined
  if (raw.vectors.length !== raw.chunks.length) return undefined

  const chunks = []
  for (const entry of raw.chunks) {
    const chunk = normalizeChunk(entry)
    if (!chunk) return undefined
    chunks.push(chunk)
  }

  const dim = normalizeDim(raw.dim)
  const vectors = raw.vectors.map((vector) => {
    if (Array.isArray(vector) || ArrayBuffer.isView(vector)) return vector
    return new Array(dim).fill(0)
  })

  return {
    schemaVersion: INDEX_SCHEMA,
    builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : null,
    dim,
    chunks,
    vectors,
    df: raw.df && typeof raw.df === 'object' ? raw.df : {},
    avgLen: Number.isFinite(Number(raw.avgLen)) && Number(raw.avgLen) > 0 ? Number(raw.avgLen) : 1,
    files: raw.files && typeof raw.files === 'object' ? raw.files : {},
    stats: raw.stats && typeof raw.stats === 'object' ? raw.stats : { chunks: chunks.length, tokens: 0, files: 0 },
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((item) => typeof item === 'string') : [],
  }
}

function normalizeChunk(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (id.length === 0) return undefined
  const startLine = toPositiveInt(raw.startLine, 1)
  return {
    id,
    fileId: typeof raw.fileId === 'string' ? raw.fileId : '',
    moduleId: typeof raw.moduleId === 'string' ? raw.moduleId : '',
    startLine,
    endLine: Math.max(startLine, toPositiveInt(raw.endLine, startLine)),
    symbolId: typeof raw.symbolId === 'string' ? raw.symbolId : null,
    symbolName: typeof raw.symbolName === 'string' ? raw.symbolName : null,
    symbolKind: typeof raw.symbolKind === 'string' ? raw.symbolKind : null,
    kind: typeof raw.kind === 'string' ? raw.kind : 'symbol',
    text: typeof raw.text === 'string' ? raw.text : '',
    tokens: Array.isArray(raw.tokens) ? raw.tokens.filter((token) => typeof token === 'string') : [],
    hash: typeof raw.hash === 'string' ? raw.hash : '',
  }
}

/* ------------------------------------------------------------------ *
 * 证据闸门（区分度判定）
 * ------------------------------------------------------------------ */

/**
 * 查询词项分类，决定"什么才算证据"：
 *   - strong：有区分度（df/N ≤ maxDfRatio）的词项，可支撑 high；
 *   - weak：中文单字 / 超短 ASCII 词（≤2 字符），只能支撑 medium；
 *   - common：df/N 过高（太常见，例如小项目里的 "order"；df ≤ MIN_COMMON_DF 时不判常见）
 *     或"查询已有中文二元组时的单字"，一律不计入证据；
 *     单字同时降权参与 BM25 打分，压制「的/与/在」这类假信号；
 *   - weights：BM25 侧的词项权重。
 * 永不抛错：df 缺失按 0 处理。
 * @param {string[]} queryTokens 去重后的查询词项。
 * @param {Record<string, number>} df 索引词项文档频率。
 * @param {number} total 分块总数。
 * @param {object} [options] { maxDfRatio }
 */
function classifyQueryTerms(queryTokens, df, total, options = {}) {
  const maxRatio = clamp(toNumber(options?.maxDfRatio, DEFAULT_MAX_DF_RATIO), 0.05, 1)
  const tokens = Array.isArray(queryTokens) ? queryTokens : []
  const hasCjkBigram = tokens.some((token) => isCjkToken(token) && token.length >= 2)
  const strong = []
  const weak = []
  const common = []
  const weights = new Map()
  for (const token of tokens) {
    weights.set(token, 1)
    const frequency = Number(df?.[token]) || 0
    if (frequency <= 0) continue // 索引里根本没有这个词项 → 不构成证据
    const ratio = total > 0 ? frequency / total : 1
    const cjk = isCjkToken(token)
    const cjkSingle = cjk && token.length === 1
    if (cjkSingle && hasCjkBigram) {
      // 查询里已经有中文二元组：单字（的/与/在…）区分度太低，不参与证据，并降权打分
      common.push(token)
      weights.set(token, CJK_SINGLE_WEIGHT)
      continue
    }
    if (ratio > maxRatio && frequency > MIN_COMMON_DF) {
      // 太常见（例如小项目里的 "order"）：不算命中，但仍参与 BM25 打分（idf 自然会压低它）
      common.push(token)
      continue
    }
    if (cjkSingle || (!cjk && token.length <= 2)) weak.push(token)
    else strong.push(token)
  }
  return { strong, weak, common, weights, hasCjkBigram, maxRatio }
}

/**
 * 在返回的命中片段里核对证据（闸门的行为判定）：
 *   - matchedStrong / matchedWeak：真正出现在结果集里的有区分度 / 弱证据词项；
 *   - exactNameHit：查询里出现完整符号名——最强的区分度信号，不受 df 阈值限制。
 * 判定与 BM25 打分保持一致：ASCII 看 chunk.tokens，中文看正文子串。
 */
function evaluateEvidence(index, queryTokens, hits, queryLower, options = {}) {
  const terms = classifyQueryTerms(queryTokens, index?.df, index?.chunks?.length ?? 0, options)
  const list = Array.isArray(hits) ? hits : []
  const chunkById = new Map((Array.isArray(index?.chunks) ? index.chunks : []).map((chunk) => [chunk.id, chunk]))
  const candidates = list.map((hit) => chunkById.get(hit.chunkId) ?? hit)
  const matchedStrong = terms.strong.filter((term) => candidates.some((chunk) => chunkMatchesTerm(chunk, term)))
  const matchedWeak = terms.weak.filter((term) => candidates.some((chunk) => chunkMatchesTerm(chunk, term)))
  const exactNameHit = list.some((hit) => hit.symbolName && indexOfWord(queryLower, String(hit.symbolName).toLowerCase()))
  return { ...terms, matchedStrong, matchedWeak, exactNameHit }
}

/**
 * 片段是否包含某个词项。与 BM25 的判据一致：
 *   - ASCII 词项看 chunk.tokens（util.tokenize 的拆分结果，`createOrder` 同时含有 create/order）；
 *   - 中文词项看正文子串（chunk.tokens 按契约不含中文）。
 */
function chunkMatchesTerm(chunk, term) {
  if (!chunk || typeof term !== 'string' || term.length === 0) return false
  if (isCjkToken(term)) return String(chunk.text ?? '').toLowerCase().includes(term)
  if (Array.isArray(chunk.tokens)) return chunk.tokens.includes(term)
  return indexOfWord(String(chunk.text ?? '').toLowerCase(), term)
}

/* ------------------------------------------------------------------ *
 * 重排
 * ------------------------------------------------------------------ */

/** 重排倍率：符号名精确 ×3、前缀 ×2、路径命中 ×1.5、kind 权重。 */
function rerankMultiplier(chunk, queryTokens, queryLower) {
  let multiplier = 1
  const name = typeof chunk.symbolName === 'string' ? chunk.symbolName.toLowerCase() : ''
  if (name.length > 0) {
    if (indexOfWord(queryLower, name)) multiplier *= 3
    else if (name.length >= 3 && queryTokens.some((token) => token.length >= 3 && (name.startsWith(token) || token.startsWith(name)))) multiplier *= 2
  }
  const path = String(chunk.fileId ?? '').toLowerCase()
  const pathHit = path.length > 0
    ? queryTokens.some((token) => {
      if (token.length < 3) return false
      if (path.includes(token)) return true
      // 路径分段命中：src/auth.js 命中 token 'auth'
      return path.split(/[^a-z0-9]+/).some((segment) => segment.length >= 3 && (segment === token || segment.startsWith(token) || token.startsWith(segment)))
    })
    : false
  if (pathHit) multiplier *= 1.5
  const kindWeight = KIND_WEIGHT[chunk.kind]
  if (typeof kindWeight === 'number') multiplier *= kindWeight
  return multiplier
}

/** query 中是否出现完整的词（词边界判定，避免 `log` 命中 `login`）。 */
function indexOfWord(haystack, needle) {
  if (typeof haystack !== 'string' || typeof needle !== 'string' || needle.length === 0) return false
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return false
    const before = at === 0 ? '' : haystack[at - 1]
    const after = at + needle.length >= haystack.length ? '' : haystack[at + needle.length]
    if (!isWordChar(before) && !isWordChar(after)) return true
    from = at + 1
  }
}

const WORD_CHAR_RE = /[a-z0-9_$]/

function isWordChar(char) {
  return typeof char === 'string' && char.length === 1 && WORD_CHAR_RE.test(char)
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function ranking(scores) {
  const out = []
  for (let i = 0; i < scores.length; i += 1) if (scores[i] > 0) out.push(i)
  out.sort((a, b) => scores[b] - scores[a] || a - b)
  return out
}

function countTokens(tokens) {
  const counts = new Map()
  for (const token of tokens ?? []) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

function countOccurrences(text, token) {
  const value = typeof text === 'string' ? text.toLowerCase() : ''
  if (value.length === 0 || typeof token !== 'string' || token.length === 0) return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = value.indexOf(token, from)
    if (at < 0) return count
    count += 1
    from = at + token.length
  }
}

function collectFiles(ir) {
  const files = Array.isArray(ir?.files) ? ir.files : []
  const out = []
  const seen = new Set()
  for (const entry of files) {
    if (!entry || typeof entry !== 'object') continue
    const id = String(entry.id ?? entry.fileId ?? '')
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push({ id, raw: entry })
  }
  return out
}

function groupSymbols(ir) {
  const byFile = new Map()
  const symbols = Array.isArray(ir?.symbols) ? ir.symbols : []
  for (const symbol of symbols) {
    if (!symbol || typeof symbol !== 'object') continue
    const fileId = String(symbol.fileId ?? '')
    if (fileId.length === 0) continue
    const bucket = byFile.get(fileId)
    if (bucket === undefined) byFile.set(fileId, [symbol])
    else bucket.push(symbol)
  }
  return byFile
}

function fileHashMap(ir) {
  const map = new Map()
  for (const { id, raw } of collectFiles(ir)) {
    if (typeof raw.hash === 'string' && raw.hash.length > 0) map.set(id, raw.hash)
  }
  return map
}

function comparePairs(a, b) {
  const left = a.chunk
  const right = b.chunk
  if (left.fileId !== right.fileId) return left.fileId < right.fileId ? -1 : 1
  if (left.startLine !== right.startLine) return left.startLine - right.startLine
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function firstMeaningfulLine(text) {
  const lines = String(text ?? '').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('//') && !trimmed.startsWith('// ')) continue
    return trimmed
  }
  return ''
}

function compactText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function clipText(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function normalizeDim(dim) {
  const value = Math.trunc(Number(dim))
  if (!Number.isFinite(value) || value <= 0) return EMBED_DIM
  return Math.min(value, 65536)
}

function toPositiveInt(value, fallback) {
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number) || number <= 0) return fallback
  return number
}

function toNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, min, max) {
  if (value < min) return min
  if (value > max) return max
  return value
}

function round6(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const rounded = Math.round(number * 1e6) / 1e6
  return Object.is(rounded, -0) ? 0 : rounded
}

function round2(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.round(number * 100) / 100
}

function errorText(error) {
  return error && typeof error.message === 'string' ? error.message : String(error ?? '未知错误')
}
