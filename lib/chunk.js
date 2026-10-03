/**
 * 以符号为边界的代码分块（RAG 的最小检索单元）。
 *
 * 契约 §6：`chunkFile(irFile, symbols, options) -> Chunk[]`、`chunkIR(ir, options) -> Chunk[]`。
 *
 * 关键取舍：
 *   - 源码片段不是 IR 的法定字段（IR 只带行号），因此允许调用方通过
 *     `options.readText(fileId) -> string | undefined` 注入读取器；
 *   - 没有读取器时退化为"符号名 + 签名 + 路径 + kind"的结构化摘要文本，
 *     保证 chunk 依然可被 BM25 / 向量检索命中，而不是被丢弃；
 *   - 有源码时，chunk 文本 = 元信息注释行 + doc 注释 + 源码行区间。
 *     元信息与 doc 前缀是刻意的：IR 的符号行号通常不含前置 JSDoc，
 *     把 `symbol.doc` 带进来才能让"用户登录"这类中文描述召回 `login`。
 *
 * 本模块无 I/O（`readText` 由调用方注入），且对任何畸形输入不抛错。
 *
 * @module dsh-project-compass/chunk
 */

import { clip, hashContent, normalizeText, tokenize, toPosix } from './util.js'

/** chunk 类型（契约 §6）。 */
const KIND = {
  SYMBOL: 'symbol',
  HEADER: 'file-header',
  CONFIG: 'config',
  DOC: 'doc',
}

/** 排序用类型优先级：header 最先，其余按行号。 */
const KIND_RANK = { [KIND.HEADER]: 0, [KIND.SYMBOL]: 1, [KIND.CONFIG]: 2, [KIND.DOC]: 3 }

/** 整块成 chunk 的文件类型判定（kind 明确时优先，否则按语言兜底）。 */
const CONFIG_LANGUAGES = new Set(['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'properties', 'env', 'xml'])
const DOC_LANGUAGES = new Set(['markdown', 'md', 'mdx', 'text', 'txt', 'rst', 'adoc'])

const DEFAULT_OPTIONS = {
  maxChunksPerFile: 60,
  maxChunkChars: 4000,
  headerLines: 40,
  docWindow: 80,
  docThreshold: 200,
  docStep: 40,
}

/* ------------------------------------------------------------------ *
 * 公开 API
 * ------------------------------------------------------------------ */

/**
 * 单个文件 → chunk 列表（按行号稳定排序）。
 * @param {object|string} file IR File（缺字段可容忍，也可直接传 fileId 字符串）。
 * @param {object[]} symbols 该文件的符号（传全量符号也可以，内部按 fileId 过滤）。
 * @param {object} [options] { readText, maxChunksPerFile, maxChunkChars, headerLines, docWindow, docThreshold }
 * @returns {object[]} Chunk[]
 */
export function chunkFile(file, symbols, options = {}) {
  try {
    return buildFileChunks(normalizeFile(file), normalizeSymbols(symbols), normalizeOptions(options))
  } catch {
    return []
  }
}

/**
 * 整份 IR → chunk 列表（跨文件稳定排序：fileId → startLine → kind）。
 * @param {object} ir 统一 IR。
 * @param {object} [options] 与 chunkFile 相同，另支持 `maxChunks`。
 * @returns {object[]} Chunk[]
 */
export function chunkIR(ir, options = {}) {
  try {
    const opts = normalizeOptions(options)
    const rawFiles = Array.isArray(ir?.files) ? ir.files : []
    const symbols = Array.isArray(ir?.symbols) ? ir.symbols : []

    const byFile = new Map()
    for (const symbol of symbols) {
      const fileId = typeof symbol?.fileId === 'string' ? toPosix(symbol.fileId) : ''
      if (fileId.length === 0) continue
      const bucket = byFile.get(fileId)
      if (bucket === undefined) byFile.set(fileId, [symbol])
      else bucket.push(symbol)
    }

    const files = []
    const seen = new Set()
    for (const entry of rawFiles) {
      const file = normalizeFile(entry)
      if (file.id.length === 0 || seen.has(file.id)) continue
      seen.add(file.id)
      files.push(file)
    }
    // 只有符号、没有 File 记录的情况：补一个最小文件描述，避免丢 chunk。
    for (const fileId of byFile.keys()) {
      if (seen.has(fileId)) continue
      seen.add(fileId)
      files.push(normalizeFile({ id: fileId }))
    }

    const out = []
    for (const file of files) {
      for (const chunk of buildFileChunks(file, byFile.get(file.id) ?? [], opts)) out.push(chunk)
    }
    out.sort(compareAcrossFiles)

    const maxChunks = toInt(options?.maxChunks, 0, 0, 1000000)
    return maxChunks > 0 && out.length > maxChunks ? out.slice(0, maxChunks) : out
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * 文件级构建
 * ------------------------------------------------------------------ */

function buildFileChunks(file, symbols, options) {
  if (file.id.length === 0) return []
  // 容忍调用方传入全量符号：只保留确实属于本文件的那些。
  const owned = symbols.filter((symbol) => symbol.fileId.length === 0 || symbol.fileId === file.id)
  symbols = owned

  const source = readSource(file, options)
  const lines = source === undefined ? undefined : source.split('\n')
  const fileKind = classifyFileKind(file, symbols)

  const header = makeHeaderChunk(file, lines, symbols, options)
  const body = []
  if (fileKind === KIND.CONFIG || fileKind === KIND.DOC) {
    body.push(...makeWholeFileChunks(file, lines, fileKind, options))
  } else {
    body.push(...makeSymbolChunks(file, symbols, lines, options))
  }

  const selected = limitChunks(header, body, options)
  return finalize(selected)
}

function makeHeaderChunk(file, lines, symbols, options) {
  const totalLines = lines === undefined ? Math.max(1, file.loc || 1) : Math.max(1, lines.length)
  const endLine = Math.min(options.headerLines, totalLines)
  const head = lines === undefined ? [] : lines.slice(0, endLine)

  const overview = head.filter((line) => /^\s*(?:import|export|from|require|use\s|#include|package\s|using\s)/.test(line))
  const picked = overview.length > 0 ? overview.slice(0, options.headerLines) : head

  const meta = [`// file: ${file.id}${file.language ? ` (${file.language})` : ''}`, `// module: ${file.moduleId}`, `// kind: ${file.kind}`]
  if (file.exports.length > 0) meta.push(`// exports: ${clip(file.exports.join(', '), 300)}`)
  const names = symbols.map((symbol) => symbol.name).filter((name) => name.length > 0)
  if (names.length > 0) meta.push(`// symbols: ${clip(names.slice(0, 30).join(', '), 400)}`)
  meta.push(`// lines: ${totalLines}`)

  const headText = picked.join('\n').trim()
  const fallback = `// 无可用源码片段（未注入 readText 或读取失败），以上为文件级元信息摘要。`
  const text = headText.length > 0 ? `${meta.join('\n')}\n${headText}` : `${meta.join('\n')}\n${fallback}`

  return makeChunk({
    id: `${file.id}:1:${KIND.HEADER}`,
    fileId: file.id,
    moduleId: file.moduleId,
    startLine: 1,
    endLine,
    symbolId: null,
    symbolName: null,
    symbolKind: null,
    kind: KIND.HEADER,
    text,
  }, options)
}

function makeSymbolChunks(file, symbols, lines, options) {
  const out = []
  const ordered = [...symbols].sort(compareSymbols)
  for (const symbol of ordered) {
    const name = symbol.name
    const startLine = symbol.line
    const totalLines = lines === undefined ? Math.max(symbol.endLine, file.loc || 1) : Math.max(1, lines.length)
    const endLine = Math.max(startLine, Math.min(symbol.endLine, totalLines))

    let body = ''
    if (lines !== undefined) body = lines.slice(startLine - 1, endLine).join('\n')
    if (body.trim().length === 0) body = summaryText(file, [symbol])

    const meta = [`// ${file.id}:${startLine} ${symbol.kind} ${name}`.trimEnd()]
    if (symbol.signature) meta.push(`// signature: ${clip(symbol.signature, 300)}`)
    if (symbol.doc) meta.push(`// doc: ${clip(symbol.doc, 500)}`)

    out.push(makeChunk({
      id: `${file.id}:${startLine}:${KIND.SYMBOL}`,
      fileId: file.id,
      moduleId: file.moduleId,
      startLine,
      endLine,
      symbolId: symbol.id,
      symbolName: name,
      symbolKind: symbol.kind,
      kind: KIND.SYMBOL,
      text: `${meta.join('\n')}\n${body}`,
    }, options))
  }
  return out
}

function makeWholeFileChunks(file, lines, kind, options) {
  if (lines === undefined || lines.length === 0) {
    return [makeChunk({
      id: `${file.id}:1:${kind}`,
      fileId: file.id,
      moduleId: file.moduleId,
      startLine: 1,
      endLine: Math.max(1, file.loc || 1),
      symbolId: null,
      symbolName: null,
      symbolKind: null,
      kind,
      text: summaryText(file, []),
    }, options)]
  }

  const out = []
  for (const [startLine, endLine] of slidingWindows(lines.length, options)) {
    out.push(makeChunk({
      id: `${file.id}:${startLine}:${kind}`,
      fileId: file.id,
      moduleId: file.moduleId,
      startLine,
      endLine,
      symbolId: null,
      symbolName: null,
      symbolKind: null,
      kind,
      text: lines.slice(startLine - 1, endLine).join('\n'),
    }, options))
  }
  return out
}

/**
 * 滑窗：[1..n]，文件不超过阈值时整块一块；超过阈值时按 step 滑动 window 行。
 */
function slidingWindows(total, options) {
  if (total <= options.docThreshold) return [[1, total]]
  const out = []
  for (let start = 1; start <= total; start += options.docStep) {
    const end = Math.min(total, start + options.docWindow - 1)
    out.push([start, end])
    if (end >= total) break
  }
  return out
}

/* ------------------------------------------------------------------ *
 * chunk 组装
 * ------------------------------------------------------------------ */

function makeChunk(fields, options) {
  const text = truncateText(fields.text, options.maxChunkChars)
  return {
    id: fields.id,
    fileId: fields.fileId,
    moduleId: fields.moduleId,
    startLine: fields.startLine,
    endLine: fields.endLine,
    symbolId: fields.symbolId ?? null,
    symbolName: fields.symbolName ?? null,
    symbolKind: fields.symbolKind ?? null,
    kind: fields.kind,
    text,
    tokens: tokenize(text),
    hash: hashContent(text),
  }
}

/** 超长文本截断并标注；返回长度不超过 max。 */
function truncateText(text, max) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (value.length <= max) return value
  const marker = `\n…[已截断：原长 ${value.length} 字符]`
  const keep = Math.max(0, max - marker.length)
  return `${value.slice(0, keep)}${marker}`
}

/** 无源码时的结构化摘要文本（符号名 + 签名 + 路径 + kind）。 */
function summaryText(file, symbols) {
  const parts = [`文件 ${file.id}`, `语言 ${file.language}`, `模块 ${file.moduleId}`, `类型 ${file.kind}`]
  const names = symbols.map((symbol) => symbol.name).filter((name) => name.length > 0)
  if (names.length > 0) parts.push(`符号 ${names.join('、')}`)
  const kinds = [...new Set(symbols.map((symbol) => symbol.kind))].filter((kind) => kind.length > 0)
  if (kinds.length > 0) parts.push(`种类 ${kinds.join('、')}`)
  const signatures = symbols.map((symbol) => symbol.signature).filter((sig) => typeof sig === 'string' && sig.length > 0)
  if (signatures.length > 0) parts.push(`签名 ${clip(signatures.join(' ; '), 400)}`)
  const docs = symbols.map((symbol) => symbol.doc).filter((doc) => typeof doc === 'string' && doc.length > 0)
  if (docs.length > 0) parts.push(`说明 ${clip(docs.join(' ; '), 400)}`)
  if (file.exports.length > 0) parts.push(`导出 ${file.exports.slice(0, 20).join('、')}`)
  if (symbols.length > 0) parts.push(`起始行 ${symbols[0].line}`)
  return `${parts.join('；')}。（未注入源码读取器，仅提供结构化摘要）`
}

/* ------------------------------------------------------------------ *
 * 配额与排序
 * ------------------------------------------------------------------ */

/** 单文件 chunk 超限时的裁剪：header 必留，其余按类型选择。 */
function limitChunks(header, body, options) {
  const max = options.maxChunksPerFile
  const all = [header, ...body].filter(Boolean)
  if (all.length <= max) return all
  if (max <= 1) return [header].filter(Boolean)

  const budget = max - (header ? 1 : 0)
  const pool = body.filter(Boolean)
  if (pool.length === 0) return [header].filter(Boolean)

  let picked
  const windowed = pool[0].kind === KIND.CONFIG || pool[0].kind === KIND.DOC
  if (windowed) {
    // 滑窗必须覆盖全文，等距抽样而不是只保留前 N 块。
    picked = pickEvenly(pool, budget)
  } else {
    // 符号：优先保留跨度大的实现（近似"重要符号"），再回按行号排序。
    picked = [...pool]
      .sort((a, b) => span(b) - span(a) || a.startLine - b.startLine || (a.id < b.id ? -1 : 1))
      .slice(0, budget)
  }
  return [header, ...picked].filter(Boolean)
}

function pickEvenly(list, count) {
  if (count >= list.length) return [...list]
  if (count <= 1) return [list[0]]
  const out = []
  for (let i = 0; i < count; i += 1) {
    out.push(list[Math.round((i * (list.length - 1)) / (count - 1))])
  }
  return [...new Set(out)]
}

function span(chunk) {
  return Math.max(0, chunk.endLine - chunk.startLine)
}

/** 过滤空内容、消除 id 冲突、稳定排序。 */
function finalize(chunks) {
  const seen = new Map()
  const out = []
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.text !== 'string' || chunk.text.trim().length === 0) continue
    if (typeof chunk.id !== 'string' || chunk.id.length === 0) continue
    const count = seen.get(chunk.id) ?? 0
    seen.set(chunk.id, count + 1)
    if (count > 0) chunk.id = `${chunk.id}#${count + 1}`
    out.push(chunk)
  }
  return out.sort(compareChunks)
}

function compareChunks(a, b) {
  if (a.startLine !== b.startLine) return a.startLine - b.startLine
  const ra = KIND_RANK[a.kind] ?? 9
  const rb = KIND_RANK[b.kind] ?? 9
  if (ra !== rb) return ra - rb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function compareAcrossFiles(a, b) {
  if (a.fileId !== b.fileId) return a.fileId < b.fileId ? -1 : 1
  return compareChunks(a, b)
}

function compareSymbols(a, b) {
  if (a.line !== b.line) return a.line - b.line
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/* ------------------------------------------------------------------ *
 * 输入规约
 * ------------------------------------------------------------------ */

function normalizeFile(file) {
  if (typeof file === 'string') {
    const id = toPosix(file)
    return { id, moduleId: moduleIdOf(id), language: 'text', kind: 'source', loc: 0, exports: [] }
  }
  const raw = file && typeof file === 'object' ? file : {}
  const id = toPosix(raw.id ?? raw.fileId ?? '')
  return {
    id,
    moduleId: String(raw.moduleId ?? moduleIdOf(id)),
    language: String(raw.language ?? 'text'),
    kind: String(raw.kind ?? 'source'),
    loc: Number.isFinite(Number(raw.loc)) ? Math.max(0, Math.trunc(Number(raw.loc))) : 0,
    exports: Array.isArray(raw.exports) ? raw.exports.filter((name) => typeof name === 'string') : [],
  }
}

function moduleIdOf(fileId) {
  const index = fileId.lastIndexOf('/')
  return index <= 0 ? '.' : fileId.slice(0, index)
}

function normalizeSymbols(symbols) {
  const list = Array.isArray(symbols) ? symbols : []
  const out = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const name = String(raw.name ?? '').trim()
    if (name.length === 0) continue
    const line = toInt(raw.line, 1, 1, Number.MAX_SAFE_INTEGER)
    const endLine = Math.max(line, toInt(raw.endLine, line, 1, Number.MAX_SAFE_INTEGER))
    out.push({
      id: String(raw.id ?? `${raw.fileId ?? ''}#${name}@${line}`),
      fileId: toPosix(raw.fileId ?? ''),
      name,
      kind: String(raw.kind ?? 'function'),
      line,
      endLine,
      signature: typeof raw.signature === 'string' && raw.signature.length > 0 ? raw.signature : null,
      doc: typeof raw.doc === 'string' && raw.doc.trim().length > 0 ? raw.doc.trim() : null,
      exported: raw.exported === true,
    })
  }
  return out
}

function normalizeOptions(options) {
  const raw = options && typeof options === 'object' ? options : {}
  return {
    readText: typeof raw.readText === 'function' ? raw.readText : undefined,
    maxChunksPerFile: toInt(raw.maxChunksPerFile, DEFAULT_OPTIONS.maxChunksPerFile, 1, 5000),
    maxChunkChars: toInt(raw.maxChunkChars, DEFAULT_OPTIONS.maxChunkChars, 40, 200000),
    headerLines: toInt(raw.headerLines, DEFAULT_OPTIONS.headerLines, 1, 400),
    docWindow: toInt(raw.docWindow, DEFAULT_OPTIONS.docWindow, 10, 500),
    docThreshold: toInt(raw.docThreshold, DEFAULT_OPTIONS.docThreshold, 10, 100000),
    docStep: toInt(raw.docStep, DEFAULT_OPTIONS.docStep, 1, 500),
  }
}

function classifyFileKind(file, symbols) {
  const kind = file.kind.toLowerCase()
  if (kind.includes('config')) return KIND.CONFIG
  if (kind.includes('doc')) return KIND.DOC
  const language = file.language.toLowerCase()
  if (symbols.length === 0 && CONFIG_LANGUAGES.has(language)) return KIND.CONFIG
  if (symbols.length === 0 && DOC_LANGUAGES.has(language)) return KIND.DOC
  return KIND.SYMBOL
}

function readSource(file, options) {
  if (typeof options.readText !== 'function') return undefined
  try {
    const text = options.readText(file.id)
    if (typeof text !== 'string' || text.length === 0) return undefined
    return normalizeText(text)
  } catch {
    return undefined
  }
}

function toInt(value, fallback, min, max) {
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) return fallback
  if (number < min) return min
  if (number > max) return max
  return number
}
