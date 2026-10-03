/**
 * TypeScript / JavaScript / TSX / JSX 深度解析器。
 *
 * 策略：**掩码 + 行扫描 + 花括号配平**。
 *   1. 字符级扫描一遍，把字符串 / 模板字面量 / 注释 / 正则字面量的内容替换成空格；
 *      换行符保留 → 行号不变，字符串与注释里的 `{}` 不参与配平。
 *   2. 在掩码文本上跑正则行扫描（不会误命中字符串里的关键字），
 *      signature / doc / TODO 一律回原文取。
 *   3. endLine 由花括号配平得出；JSX 的 `<div>` 不参与任何配平，天然安全
 *      （泛型 `<T>` 也只在括号配平时出现，不影响花括号）。
 *
 * 契约：docs/INTERNAL-CONTRACTS.md §2 / §3。
 * @module dsh-project-compass/parse/js-ts
 */

import { clip } from '../util.js'
import { extractTodos } from './index.js'

const IDENT = '[A-Za-z_$][\\w$]*'
const IDENT_PATH = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*'
const FALLBACK_SIGNATURE = '()'

/** 调用名黑名单：控制流/声明关键字绝不当成调用记录。 */
const CALL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch', 'finally', 'return',
  'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'yield', 'await', 'function',
  'class', 'interface', 'type', 'enum', 'namespace', 'import', 'export', 'extends', 'implements',
  'super', 'this', 'constructor', 'get', 'set', 'static', 'as', 'satisfies', 'keyof', 'infer',
  'declare', 'abstract', 'readonly', 'public', 'private', 'protected', 'with', 'debugger', 'async',
])

const MEMBER_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'case', 'try', 'finally',
  'new', 'typeof', 'function', 'class', 'const', 'let', 'var', 'export', 'import', 'super',
  'this', 'yield', 'await', 'delete', 'void', 'in', 'of', 'instanceof',
])

/* ------------------------------------------------------------------ *
 * 掩码扫描器（字符串 / 模板 / 注释 / 正则 → 空格）
 * ------------------------------------------------------------------ */

/**
 * `/` 之后是否真的像正则字面量。
 * 关键反例：JSX/HTML 的收尾标签 `</div>`、路径 `/api/users`、注释 `//`、块注释 `/*`。
 * 判据取"正则首字符"的常见集合（非字母/数字/空白），宁可漏报正则也不误吞 JSX。
 */
function looksLikeRegexStart(text, slashIndex) {
  const next = text[slashIndex + 1]
  if (next === undefined) return false
  // `//` 行注释、`/*` 块注释、`/=` 除后赋值（`out[i] /= norm`）都不是正则
  if (next === '/' || next === '*' || next === '=') return false
  if (/[\s]/.test(next)) return false
  return !/[A-Za-z0-9_$]/.test(next)
}

/** 判断 `/` 此刻是正则字面量还是除号。 */
function regexAllowedHere(previous, linePrefix) {
  if (previous === undefined || previous === '') return true
  if (/[A-Za-z0-9_$]/.test(previous)) {
    const word = /([A-Za-z_$][\w$]*)\s*$/.exec(linePrefix)
    if (!word) return true
    return /^(?:return|typeof|instanceof|in|of|new|delete|void|do|else|yield|await|case|throw)$/.test(word[1])
  }
  if (previous === ')') return false
  return true
}

/**
 * 扫描源码，产出"掩码文本"与降级说明。永不抛错。
 * @param source 已归一化换行的源码。
 * @returns {{masked: string, notes: string[]}}
 */
export function maskJsSource(source) {
  const text = typeof source === 'string' ? source : ''
  const chars = text.split('')
  const notes = []
  const warned = () => {
    if (!notes.includes('检测到未闭合的字符串或注释，已按行尾降级处理')) {
      notes.push('检测到未闭合的字符串或注释，已按行尾降级处理')
    }
  }

  /** 把第 index 个字符替换成空格（换行保留，保证行号不变）。 */
  const blank = (index) => {
    if (chars[index] !== undefined && chars[index] !== '\n') chars[index] = ' '
  }

  /**
   * 引号位置表：掩码会把引号本身也变成空格，但下游（import specifier、路由路径、
   * 装饰器实参）需要知道"某个位置是不是字符串起点"，所以单独记录。
   */
  const quotes = new Set()
  const recordQuote = (index) => {
    quotes.add(index)
  }
  /** 从 from 起跳过空白，返回引号位置（原文坐标）；不是引号则 -1。 */
  const quoteAtOrAfter = (from) => {
    let index = from
    while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1
    const char = text[index]
    return char === '"' || char === "'" || char === '`' ? index : -1
  }

  // ------------------------------------------------------------------
  // 嵌套状态机
  // ------------------------------------------------------------------
  // 单一 mode 变量无法表达"模板 → 插值表达式 → 内层模板 → 内层插值…"的嵌套，
  // 因此用栈保存每一层的返回现场。规则：
  //   - `code`（含插值表达式内部）：遇到反引号 → 进入字符串态（quote='`'），压栈；
  //   - 字符串态遇到 `${` → 进入表达式态，压栈；
  //   - 表达式态遇到配平后的 `}` → 弹栈回到模板字符串态；
  //   - 模板的收尾反引号 → 弹栈回到上一层（可能是外层表达式）。
  // 插值表达式的文本刻意**不遮蔽**（只遮蔽 `${` 与 `}`），这样 masked 与原文
  // 下标严格一致，findSpan / hasJsx 才能正确工作。
  const stack = []
  let mode = 'code' // code | line-comment | block-comment | string | regex | template-expr
  let quote = null
  let escaped = false
  let inCharClass = false
  let previous = ''
  let lineStart = 0
  // 当前插值表达式内的花括号嵌套深度（`${JSON.stringify({ k: 1 })}` 里的对象字面量）
  let exprBrace = 0

  const pushFrame = (nextMode, nextQuote) => {
    stack.push({ mode, quote, exprBrace })
    mode = nextMode
    quote = nextQuote
    escaped = false
    previous = ''
  }
  /** 弹回上一层；栈空则回到顶层 code。 */
  const popFrame = () => {
    const frame = stack.pop()
    if (frame === undefined) {
      mode = 'code'
      quote = null
      exprBrace = 0
      escaped = false
      previous = ''
      return
    }
    mode = frame.mode
    quote = frame.quote
    exprBrace = frame.exprBrace
    escaped = false
    previous = ''
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = chars[index]
    if (char === '\n') lineStart = index + 1

    if (mode === 'line-comment') {
      if (text[index] === '\n') {
        mode = 'code'
        previous = ''
        continue
      }
      blank(index)
      continue
    }

    if (mode === 'block-comment') {
      if (text[index] === '*' && text[index + 1] === '/') {
        blank(index)
        blank(index + 1)
        index += 1
        mode = 'code'
        previous = ''
        continue
      }
      blank(index)
      continue
    }

    if (mode === 'regex') {
      if (escaped) {
        escaped = false
        blank(index)
        continue
      }
      if (char === '\\') {
        escaped = true
        blank(index)
        continue
      }
      if (text[index] === '\n') {
        warned()
        mode = 'code'
        previous = ''
        continue
      }
      if (char === '[') {
        inCharClass = true
        blank(index)
        continue
      }
      if (char === ']') {
        inCharClass = false
        blank(index)
        continue
      }
      if (char === '\\') {
        // 正则里的反斜杠转义：下一个字符永远是字面量（哪怕它是引号/反引号）
        escaped = true
        blank(index)
        continue
      }
      if (char === '/' && !inCharClass) {
        blank(index)
        popFrame() // 弹回正则之前的状态（可能是插值表达式内部）
        previous = '/'
        continue
      }
      blank(index)
      continue
    }

    // 字符串态（普通引号与模板共用；模板由 quote === '`' 区分）
    if (mode === 'string') {
      if (escaped) {
        escaped = false
        blank(index)
        continue
      }
      if (char === '\\') {
        escaped = true
        blank(index)
        continue
      }
      // 模板里的字面反引号（\`）已由上面的 escaped 分支处理
      if (char === quote) {
        recordQuote(index)
        blank(index)
        popFrame() // 普通字符串弹回 code；模板弹回表达式/外层
        previous = char
        continue
      }
      if (quote !== '`' && text[index] === '\n') {
        warned()
        mode = 'code'
        quote = null
        previous = ''
        continue
      }
      // 模板插值：`${` → 进入表达式态
      if (quote === '`' && char === '$' && text[index + 1] === '{') {
        blank(index)
        blank(index + 1)
        index += 1
        pushFrame('template-expr', null)
        continue
      }
      blank(index)
      continue
    }

    // 插值表达式态：只遮蔽"配平到 0"的那个 `}`；表达式文本原样保留。
    // 对象字面量/箭头函数体里的 `{`、`}` 必须先内部配平，不能提前结束插值。
    if (mode === 'template-expr') {
      if (char === '{') {
        exprBrace += 1
        previous = char
        continue
      }
      if (char === '}') {
        if (exprBrace > 0) {
          exprBrace -= 1
          previous = char
          continue
        }
        blank(index)
        popFrame()
        previous = char
        continue
      }
    }

    // ---- code / 插值表达式内部 ---------------------------------------
    if (char === '/' && text[index + 1] === '/') {
      blank(index)
      blank(index + 1)
      index += 1
      mode = 'line-comment'
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      blank(index)
      blank(index + 1)
      index += 1
      mode = 'block-comment'
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      recordQuote(index)
      pushFrame('string', char)
      continue
    }
    if (char === '/' && regexAllowedHere(previous, text.slice(lineStart, index)) && looksLikeRegexStart(text, index)) {
      blank(index)
      pushFrame('regex', null)
      inCharClass = false
      continue
    }
    if (!/\s/.test(char)) previous = char
  }

  if (mode === 'string' || mode === 'block-comment' || mode === 'regex') warned()
  return { masked: chars.join(''), notes, quotes, quoteAtOrAfter }
}

/* ------------------------------------------------------------------ *
 * 位置 / 行号工具
 * ------------------------------------------------------------------ */

function buildLineStarts(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1)
  }
  return starts
}

function lineOf(starts, pos) {
  let low = 0
  let high = starts.length - 1
  let best = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (starts[mid] <= pos) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best + 1
}

function lineStartOffset(starts, lineNumber) {
  const index = Math.max(0, Math.min(starts.length - 1, lineNumber - 1))
  return starts[index] ?? 0
}

/** 配平查找：返回与 open 处 opener 匹配的 closer 下标。 */
function matchIndex(text, open, opener, closer) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === opener) depth += 1
    else if (char === closer) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * 求声明跨度（endLine）。花括号配平；无花括号（`const f = () => 1`）按行结束。
 * @param masked 掩码文本
 * @param start 声明起始位置（关键字之前）
 * @param starts 行首偏移表
 * @param nameAt 名字位置（用于判断 `{` 是否属于本声明）
 */
function findSpan(masked, start, starts, nameAt) {
  const line = lineOf(starts, start)
  const anchor = Number.isFinite(nameAt) ? nameAt : start
  const eol = masked.indexOf('\n', anchor)
  const lineEnd = eol === -1 ? masked.length : eol
  // 形参表里的 `{`（解构参数 `({ a }) => …`、`function f({ a })`）不是块体的开始：
  // 先把平衡的 `( … )` 跳过去，再在它之后找块体的 `{`。
  let braceFrom = anchor
  const paren = masked.indexOf('(', anchor)
  if (paren !== -1 && paren <= lineEnd) {
    const parenClose = matchIndex(masked, paren, '(', ')')
    if (parenClose !== -1) braceFrom = parenClose + 1
  }
  const brace = masked.indexOf('{', braceFrom)
  // 关键：块体的 `{` 不能越过"声明头"的终点。
  // 声明头 = 形参表右括号（若有）/ 赋值号之后的表达式起点到本行结束。
  // 否则 `const f = (a) => 1\nconst g = {` 会把下一个块体的 `{` 算到 f 头上。
  const headEnd = lineEnd
  if (brace === -1 || brace > headEnd) {
    return { line, endLine: line, bodyStart: lineEnd, bodyEnd: lineEnd }
  }
  const close = matchIndex(masked, brace, '{', '}')
  if (close === -1) {
    return { line, endLine: lineOf(starts, masked.length), bodyStart: brace + 1, bodyEnd: masked.length }
  }
  return { line, endLine: lineOf(starts, close), bodyStart: brace + 1, bodyEnd: close }
}

/** 从 from 起跳过空白，返回引号位置；不是引号则返回 -1。 */
function skipSpacesToQuote(masked, from) {
  let index = from
  while (index < masked.length && (masked[index] === ' ' || masked[index] === '\t')) index += 1
  return masked[index] === '"' || masked[index] === "'" || masked[index] === '`' ? index : -1
}

/** 读取从 quoteIndex 开始的引号字面量（原文内容），容忍未闭合。 */
function readQuoted(masked, original, quoteIndex) {
  const quote = masked[quoteIndex]
  let index = quoteIndex + 1
  let escaped = false
  let end = -1
  while (index < masked.length) {
    const char = original[index]
    if (escaped) {
      escaped = false
      index += 1
      continue
    }
    if (char === '\\') {
      escaped = true
      index += 1
      continue
    }
    if (char === quote) {
      end = index
      break
    }
    if (char === '\n' && quote !== '`') break
    index += 1
  }
  const stop = end === -1 ? original.indexOf('\n', quoteIndex) : end
  const sliceEnd = stop === -1 ? original.length : stop
  return { value: original.slice(quoteIndex + 1, sliceEnd), end: sliceEnd, closed: end !== -1 }
}

/** 提取形参括号（原文、空白归一）。 */
function readParens(original, masked, from) {
  const open = masked.indexOf('(', from)
  if (open === -1) return null
  const close = matchIndex(masked, open, '(', ')')
  if (close === -1) return null
  return { text: original.slice(open, close + 1).replace(/\s+/g, ' ').trim(), open, close }
}

/** 内联处理器的形参列表（原文、空白归一）。 */
function signatureForInlineHandler(original, masked, argsStart, braceFrom) {
  const open = masked.indexOf('(', argsStart)
  if (open === -1 || open > braceFrom) return null
  const close = matchIndex(masked, open, '(', ')')
  if (close === -1) return null
  return original.slice(open, close + 1).replace(/\s+/g, ' ').trim()
}

/** 取紧邻上方的注释首行（`/** … *\/` 或 `//`）。 */
function extractDoc(lines, lineNumber) {
  let index = lineNumber - 2
  while (index >= 0 && lines[index].trim() === '') index -= 1
  if (index < 0) return null
  const trimmed = lines[index].trim()
  if (trimmed.endsWith('*/')) {
    let start = index
    while (start >= 0 && !lines[start].trim().startsWith('/*')) start -= 1
    if (start < 0) start = index
    for (let scan = start; scan <= index; scan += 1) {
      const raw = lines[scan].trim().replace(/^\/\*\*?/, '').replace(/\*\/$/, '').replace(/^\*\s?/, '').trim()
      if (raw.length > 0 && !raw.startsWith('@')) return clip(raw, 200)
    }
    return null
  }
  if (trimmed.startsWith('//')) {
    const parts = []
    let scan = index
    while (scan >= 0 && lines[scan].trim().startsWith('//')) {
      parts.unshift(lines[scan].trim().replace(/^\/\/\s?/, ''))
      scan -= 1
    }
    const pick = parts.find((part) => part.trim().length > 0 && !part.trim().startsWith('@'))
    return pick === undefined ? null : clip(pick.trim(), 200)
  }
  return null
}

function isExported(masked, start) {
  // 只看"本行"内、且从上一个 `;`/`{`/`}` 之后的内容，避免把上一行的 export 误算进来
  const lineStart = masked.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const before = masked.slice(lineStart, start)
  return /\bexport\b[^;{}]*$/.test(before)
}

/**
 * 判断是否返回 JSX 的 React 组件。
 * 用小写标签/闭合标签/`<>` 判定，避免把 TS 泛型 `<T>` 误判成 JSX。
 */
function hasJsx(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  if (text.includes('<>') || /<\/\s*[A-Za-z]/.test(text)) return true
  return /<[a-z][\w-]*[\s/>]/.test(text) || /<[a-z][\w-]*>/.test(text)
}

/* ------------------------------------------------------------------ *
 * 路由辅助
 * ------------------------------------------------------------------ */

function normalizeRoutePath(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0 || text === '/') return '/'
  return text.startsWith('/') ? text.replace(/\/+$/, '') || '/' : `/${text}`
}

function joinRoutePath(prefix, path) {
  const left = normalizeRoutePath(prefix)
  const right = normalizeRoutePath(path)
  if (left === '/') return right
  if (right === '/') return left
  // 幂等：路径本身已经写了前缀时不再重复拼接
  if (right === left || right.startsWith(`${left}/`)) return right
  return `${left}${right}`
}

function readRouteArg(original, masked, from) {
  let index = -1
  for (const quote of ["'", '"', '`']) {
    const found = masked.indexOf(quote, from)
    if (found !== -1 && (index === -1 || found < index)) index = found
  }
  if (index === -1) return { path: '', end: from }
  const read = readQuoted(masked, original, index)
  return { path: read.value, end: read.end }
}

/** 顶层逗号切分（忽略括号与字符串内的逗号）。 */
function splitTopLevelArgs(text) {
  const parts = []
  let depth = 0
  let current = ''
  let quote = null
  let escaped = false
  for (const char of String(text ?? '')) {
    if (quote !== null) {
      current += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      current += char
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    if (char === ')' || char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim().length > 0) parts.push(current.trim())
  return parts
}

/** 解析装饰器实参（原文，去掉字符串引号）。 */
function decoratorArgs(original, masked, at, whole) {
  const openIndex = whole.indexOf('(')
  if (openIndex === -1) return []
  const open = at + openIndex
  const close = matchIndex(masked, open, '(', ')')
  if (close === -1) return []
  return splitTopLevelArgs(original.slice(open + 1, close)).map((part) => {
    const quoted = /^['"`]([\s\S]*)['"`]$/.exec(part.trim())
    return quoted ? quoted[1] : part.trim()
  })
}

/* ------------------------------------------------------------------ *
 * 主解析
 * ------------------------------------------------------------------ */

export function parseJsTs(input) {
  const content = typeof input?.content === 'string' ? input.content : ''
  const language = typeof input?.language === 'string' ? input.language : 'javascript'
  const symbols = []
  const imports = []
  const calls = []
  const routes = []
  const exportNames = new Set()

  if (content.length === 0) {
    return { language, symbols, imports, calls, routes, exports: [], todos: [], notes: [] }
  }

  const { masked, notes, quotes } = maskJsSource(content)
  const outNotes = notes.slice()
  const lines = content.split('\n')
  const maskedLines = masked.split('\n')
  const lineCount = lines.length
  const starts = buildLineStarts(masked)
  // 位置 → 行内缩进宽度（用于判定"顶层声明"）。
  // 刻意用**原文**计算：掩码把注释也变成空格，会让注释行看起来"有缩进"。
  const indentAt = new Uint16Array(masked.length + 1)
  for (let index = 0; index < lineCount; index += 1) {
    const lineStart = starts[index] ?? masked.length
    const lineText = lines[index] ?? ''
    let width = 0
    for (const char of lineText) {
      if (char === ' ') width += 1
      else if (char === '\t') width += 4
      else break
    }
    const upper = Math.min(lineStart + lineText.length, masked.length)
    for (let position = lineStart; position < upper; position += 1) indentAt[position] = width
    if (upper === masked.length) indentAt[masked.length] = width
  }

  /* ---------- 1. import / export-from / require / 动态 import ---------- */

  // 掩码会把引号与字符串内容一起换成空格；specifier 一律按"原文坐标"读取，
  // 因此这里用逐行扫描 + 引号定位，避免正则在掩码文本上跨行误吞。
  const firstQuoteAt = (from) => {
    for (let index = from; index < content.length; index += 1) {
      const char = content[index]
      if (char === '\n') return -1
      if (char === '"' || char === "'" || char === '`') return index
    }
    return -1
  }

  /** 按原文坐标读引号字面量。 */
  const quotedAtAbsolute = (quoteAt) => readQuoted(content, content, quoteAt).value

  const addImport = (specifier, line, names, kind) => {
    if (typeof specifier !== 'string' || specifier.length === 0) return
    if (kind === 'dynamic') {
      const existed = imports.find((entry) => entry.kind === 'dynamic' && entry.line === line && entry.specifier === specifier)
      if (existed) {
        if (existed.names.length === 0 && names.length > 0) existed.names = names
        return
      }
    }
    imports.push({ specifier, line, names, kind })
  }

  /** 从 import/export 子句里收集本地绑定名。 */
  const collectClauseNames = (clause) => {
    const names = []
    const brace = /\{([^}]*)\}/.exec(clause)
    if (brace) {
      for (const raw of String(brace[1]).split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim()
        if (new RegExp(`^${IDENT}$`).test(name)) names.push(name)
      }
    }
    const star = /\*\s+as\s+([\w$]+)/.exec(clause)
    if (star) names.push(star[1])
    const head = clause.replace(/\{[^}]*\}/g, ' ').replace(/\*\s+as\s+[\w$]+/g, ' ')
      .replace(/^\s*type\s+/, ' ').trim()
    const defaultName = /^([A-Za-z_$][\w$]*)/.exec(head)
    if (defaultName) names.push(defaultName[1])
    return [...new Set(names)]
  }

  const lineStarts = starts
  for (let index = 0; index < lineCount; index += 1) {
    const code = maskedLines[index] ?? ''
    const raw = lines[index] ?? ''
    if (code.trim().length === 0) continue
    const line = index + 1
    const base = lineStarts[index] ?? 0

    // 0) 动态 import('x')：必须先于静态 import 判定（`import(` 也匹配 `^import\b`）
    const importCall = /(?<![.\w$])\bimport\s*\(/.exec(code)
    if (importCall) {
      const quoteAt = firstQuoteAt(base + importCall.index)
      if (quoteAt === -1) continue
      const declared = /^\s*(?:const|let|var)\s+([\w$]+)\s*=/.exec(raw)
      addImport(quotedAtAbsolute(quoteAt), line, declared ? [declared[1]] : [], 'dynamic')
      continue
    }

    // 1) import ... from 'x' / import 'x'
    const importMatch = /^\s*import\b/.exec(code)
    if (importMatch) {
      const fromAt = code.search(/\bfrom\b/)
      const isTypeOnly = /^\s*import\s+type\b/.test(code)
      if (fromAt === -1) {
        const quoteAt = firstQuoteAt(base)
        if (quoteAt !== -1) addImport(quotedAtAbsolute(quoteAt), line, [], 'side-effect')
      } else {
        const clause = raw.slice(importMatch[0].length, fromAt).replace(/^type\s+/, ' ')
        const quoteAt = firstQuoteAt(base + fromAt + 4)
        if (quoteAt !== -1) addImport(quotedAtAbsolute(quoteAt), line, collectClauseNames(clause), 'static')
        void isTypeOnly
      }
      continue
    }

    // 2) export ... from 'x'
    if (/^\s*export\b/.test(code)) {
      const fromAt = code.search(/\bfrom\b/)
      if (fromAt === -1) continue
      const quoteAt = firstQuoteAt(base + fromAt + 4)
      if (quoteAt === -1) continue
      const head = raw.slice(0, fromAt).replace(/^\s*export\s+(?:type\s+)?/, ' ')
      addImport(quotedAtAbsolute(quoteAt), line, collectClauseNames(head), 'export-from')
      continue
    }

    // 3) require('x')（含 `const x = require('x')`）
    const requireAt = code.search(/\brequire\s*\(/)
    if (requireAt !== -1) {
      const quoteAt = firstQuoteAt(base + requireAt)
      if (quoteAt === -1) continue
      const specifier = quotedAtAbsolute(quoteAt)
      const declared = /^\s*(?:const|let|var)\s+([\w${}[\]\s,:]*?)\s*=/.exec(raw)
      const declaredBody = declared ? declared[1].trim() : ''
      const destructured = /^\{([^}]*)\}$/.exec(declaredBody)
      const names = destructured
        ? destructured[1].split(',').map((part) => part.trim().split(/[\s:]+/)[0]).filter((name) => new RegExp(`^${IDENT}$`).test(name))
        : declaredBody.length > 0 && new RegExp(`^${IDENT}$`).test(declaredBody) ? [declaredBody] : []
      addImport(specifier, line, names, 'require')
      continue
    }
  }

  /* ---------- 2. export 名单 ---------- */

  let match
  const exportDeclPattern = /(?:^|[;{}()\n])[ \t]*export\s+(?:default\s+|declare\s+|abstract\s+)?((?:async\s+)?(?:function|class|interface|enum|type|const|let|var)\b[^\n;=({]*)/gm
  while ((match = exportDeclPattern.exec(masked)) !== null) {
    const nameMatch = new RegExp(`(?:function|class|interface|enum|type|const|let|var)\\s+(${IDENT})`).exec(match[1])
    if (nameMatch) exportNames.add(nameMatch[1])
    if (/^[ \t]*export\s+default\b/.test(match[0])) exportNames.add('default')
  }
  const exportDefaultPattern = /(?:^|[;{}()\n])[ \t]*export\s+default\b/g
  while ((match = exportDefaultPattern.exec(masked)) !== null) exportNames.add('default')
  const exportListPattern = /(?:^|[;{}()\n])[ \t]*export\s*\{([^}]*)\}/g
  while ((match = exportListPattern.exec(masked)) !== null) {
    for (const raw of String(match[1]).split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim()
      if (new RegExp(`^${IDENT}$`).test(name)) exportNames.add(name)
    }
  }
  const exportEqualsPattern = /(?:^|[;{}\n])[ \t]*(?:module\.)?exports(?:\.([\w$]+))?\s*=/g
  while ((match = exportEqualsPattern.exec(masked)) !== null) {
    if (match[1]) exportNames.add(match[1])
    else exportNames.add('default')
  }

  /* ---------- 3. 顶层符号 ---------- */

  const declarations = []
  const pushVarNames = (body, at) => {
    const cleaned = String(body ?? '').trim()
    if (cleaned.length === 0) return false
    const brace = /^\{([^}]*)\}/.exec(cleaned)
    const bracket = /^\[([^\]]*)\]/.exec(cleaned)
    if (brace || bracket) {
      for (const raw of (brace ? brace[1] : bracket[1]).split(',')) {
        const name = raw.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim()
        if (new RegExp(`^${IDENT}$`).test(name)) declarations.push({ name, kind: 'const', at })
      }
      return false
    }
    const name = cleaned.split(/[=,:]/)[0].trim()
    if (!new RegExp(`^${IDENT}$`).test(name)) return false
    declarations.push({ name, kind: 'const', at })
    return true
  }

  const atTopLevel = (index) => (indentAt[Math.max(0, Math.min(indentAt.length - 1, index))] ?? 0) === 0

  const varPattern = /(?:^|[;{}()\n])[ \t]*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([\w${}[\]\s,:]+?)\s*=/g
  while ((match = varPattern.exec(masked)) !== null) {
    // 契约只要求"顶层" const/let/var；缩进内（函数体/类体）的声明由所属符号表达。
    // 花括号内嵌的写法（`switch (x) { case 1: const a = …`）也一并排除。
    if (!atTopLevel(match.index)) continue
    if (match[0].includes('{')) continue
    const body = match[1]
    const at = match.index + match[0].indexOf(body)
    const isSimple = pushVarNames(body, at)
    if (!isSimple) continue
    // `const f = () => {}` / `const f = async (x) => {}` / `const f = function () {}`
    const after = masked.slice(match.index + match[0].length, match.index + match[0].length + 400)
    const arrow = /^\s*(async\s+)?(?:function\s*\*?\s*[\w$]*\s*)?\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?::[^=;]{0,160}?)?=>/.exec(after)
    if (!arrow) continue
    const name = declarations[declarations.length - 1].name
    declarations.pop()
    declarations.push({
      name,
      kind: 'function',
      at,
      async: Boolean(arrow[1]),
      span: findSpan(masked, match.index + match[0].length, starts, at),
      signature: `(${arrow[2].replace(/\s+/g, ' ').trim()})`,
    })
  }

  const fnPattern = /(?:^|[;{}()\n])[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(async\s+)?function\s*\*?\s*([\w$]+)/g
  while ((match = fnPattern.exec(masked)) !== null) {
    const name = match[2]
    const at = match.index + match[0].indexOf(name)
    declarations.push({
      name,
      kind: 'function',
      at,
      async: Boolean(match[1]),
      span: findSpan(masked, match.index, starts, at),
      signature: readParens(content, masked, at)?.text ?? FALLBACK_SIGNATURE,
    })
  }

  const classPattern = /(?:^|[;{}()\n])[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([\w$]+)/g
  while ((match = classPattern.exec(masked)) !== null) {
    const name = match[1]
    const at = match.index + match[0].indexOf(name)
    declarations.push({ name, kind: 'class', at, span: findSpan(masked, match.index, starts, at), signature: null })
  }

  const interfacePattern = /(?:^|[;{}()\n])[ \t]*(?:export\s+)?(?:declare\s+)?interface\s+([\w$]+)/g
  while ((match = interfacePattern.exec(masked)) !== null) {
    const name = match[1]
    const at = match.index + match[0].indexOf(name)
    declarations.push({ name, kind: 'interface', at, span: findSpan(masked, match.index, starts, at), signature: null })
  }

  const typePattern = /(?:^|[;{}()\n])[ \t]*(?:export\s+)?(?:declare\s+)?type\s+([\w$]+)\s*[<=]/g
  while ((match = typePattern.exec(masked)) !== null) {
    const name = match[1]
    const at = match.index + match[0].indexOf(name)
    declarations.push({ name, kind: 'type', at, span: findSpan(masked, match.index, starts, at), signature: null })
  }

  const enumPattern = /(?:^|[;{}()\n])[ \t]*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([\w$]+)/g
  while ((match = enumPattern.exec(masked)) !== null) {
    const name = match[1]
    const at = match.index + match[0].indexOf(name)
    declarations.push({ name, kind: 'enum', at, span: findSpan(masked, match.index, starts, at), signature: null })
  }

  const seen = new Set()
  const ordered = declarations
    .filter((declaration) => {
      if (!declaration.name || !Number.isFinite(declaration.at)) return false
      const key = `${declaration.name}@${declaration.at}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.at - b.at)

  /** 包含某位置的最近符号（parent 判定）。 */
  const findOwner = (at) => {
    let best = null
    for (const symbol of symbols) {
      if (!symbol.__span) continue
      if (symbol.__span.bodyStart <= at && at <= symbol.__span.bodyEnd) {
        if (best === null || symbol.__span.bodyStart >= best.__span.bodyStart) best = symbol
      }
    }
    return best
  }

  for (const declaration of ordered) {
    const span = declaration.span ?? findSpan(masked, declaration.at, starts, declaration.at)
    const line = lineOf(starts, declaration.at)
    const parent = findOwner(declaration.at)
    const jsx = declaration.kind === 'function' && hasJsx(masked.slice(span.bodyStart, span.bodyEnd))
    symbols.push({
      name: declaration.name,
      kind: jsx ? 'component' : declaration.kind,
      line,
      endLine: span.endLine,
      exported: isExported(masked, declaration.at) || exportNames.has(declaration.name),
      parent: parent ? parent.name : null,
      signature: declaration.signature ?? null,
      doc: extractDoc(lines, line),
      __span: span,
    })
  }

  /* ---------- 4. 类成员 ---------- */

  for (const owner of symbols.filter((symbol) => symbol.kind === 'class')) {
    const span = owner.__span
    if (!span) continue
    const first = owner.line + 1
    const last = Math.min(span.endLine - 1, lineCount)
    for (let lineNumber = first; lineNumber <= last; lineNumber += 1) {
      const code = maskedLines[lineNumber - 1] ?? ''
      if (code.trim().length === 0) continue
      const member = /^\s*(?:(?:static|async|get|set|public|private|protected|readonly|declare|override|abstract|accessor)\s+)*([A-Za-z_$#][\w$]*)\s*(\(|=(?!=)|\{|;)/.exec(code)
      if (!member) continue
      const name = member[1]
      if (MEMBER_KEYWORDS.has(name)) continue
      const isMethod = member[2] === '('
      if (!isMethod && member[2] !== '=') continue
      if (!isMethod && /^#/.test(name)) continue
      const offset = lineStartOffset(starts, lineNumber)
      const memberSpan = findSpan(masked, offset, starts, offset + member[0].indexOf(name))
      // 非成员声明（方法体/字段初始化器里的局部变量）由外层符号 `__span` 覆盖
      const foreign = symbols.some((symbol) =>
        symbol !== owner && !symbol.__classMember && symbol.__span &&
        symbol.__span.bodyStart <= offset && offset <= symbol.__span.bodyEnd)
      if (foreign) continue

      let kind = 'method'
      let signature = null
      if (isMethod) {
        const parenAt = offset + member[0].length - 1
        signature = readParens(content, masked, parenAt)?.text ?? null
      } else {
        kind = 'variable'
        const tail = code.slice(member[0].length)
        const arrow = /=\s*(async\s+)?(?:\(([^()]*)\)|([\w$]+))\s*(?::[^=]{0,160}?)?=>/.exec(tail)
        if (arrow) signature = arrow[2] !== undefined ? `(${arrow[2]})` : `(${arrow[3] ?? ''})`
      }

      const jsx = hasJsx(masked.slice(memberSpan.bodyStart, memberSpan.bodyEnd))
      const isComponent = /^[A-Z]/.test(name) && jsx
      symbols.push({
        name,
        kind: isComponent ? 'component' : kind,
        line: lineNumber,
        endLine: memberSpan.endLine,
        exported: false,
        parent: owner.name,
        signature,
        doc: extractDoc(lines, lineNumber),
        __span: memberSpan,
        __classMember: true,
      })
    }
  }

  /* ---------- 5. 调用 ---------- */

  const raw = []
  // 声明头里的名字（`function foo(` / `class Foo(` / `interface X(`）不是调用
  const declarationNames = new Set(symbols.map((symbol) => symbol.name))
  /**
   * 该位置是否处在"声明头"里（`function foo(` / `class Foo(` / `const f = (`）。
   * 判据：`(` 之前只隔空白，且更前一个字符是关键字字母或 `=`/`.`。
   * 注意不能用 `/^\s*keyword\s*$/`：`\s` 会吃掉前面的空格，把 `return foo(` 误判成声明。
   */
  const isDeclarationHead = (text, calleeStart) => {
    const prev = text[calleeStart - 1]
    if (prev !== undefined && prev !== ' ' && prev !== '\t') return false
    // 注意：`return` / `new` / `await` 不能放进关键字表！
    // `return this.db.find(` 里 `find` 前面是空格，若不排除会连同 `return ` 一起匹配上。
    // 它们各自的语义已在调用方用 `\bnew\s*$` / `\bawait\s*$` 单独处理。
    // 同理 `new` / `await` 也不能放进来（`new Store(` 里 `Store` 前是空格）
    return /(?:function|class|interface|enum|type|if|for|while|switch|catch|typeof|in|of|do|else|case|throw|delete|void|[=\[])\s*$/.test(text.slice(0, calleeStart))
  }

  /** `(` 是否是箭头函数的形参表（右侧紧接 `=>`）？ */
  const isArrowParameterList = (text, openIndex) => {
    let index = openIndex
    let depth = 0
    for (; index < text.length; index += 1) {
      if (text[index] === '(') depth += 1
      else if (text[index] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (depth !== 0) return false
    return /^\s*=>/.test(text.slice(index + 1))
  }

  /** 覆盖 `(` 左侧的标识符路径；紧随 `.` 或标识符字符者说明它就是被调用者。 */
  const calleeBefore = (text, openIndex) => {
    let index = openIndex
    while (index > 0 && (text[index - 1] === ' ' || text[index - 1] === '\t')) index -= 1
    const end = index
    while (index > 0 && /[\w$.]/.test(text[index - 1])) index -= 1
    // 起点正是 `.` 时（如 `.then(`）跳过去，避免把前一个调用的收尾 `)` 吃掉
    if (text[index] === '.') index += 1
    const raw = text.slice(index, end)
    if (raw.length === 0) return null
    if (/^[\d.]/.test(raw)) return null // 数字字面量/半个小数点，不是标识符
    // 前面是标识符字符 → 说明匹配点落在一个更大的 token 中间（如 `afoo(`），放弃。
    if (index > 0 && /[A-Za-z0-9_$]/.test(text[index - 1])) return null
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(raw)) return null
    return { full: raw, start: index }
  }

  const pushCall = (fullName, at, kind) => {
    const full = String(fullName ?? '')
    if (full.length === 0) return
    const parts = full.split('.')
    const name = parts[parts.length - 1]
    if (CALL_KEYWORDS.has(name)) return
    // 声明头（`function foo(`）里的名字不算调用；注意不能把 `new Foo(` 也算进来
    const before = masked.slice(Math.max(0, at - 40), at)
    if (parts.length === 1 && declarationNames.has(name) &&
      /(?:\bfunction|\bclass|\binterface|\btype|\benum)\s*\*?\s*$/.test(before)) return
    const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : null
    raw.push({ calleeName: name, line: lineOf(starts, at), kind, receiver, at })
  }

  for (let index = 0; index < lineCount; index += 1) {
    const text = maskedLines[index]
    if (text.length === 0 || text.length > 8000) continue
    const offset = lineStartOffset(starts, index + 1)
    for (let position = 0; position < text.length; position += 1) {
      if (text[position] !== '(') continue
      const callee = calleeBefore(text, position)
      if (!callee) continue
      const before = text.slice(Math.max(0, callee.start - 16), callee.start)
      if (/\bnew\s*$/.test(before)) {
        pushCall(callee.full, offset + callee.start, 'new')
      } else if (/\bawait\s*$/.test(before)) {
        pushCall(callee.full, offset + callee.start, 'await')
      } else if (isDeclarationHead(text, callee.start)) {
        continue
      } else if (isArrowParameterList(text, position)) {
        // 形参表（`(a, b) => …`），不是调用
        continue
      } else {
        pushCall(callee.full, offset + callee.start, 'call')
      }
    }
  }

  const callSeen = new Set()
  for (const record of raw) {
    const key = `${record.line}:${record.calleeName}:${record.kind}`
    if (callSeen.has(key)) continue
    callSeen.add(key)
    const owner = findOwner(record.at)
    calls.push({
      calleeName: record.calleeName,
      line: record.line,
      fromSymbolName: owner && owner.kind !== 'class' ? owner.name : null,
      kind: record.kind,
      ...(record.receiver ? { receiver: record.receiver } : {}),
    })
  }
  calls.sort((a, b) => a.line - b.line || a.calleeName.localeCompare(b.calleeName))

  /* ---------- 6. 路由 ---------- */

  const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head', 'route', 'use'])
  /** 明显不是路由对象的接收者（Map / 配置 / 缓存 …）。 */
  const NON_ROUTE_RECEIVER = /^(?:cache|caches|map|maps|dict|config|configs|settings|setting|store|storage|env|envs|headers|params|query|options|opts|props|state|registry|routePrefix|prefix|path|paths|url|urls|key|keys|value|values)$/i
  /** 名字里带这些词的一律当作路由对象（`this.router`、`r`、`fastify` …）。 */
  const ROUTE_RECEIVER = /(?:router|route|app|server|api|controller|fastify|nest|koa|express|r)$/i

  /**
   * 路由路径：第一个实参必须是字符串/模板字面量，且以 `/`、`:`、`*` 开头（允许空串 = 根路径）。
   * 注意读**原文**：掩码会把引号与内容一起替换成空格。
   */
  const isRoutePathLiteral = (from) => {
    let quoteAt = from
    while (quoteAt < content.length && (content[quoteAt] === ' ' || content[quoteAt] === '\t')) quoteAt += 1
    const quote = content[quoteAt]
    if (quote !== '"' && quote !== "'" && quote !== '`') return null
    const read = readQuoted(content, content, quoteAt)
    if (!read.closed) return null
    const value = read.value
    if (!/^[/:*]/.test(value) && value.length > 0) return null
    return { path: value, end: read.end }
  }

  /** 除路径外至少一个"像处理器"的实参：标识符 / 箭头函数 / function / [a, b]。 */
  const looksLikeHandler = (arg) => {
    const text = String(arg ?? '').trim()
    if (text.length === 0) return false
    if (/^['"`]/.test(text)) return false
    if (text.includes('=>') || /\bfunction\b/.test(text) || /\basync\b/.test(text)) return true
    if (/^\[[^\]]*\]$/.test(text)) return true
    return new RegExp(`^${IDENT_PATH}$`).test(text)
  }

  /** 该实参是否为内联函数/箭头函数（含 `async (req, res) => {}`、`function (req) {}`）。 */
  const isInlineHandler = (arg) => {
    const text = String(arg ?? '')
    return text.includes('=>') || /\bfunction\b/.test(text)
  }

  const usedHandlerNames = new Set()
  /** route-handler 符号名；重名时补行号保证唯一。 */
  const routeHandlerName = (base, line) => {
    const name = usedHandlerNames.has(base) ? `${base}@${line}` : base
    usedHandlerNames.add(name)
    return name
  }

  /**
   * 把内联处理器提升为 `kind: 'route-handler'` 符号，返回符号名。
   * 符号行 = 箭头/`function` 关键字所在行，endLine = 函数体右花括号所在行。
   */
  const promoteInlineHandler = ({ arg, method, path, line, argsStart, nameAt }) => {
    const text = String(arg ?? '')
    const arrowAt = text.indexOf('=>')
    const fnAt = text.search(/\bfunction\b/)
    const bodyOffset = arrowAt !== -1 ? arrowAt + 2 : fnAt
    const bodyStart = argsStart + (bodyOffset === -1 ? 0 : bodyOffset)
    const braceFrom = masked.indexOf('{', bodyStart)
    if (braceFrom === -1) return null
    const close = matchIndex(masked, braceFrom, '{', '}')
    const endLine = close === -1 ? lineOf(starts, masked.length) : lineOf(starts, close)
    const handlerLine = lineOf(starts, argsStart)
    symbols.push({
      name: nameAt,
      kind: 'route-handler',
      line: handlerLine,
      endLine,
      exported: false,
      parent: null,
      signature: signatureForInlineHandler(content, masked, argsStart, braceFrom),
      doc: extractDoc(lines, handlerLine),
      __span: { line: handlerLine, endLine, bodyStart: braceFrom + 1, bodyEnd: close === -1 ? masked.length : close },
      __inline: true,
      __method: method,
      __path: path,
    })
    return nameAt
  }

  /**
   * 扫描一遍全部候选路由表达式（`router.route()` 前缀也在此登记）。
   * 返回数组便于调用方按需处理（内联处理器提升 / 生成 RawRoute）。
   */
  const scanRouteExpressions = () => {
    const routePrefix = new Map()
    const found = []
    const pattern = /(?:^|[^.\w$])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*(get|post|put|patch|delete|all|options|head|route|use)\s*\(/g
    let entry
    while ((entry = pattern.exec(masked)) !== null) {
      const object = entry[1]
      // 接收者按最后一段判定：`this.router` → `router`，`cache` → `cache`
      const receiverName = object.split('.').pop()
      const method = entry[2]
      if (!ROUTE_METHODS.has(method)) continue
      // 接收者判定：
      //   - 名字明显是 Map/缓存/配置 → 一律拒绝（`cache.get('/x')`、`config.get('/y', fb)`）；
      //   - 名字带路由语义（app/router/fastify/koa/…）→ 接受；
      //   - `this` / 单字母（`r.get` 常见约定）→ 保守接受，靠后面的路径+处理器校验兜底。
      if (NON_ROUTE_RECEIVER.test(receiverName)) continue
      if (!ROUTE_RECEIVER.test(receiverName) && receiverName !== 'this' && receiverName.length > 2) continue
      const at = entry.index + entry[0].indexOf(object)
      const line = lineOf(starts, at)
      const argsStart = entry.index + entry[0].length

      const openParen = masked.indexOf('(', entry.index + entry[0].length - 1)
      const closeParen = openParen === -1 ? -1 : matchIndex(masked, openParen, '(', ')')
      // 从原文切分：掩码把字符串内容变空格后，字符串里的 `,`/`(` 会与分隔符混淆
      const argText = closeParen === -1 ? '' : content.slice(openParen + 1, closeParen)
      const args = splitTopLevelArgs(argText)

      if (method === 'route') {
        // `router.route('/x')` 只登记前缀；`routePrefix.get(object)` 这类没有路径实参的直接跳过
        const literal = isRoutePathLiteral(argsStart)
        if (literal) routePrefix.set(object, literal.path)
        continue
      }

      // 1) 路径实参校验对**所有**方法生效（这是 `Map.get` 误报的根因）
      const literal = isRoutePathLiteral(argsStart)
      if (!literal) continue

      // 2) 除路径外必须至少有一个"像处理器"的实参
      const rest = args.slice(1).filter((arg) => !/^['"`]/.test(arg) && !/^\{/.test(arg))
      if (rest.length === 0) continue
      if (!rest.some(looksLikeHandler)) continue

      found.push({
        object,
        method,
        line,
        argsStart,
        args,
        rest,
        path: normalizeRoutePath(joinRoutePath(routePrefix.get(object) ?? '', literal.path)),
      })
    }
    return found
  }

  /** 文件里出现了 koa 依赖时，无法从接收者名判定的路由按 koa 记账。 */
  const koaFile = /(?:^|[/'"])(?:koa|@koa\/router)(?:['"]|$)/m.test(content)

  /** 内联处理器位置 → 提升后的符号名。 */
  const inlineHandlers = new Map()
  const routeCandidates = scanRouteExpressions()
  // 先提升内联处理器，让 route-handler 的 `__span` 在"调用归属"之前就绪
  for (const candidate of routeCandidates) {
    const lastArg = candidate.rest[candidate.rest.length - 1]
    if (!isInlineHandler(lastArg)) continue
    const nameAt = routeHandlerName(`${candidate.method.toUpperCase()} ${candidate.path} handler`, candidate.line)
    const promoted = promoteInlineHandler({
      arg: lastArg,
      method: candidate.method.toUpperCase(),
      path: candidate.path,
      line: candidate.line,
      argsStart: candidate.argsStart,
      nameAt,
    })
    if (promoted) inlineHandlers.set(candidate.argsStart, promoted)
  }

  // 再生成 RawRoute（命名处理器保持原行为，内联处理器用提升后的符号名）
  for (const candidate of routeCandidates) {
    const middlewares = []
    for (const arg of candidate.rest.slice(0, -1)) {
      const one = new RegExp(`${IDENT}$`).exec(String(arg).trim())
      if (one) middlewares.push(one[0])
    }
    const lastArg = candidate.rest[candidate.rest.length - 1]
    let handler = inlineHandlers.get(candidate.argsStart) ?? null
    if (handler === null && !isInlineHandler(lastArg)) {
      const found = new RegExp(`^${IDENT_PATH}$`).exec(String(lastArg).trim())
      handler = found ? found[0] : null
    }
    const framework = candidate.object === 'fastify'
      ? 'fastify'
      : /koa/i.test(candidate.object) || koaFile
        ? 'koa'
        : 'express'
    routes.push({
      method: candidate.method.toUpperCase(),
      path: candidate.path,
      line: candidate.line,
      handlerName: handler,
      framework,
      ...(middlewares.length > 0 ? { middlewares } : {}),
    })
  }

  // NestJS 装饰器路由：方法装饰器紧跟其后的方法名
  const decorators = []
  const decoratorPattern = /@([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g
  while ((match = decoratorPattern.exec(masked)) !== null) {
    if (!/^(Get|Post|Put|Patch|Delete|Options|Head|All|Controller|RequestMapping)$/.test(match[1])) continue
    decorators.push({
      name: match[1],
      args: decoratorArgs(content, masked, match.index, match[0]),
      line: lineOf(starts, match.index),
    })
  }
  const nestPrefix = decorators.find((entry) => entry.name === 'Controller')?.args[0] ?? ''
  for (const decorator of decorators) {
    if (decorator.name === 'Controller') continue
    let targetLine = null
    let handlerName = null
    for (let scan = decorator.line; scan <= Math.min(lineCount, decorator.line + 8); scan += 1) {
      const code = maskedLines[scan - 1] ?? ''
      const found = new RegExp(`^\\s*(?:(?:public|private|protected|static|async|readonly|abstract|override)\\s+)*([A-Za-z_$][\\w$]*)\\s*\\(`).exec(code)
      if (found && !MEMBER_KEYWORDS.has(found[1]) && found[1] !== 'constructor') {
        targetLine = scan
        handlerName = found[1]
        break
      }
    }
    if (targetLine === null) continue
    const method = decorator.name === 'RequestMapping'
      ? String(decorator.args[1] ?? 'GET').toUpperCase()
      : decorator.name.toUpperCase()
    routes.push({
      method,
      path: normalizeRoutePath(joinRoutePath(nestPrefix, decorator.args[0] ?? '')),
      line: targetLine,
      handlerName,
      framework: 'nestjs',
    })
  }

  /* ---------- 7. 收尾 ---------- */

  // 清掉落在函数/方法体内的局部变量符号（顶层 const/let/var 的定位算法会顺带命中它们）
  const scopes = symbols.filter((symbol) =>
    symbol.__span && (symbol.kind === 'function' || symbol.kind === 'component' ||
      symbol.kind === 'method' || symbol.kind === 'route-handler'))
  const kept = symbols.filter((symbol) => {
    if (symbol.__classMember) return true
    if (symbol.kind !== 'const' && symbol.kind !== 'variable') return true
    return !scopes.some((scope) => scope.__span.bodyStart <= lineStartOffset(starts, symbol.line) && lineStartOffset(starts, symbol.line) <= scope.__span.bodyEnd)
  })

  // 内联处理器是后于调用扫描产生的，这里按"位置落在 route-handler 块内"兜底挂接
  const handlerScopes = symbols.filter((symbol) => symbol.kind === 'route-handler' && symbol.__span)
  if (handlerScopes.length > 0) {
    for (const call of calls) {
      if (call.fromSymbolName !== null) continue
      const at = lineStartOffset(starts, call.line)
      const owner = handlerScopes.find((scope) => scope.__span.bodyStart <= at && at <= scope.__span.bodyEnd)
      if (owner) call.fromSymbolName = owner.name
    }
  }

  for (const symbol of kept) {
    if (symbol.exported) exportNames.add(symbol.name)
    delete symbol.__span
    delete symbol.__classMember
  }

  const result = {
    language,
    symbols: dedupeSymbols(kept).slice(0, 4000),
    imports: dedupeImports(imports),
    calls: calls.slice(0, 6000),
    routes: dedupeRoutes(routes),
    exports: [...exportNames].filter((name) => typeof name === 'string' && name.length > 0),
    todos: extractTodos(content),
    notes: outNotes,
  }
  if (kept.length > 4000) outNotes.push('符号数量超过 4000，已截断')
  return result
}

/* ------------------------------------------------------------------ *
 * 去重
 * ------------------------------------------------------------------ */

function dedupeSymbols(symbols) {
  const seen = new Set()
  const out = []
  for (const symbol of symbols) {
    const key = `${symbol.name}@${symbol.line}:${symbol.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(symbol)
  }
  return out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
}

function dedupeImports(imports) {
  const seen = new Set()
  const out = []
  for (const entry of imports) {
    const key = `${entry.line}:${entry.kind}:${entry.specifier}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out.sort((a, b) => a.line - b.line)
}

function dedupeRoutes(routes) {
  const seen = new Set()
  const out = []
  for (const route of routes) {
    const key = `${route.method} ${route.path} ${route.line}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(route)
  }
  return out.sort((a, b) => a.line - b.line || a.path.localeCompare(b.path))
}
