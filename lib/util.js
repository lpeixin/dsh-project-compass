/**
 * 纯函数工具箱（零依赖、无 I/O、无副作用）。
 *
 * 约定：本文件**不得** import 任何东西（包括 node: 内置模块）。
 * 解析器、检索器、报告渲染器都依赖这里，保持"纯净 + 可单测"是它们的共同前提。
 *
 * @module dsh-project-compass/util
 */

/* ------------------------------------------------------------------ *
 * 字符串与文本
 * ------------------------------------------------------------------ */

/** ISO-8601 时间戳。 */
export function nowIso() {
  return new Date().toISOString()
}

/** 截断到 n 个字符，超出补省略号（n<=1 时直接硬截断）。 */
export function clip(value, n = 300) {
  const text = value === undefined || value === null ? '' : String(value)
  if (text.length <= n) return text
  if (n <= 1) return text.slice(0, Math.max(0, n))
  return `${text.slice(0, n - 1)}…`
}

/** 去 BOM、统一换行符。 */
export function normalizeText(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  return (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, '\n')
}

/** UTF-8 解码（BOM 安全）；非法字节以 U+FFFD 替代，不抛错。 */
export function decodeText(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? [])
  return normalizeText(new TextDecoder('utf-8', { fatal: false }).decode(view))
}

/** 行数（空文本记 0 行；末尾换行不额外计一行）。 */
export function countLines(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let lines = 1
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1
  return text.endsWith('\n') ? lines - 1 : lines
}

/** 是否为二进制样本（前 8KB 含 NUL 视为二进制）。 */
export function isBinarySample(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? [])
  const limit = Math.min(view.length, 8192)
  for (let i = 0; i < limit; i += 1) if (view[i] === 0) return true
  return false
}

/** 人类可读体积。 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 路径统一为正斜杠形式（跨平台稳定 id）。 */
export function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/** 去掉末尾斜杠（根路径除外）。 */
export function trimTrailingSlash(value) {
  const text = toPosix(value)
  return text.length > 1 && text.endsWith('/') ? text.replace(/\/+$/, '') : text
}

/** 由路径生成稳定、可读的标识符片段。 */
export function slugify(value, fallback = 'item') {
  const text = String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return text.length > 0 ? text : fallback
}

/** 文件名去扩展名。 */
export function stripExtension(name) {
  const text = String(name ?? '')
  const index = text.lastIndexOf('.')
  return index > 0 ? text.slice(0, index) : text
}

/** 取扩展名（小写，含点）。 */
export function extensionOf(name) {
  const text = String(name ?? '')
  const index = text.lastIndexOf('.')
  return index > 0 ? text.slice(index).toLowerCase() : ''
}

/** 去掉文件扩展名的路径。 */
export function withoutExtension(value) {
  const text = toPosix(value)
  const slash = text.lastIndexOf('/')
  const dot = text.lastIndexOf('.')
  return dot > slash ? text.slice(0, dot) : text
}

/* ------------------------------------------------------------------ *
 * 集合
 * ------------------------------------------------------------------ */

export function uniq(values) {
  return [...new Set(values ?? [])]
}

export function compact(values) {
  return (values ?? []).filter((value) => value !== undefined && value !== null && value !== '')
}

export function groupBy(values, key) {
  const out = new Map()
  for (const value of values ?? []) {
    const k = key(value)
    const bucket = out.get(k)
    if (bucket === undefined) out.set(k, [value])
    else bucket.push(value)
  }
  return out
}

export function countBy(values, key) {
  const out = new Map()
  for (const value of values ?? []) {
    const k = key(value)
    out.set(k, (out.get(k) ?? 0) + 1)
  }
  return out
}

export function sortBy(values, key, direction = 'asc') {
  const sign = direction === 'desc' ? -1 : 1
  return [...(values ?? [])].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka === kb) return 0
    return ka < kb ? -sign : sign
  })
}

export function sum(values) {
  let total = 0
  for (const value of values ?? []) total += Number(value) || 0
  return total
}

/** 分位数（0..1），线性插值；空数组返回 0。 */
export function percentile(values, p) {
  const list = [...(values ?? [])].filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (list.length === 0) return 0
  if (list.length === 1) return list[0]
  const rank = Math.min(Math.max(p, 0), 1) * (list.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  if (low === high) return list[low]
  return list[low] + (list[high] - list[low]) * (rank - low)
}

/** 数组分片（并发批处理用）。 */
export function chunk(values, size) {
  const list = [...(values ?? [])]
  const n = Math.max(1, Math.trunc(size) || 1)
  const out = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}

/**
 * 有界并发 map：保持输入顺序，单项抛错不影响其它项（错误交给 onError）。
 * @param values 输入序列。
 * @param limit 并发上限。
 * @param worker 单项处理函数。
 * @param onError 错误回调（默认忽略，返回 undefined）。
 */
export async function mapLimit(values, limit, worker, onError) {
  const list = [...(values ?? [])]
  const results = new Array(list.length)
  const n = Math.max(1, Math.trunc(limit) || 1)
  let cursor = 0
  const runners = new Array(Math.min(n, list.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= list.length) return
      try {
        results[index] = await worker(list[index], index)
      } catch (error) {
        results[index] = undefined
        if (typeof onError === 'function') onError(error, list[index], index)
      }
    }
  })
  await Promise.all(runners)
  return results
}

/* ------------------------------------------------------------------ *
 * 标识符与分词（解析器 / RAG 共用）
 * ------------------------------------------------------------------ */

/** 把标识符切成小写词：getUserByID -> [get, user, by, id]。 */
export function splitIdentifier(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase())
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'has', 'have', 'had',
  'not', 'but', 'you', 'your', 'can', 'will', 'would', 'should', 'could', 'into', 'out', 'over',
  'then', 'than', 'them', 'they', 'their', 'there', 'here', 'when', 'where', 'which', 'while',
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'class', 'def', 'self', 'new',
  'null', 'true', 'false', 'undefined', 'public', 'private', 'static', 'void', 'string', 'number',
  'int', 'float', 'bool', 'boolean', 'type', 'value', 'name', 'args', 'kwargs',
])

export function isStopWord(word) {
  return STOP_WORDS.has(word)
}

/**
 * 通用分词：保留原文标识符的拆分形态（camelCase / snake_case 都能召回），
 * 过滤停用词与单字符。返回小写词序列（保留重复，调用方决定是否去重）。
 */
export function tokenize(text) {
  const out = []
  const matches = String(text ?? '').match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?/g) ?? []
  for (const match of matches) {
    const parts = splitIdentifier(match)
    for (const part of parts.length > 0 ? parts : [match.toLowerCase()]) {
      if (part.length < 2 || isStopWord(part)) continue
      out.push(part)
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Glob（忽略规则用；不依赖任何 glob 库）
 * ------------------------------------------------------------------ */

const GLOB_CACHE = new Map()
const REGEX_SPECIALS = new Set(['.', '+', '^', '$', '(', ')', '|', '[', ']', '{', '}', '\\'])

function escapeLiteral(char) {
  return REGEX_SPECIALS.has(char) ? `\\${char}` : char
}

/**
 * 极简 glob 编译器，支持：`**`（跨目录）、`*`（段内任意）、`?`、`{a,b}`、
 * 以及 `!` 前缀否定（由 matchAnyGlobs 处理）。
 *
 * 语义贴近 .gitignore：不含斜杠的模式匹配任意层级；`dir/` 表示目录及其内容。
 * @param pattern glob 模式。
 * @returns 匹配相对 posix 路径的正则（无 g 标志）。
 */
export function compileGlob(pattern) {
  const key = String(pattern ?? '')
  const cached = GLOB_CACHE.get(key)
  if (cached !== undefined) return cached

  let source = trimTrailingSlash(key)
  if (source.startsWith('/')) source = source.slice(1)
  const anchored = source.includes('/')

  let out = ''
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (char === '*') {
      const isDouble = source[i + 1] === '*'
      if (isDouble) {
        const followedBySlash = source[i + 2] === '/'
        out += followedBySlash ? '(?:[^/]+/)*' : '.*'
        i += followedBySlash ? 2 : 1
      } else {
        out += '[^/]*'
        i += 0
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    if (char === '{') {
      const end = source.indexOf('}', i)
      if (end > i) {
        const options = source.slice(i + 1, end).split(',').map((part) => part.trim())
        out += `(?:${options.map((part) => part.split('').map(escapeLiteral).join('')).join('|')})`
        i = end
        continue
      }
    }
    out += escapeLiteral(char)
  }

  const prefix = anchored ? '^' : '^(?:.*/)?'
  const regex = new RegExp(`${prefix}${out}(?:/.*)?$`)
  GLOB_CACHE.set(key, regex)
  return regex
}

/** 单个 glob 是否命中相对路径（自动忽略前导 `./`）。 */
export function matchGlob(pattern, relPath) {
  const target = toPosix(relPath).replace(/^\.\//, '')
  if (target.length === 0) return false
  return compileGlob(pattern).test(target)
}

/**
 * 规则列表匹配，支持 `!` 取反（后出现的规则优先，与 .gitignore 一致）。
 * @param relPath 相对 posix 路径。
 * @param patterns 模式列表。
 * @returns 最终是否忽略。
 */
export function matchIgnoreRules(relPath, patterns) {
  let ignored = false
  for (const raw of patterns ?? []) {
    const pattern = String(raw ?? '').trim()
    if (pattern.length === 0 || pattern.startsWith('#')) continue
    const negated = pattern.startsWith('!')
    const body = negated ? pattern.slice(1) : pattern
    if (body.length === 0) continue
    if (matchGlob(body, relPath)) ignored = !negated
  }
  return ignored
}

/* ------------------------------------------------------------------ *
 * 哈希与 JSON 安全
 * ------------------------------------------------------------------ */

/**
 * 内容哈希（FNV-1a 64 位，两轮不同盐），纯 JS、同步、零依赖。
 * 用途是缓存键与变更检测，不用于安全场景。
 * @param text 待哈希文本。
 * @returns 16 位十六进制串。
 */
export function hashContent(text) {
  const input = typeof text === 'string' ? text : String(text ?? '')
  const a = fnv1a(input, 0x811c9dc5)
  const b = fnv1a(input, 0x01000193)
  return `${hex8(a)}${hex8(b)}`
}

function fnv1a(text, seed) {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xffff
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function hex8(value) {
  return (value >>> 0).toString(16).padStart(8, '0')
}

/** 稳定序列化：对象键排序，便于做缓存键与快照对比。 */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value))
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key])
    return out
  }
  return value
}

/**
 * 清洗为无损 JSON：丢掉 undefined / 函数 / Symbol，NaN、Infinity 转 null，
 * 断开循环引用，Date 转 ISO 串，Uint8Array 转长度描述。
 * 宿主会校验工具返回值，任何非 JSON 值都可能导致 INVALID_TOOL_OUTPUT。
 */
export function jsonSafe(value, seen = new WeakSet()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return { bytes: value.length }
  if (value instanceof Map) {
    if (seen.has(value)) return null
    seen.add(value)
    const out = {}
    for (const [k, v] of value.entries()) {
      const clean = jsonSafe(v, seen)
      if (clean !== undefined) out[String(k)] = clean
    }
    seen.delete(value)
    return out
  }
  if (value instanceof Set) {
    const list = []
    for (const entry of value.values()) {
      const clean = jsonSafe(entry, seen)
      if (clean !== undefined) list.push(clean)
    }
    return list
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return null
    seen.add(value)
    const out = value.map((entry) => {
      const clean = jsonSafe(entry, seen)
      return clean === undefined ? null : clean
    })
    seen.delete(value)
    return out
  }
  if (type === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const out = {}
    for (const key of Object.keys(value)) {
      const clean = jsonSafe(value[key], seen)
      if (clean !== undefined) out[key] = clean
    }
    seen.delete(value)
    return out
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * 证据引用（报告与问答的统一格式）
 * ------------------------------------------------------------------ */

/**
 * 构造一条证据引用：`path:line` 或 `path#symbol`。
 * @param relPath 相对路径。
 * @param options line / symbol / note。
 */
export function cite(relPath, options = {}) {
  const path = toPosix(relPath)
  const line = Number.isFinite(options.line) ? Math.trunc(options.line) : undefined
  const symbol = options.symbol ? String(options.symbol) : undefined
  let text = path
  if (line !== undefined && line > 0) text += `:${line}`
  if (symbol) text += `#${symbol}`
  return { path, line, symbol, text: text + (options.note ? ` (${options.note})` : '') }
}

/** Mermaid 节点/标签安全文本：去掉会破坏语法的字符。 */
export function mermaidSafe(text, max = 60) {
  return clip(String(text ?? '').replace(/["`<>{}[\]()|]/g, ' ').replace(/\s+/g, ' ').trim(), max)
}
