/**
 * 本地确定性向量（零依赖、无网络、无模型文件）。
 *
 * 设计要点：
 *   - 完全确定性：同一文本在任何进程、任何机器上得到完全相同的向量
 *     （不使用 Math.random、不使用 Map 迭代顺序作为权重来源，特征按 key 排序后累加）；
 *   - 哈希词袋 + 字符三元组：词特征权重 `1 + log(tf)`，标识符拆分后另加权，
 *     长度 ≥6 的标识符补 3-gram（0.35）以提升模糊匹配；
 *   - 中文兜底：`util.tokenize` 只识别 ASCII 标识符，中文查询会退化为空特征，
 *     因此这里额外加入 CJK 单字与二元组（本地优先，无分词词典）；
 *   - 有符号哈希：同一个特征映射到桶，符号位来自哈希高位，降低哈希碰撞时的偏置；
 *   - L2 归一化：`cosine(a, b)` 即等于余弦相似度。
 *
 * @module dsh-project-compass/embed
 */

import { hashContent, isStopWord, splitIdentifier, tokenize } from './util.js'

/** 默认向量维度（契约 §6）。 */
export const EMBED_DIM = 256

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
const MIN_DIM = 8
const MAX_DIM = 65536

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g
const CJK_RUN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/** 各类特征的基础权重（同义词扩展刻意省略：不做词典、不做网络）。 */
const WEIGHT = {
  token: 1,
  identifierFull: 0.6,
  identifierPart: 0.9,
  gram: 0.35,
  cjkUnigram: 0.8,
  cjkBigram: 1.1,
}

/* ------------------------------------------------------------------ *
 * 哈希原语
 * ------------------------------------------------------------------ */

/**
 * 自实现的 FNV-1a 32 位哈希（不依赖 util.hashContent，后者返回字符串）。
 * @param {string} text 输入文本。
 * @param {number} seed 初始种子。
 * @returns {number} 无符号 32 位整数。
 */
function fnv1a(text, seed = FNV_OFFSET_BASIS) {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xffff
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

/**
 * 特征 key → 桶下标 + 符号位。
 * 用 `util.hashContent`（确定性、纯 JS）做种子，再用自实现 FNV-1a 打散，
 * 这样前缀不同的特征（w| / i| / g| / c|）不会因为 256 取模而挤在相邻桶。
 */
function bucketOf(key, dim) {
  const digest = hashContent(key)
  const seed = (parseInt(digest.slice(0, 8), 16) ^ FNV_OFFSET_BASIS) >>> 0
  const hash = fnv1a(key, seed)
  return { index: hash % dim, sign: ((hash >>> 24) & 1) === 0 ? 1 : -1 }
}

/** 维度规约：非法值回退默认，过小放大到 MIN_DIM，过大截断到 MAX_DIM。 */
function normalizeDim(dim) {
  const value = Math.trunc(Number(dim))
  if (!Number.isFinite(value) || value <= 0) return EMBED_DIM
  if (value < MIN_DIM) return MIN_DIM
  if (value > MAX_DIM) return MAX_DIM
  return value
}

/* ------------------------------------------------------------------ *
 * 特征抽取
 * ------------------------------------------------------------------ */

/** 是否为 CJK 字符/词项（用于 BM25 的词频回退扫描）。 */
export function isCjkToken(token) {
  return typeof token === 'string' && token.length > 0 && CJK_CHAR_RE.test(token)
}

/**
 * RAG 侧的统一词项视图：`util.tokenize`（契约中 chunk.tokens 的来源）
 * 加上 CJK 单字 / 二元组，让中文问题也能在纯英文代码索引里命中中文注释。
 *
 * 注意：`chunk.tokens` 仍严格使用 `util.tokenize(text)`，本函数只用于
 * 索引 df 统计与查询侧词项，不改变契约里的 Chunk 形状。
 *
 * @param {string} text 任意文本。
 * @returns {string[]} 小写词项序列（保留重复，供 tf 统计）。
 */
export function featureTokens(text) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (value.length === 0) return []
  const out = tokenize(value)
  // 中文没有空格分词：单字保证不漏，二元组保证精度。
  const runs = value.match(CJK_RUN_RE)
  if (runs) {
    for (const run of runs) {
      for (let i = 0; i < run.length; i += 1) {
        out.push(run[i])
        if (i + 1 < run.length) out.push(run.slice(i, i + 2))
      }
    }
  }
  return out
}

/**
 * 汇总加权特征：返回 Map<featureKey, weight>，key 已带域前缀。
 * 同一个 key 的权重相加（词袋与标识符拆分可以命中同一词）。
 */
function collectFeatures(text) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const features = new Map()
  const add = (key, weight) => {
    features.set(key, (features.get(key) ?? 0) + weight)
  }

  // 1) 词袋：权重 1 + log(tf)
  const termCount = new Map()
  for (const term of tokenize(value)) termCount.set(term, (termCount.get(term) ?? 0) + 1)
  for (const [term, count] of termCount) add(`w|${term}`, WEIGHT.token * (1 + Math.log(count)))

  // 2) 标识符：整名 + splitIdentifier 拆分后的词 + 3-gram
  const identifiers = value.match(IDENTIFIER_RE)
  if (identifiers) {
    const seen = new Set()
    for (const raw of identifiers) {
      const lower = raw.toLowerCase()
      if (lower.length === 0 || seen.has(lower)) continue
      seen.add(lower)
      if (lower.length >= 2) add(`i|${lower}`, WEIGHT.identifierFull)
      for (const part of new Set(splitIdentifier(raw))) {
        if (part.length < 2 || isStopWord(part)) continue
        add(`w|${part}`, WEIGHT.identifierPart)
      }
      if (lower.length >= 6) {
        for (let i = 0; i + 3 <= lower.length; i += 1) {
          add(`g|${lower.slice(i, i + 3)}`, WEIGHT.gram)
        }
      }
    }
  }

  // 3) 中文单字 / 二元组（带 log tf，避免长文档里重复词无限放大）
  const runs = value.match(CJK_RUN_RE)
  if (runs) {
    const unigram = new Map()
    const bigram = new Map()
    for (const run of runs) {
      for (let i = 0; i < run.length; i += 1) {
        const char = run[i]
        unigram.set(char, (unigram.get(char) ?? 0) + 1)
        if (i + 1 < run.length) {
          const pair = run.slice(i, i + 2)
          bigram.set(pair, (bigram.get(pair) ?? 0) + 1)
        }
      }
    }
    for (const [gram, count] of unigram) add(`c|${gram}`, WEIGHT.cjkUnigram * (1 + Math.log(count)))
    for (const [gram, count] of bigram) add(`c|${gram}`, WEIGHT.cjkBigram * (1 + Math.log(count)))
  }

  return features
}

/* ------------------------------------------------------------------ *
 * 公开 API（契约 §6）
 * ------------------------------------------------------------------ */

/**
 * 文本 → L2 归一化的确定性向量。
 * @param {string} text 任意文本（空文本得到全零向量）。
 * @param {number} [dim] 维度，默认 EMBED_DIM。
 * @returns {Float64Array} 长度 dim 的向量。
 */
export function embed(text, dim = EMBED_DIM) {
  const size = normalizeDim(dim)
  const out = new Float64Array(size)
  const features = collectFeatures(text)
  if (features.size === 0) return out

  // 排序后累加：浮点加法顺序固定，保证跨进程逐位一致。
  const keys = [...features.keys()].sort()
  for (const key of keys) {
    const { index, sign } = bucketOf(key, size)
    out[index] += sign * features.get(key)
  }

  let norm = 0
  for (let i = 0; i < size; i += 1) norm += out[i] * out[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < size; i += 1) out[i] /= norm
  }
  return out
}

/**
 * 批量向量化（保持输入顺序）。
 * @param {string[]} texts 文本列表。
 * @param {number} [dim] 维度。
 * @returns {Float64Array[]}
 */
export function embedTexts(texts, dim = EMBED_DIM) {
  const list = Array.isArray(texts) ? texts : []
  return list.map((text) => embed(text, dim))
}

/**
 * 可 JSON 落盘的派生向量（数值保留 6 位小数，显著压缩索引体积）。
 * @param {string} text 任意文本。
 * @param {number} [dim] 维度。
 * @returns {{dim: number, values: number[]}}
 */
export function embedDerived(text, dim = EMBED_DIM) {
  const size = normalizeDim(dim)
  const vector = embed(text, size)
  const values = new Array(size)
  for (let i = 0; i < size; i += 1) {
    const rounded = Math.round(vector[i] * 1e6) / 1e6
    values[i] = Object.is(rounded, -0) ? 0 : rounded
  }
  return { dim: size, values }
}

/**
 * 派生向量 → Float64Array（缺失维度补零，非法值归零，永不抛错）。
 * @param {{dim?: number, values?: number[]}} derived 派生向量。
 * @returns {Float64Array}
 */
export function vectorFromDerived(derived) {
  const raw = derived && typeof derived === 'object' ? derived : {}
  const values = Array.isArray(raw.values) || ArrayBuffer.isView(raw.values) ? raw.values : []
  const declared = Math.trunc(Number(raw.dim))
  const size = Number.isFinite(declared) && declared > 0 ? Math.max(declared, values.length || 0) : Math.max(values.length || 0, EMBED_DIM)
  const out = new Float64Array(size)
  const n = Math.min(size, values.length || 0)
  for (let i = 0; i < n; i += 1) {
    const value = Number(values[i])
    out[i] = Number.isFinite(value) ? value : 0
  }
  return out
}

/**
 * 余弦相似度：接受 Float64Array / number[] / 派生向量对象。
 * 长度不一致时按较短长度计算；任一向量为零向量返回 0。
 * @param {ArrayLike<number>|{dim: number, values: number[]}} a
 * @param {ArrayLike<number>|{dim: number, values: number[]}} b
 * @returns {number} [-1, 1] 之间的相似度。
 */
export function cosine(a, b) {
  const left = toNumericList(a)
  const right = toNumericList(b)
  if (left === undefined || right === undefined) return 0
  const n = Math.min(left.length, right.length)
  if (n === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < n; i += 1) {
    const x = toFinite(left[i])
    const y = toFinite(right[i])
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  const value = dot / (Math.sqrt(normA) * Math.sqrt(normB))
  if (!Number.isFinite(value)) return 0
  return value > 1 ? 1 : value < -1 ? -1 : value
}

/** 归一化为可索引的数值序列；无法识别返回 undefined。 */
function toNumericList(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value
  if (value && typeof value === 'object' && (Array.isArray(value.values) || ArrayBuffer.isView(value.values))) {
    return value.values
  }
  return undefined
}

function toFinite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}
