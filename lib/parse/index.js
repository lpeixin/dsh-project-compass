/**
 * 多语言解析层入口：语言判定 + 分派 + 公共工具。
 *
 * 契约：docs/INTERNAL-CONTRACTS.md §2。
 * 硬约束：
 *   - 零外部依赖（只用 node: 与仓库内相对路径）；
 *   - 只用命名导出；
 *   - **永不抛错**：任何畸形输入都必须降级为可用的 ParsedFile，并把原因写进 notes。
 *
 * @module dsh-project-compass/parse
 */

import { normalizeText, extensionOf, toPosix, uniq, clip } from '../util.js'
import { parseJsTs } from './js-ts.js'
import { parsePython } from './python.js'
import { parseJava } from './java.js'
import { parseGeneric } from './generic.js'

/** 契约 §2 冻结的语言清单。 */
export const SUPPORTED_LANGUAGES = [
  'typescript', 'javascript', 'tsx', 'jsx', 'python', 'java', 'go', 'rust', 'c', 'cpp',
  'csharp', 'ruby', 'php', 'kotlin', 'scala', 'swift', 'shell', 'sql', 'vue', 'svelte',
  'html', 'css', 'yaml', 'json', 'markdown', 'text',
]

/** 深度解析语言（TS/JS/TSX/JSX/Python/Java）。 */
const DEEP_LANGUAGES = new Set(['typescript', 'javascript', 'tsx', 'jsx', 'python', 'java'])

/** 扩展名 → 语言。 */
const EXTENSION_LANGUAGE = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.pyi': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.sc': 'scala',
  '.swift': 'swift',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.sass': 'css',
  '.less': 'css',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.txt': 'text',
  '.log': 'text',
}

/** 无扩展名 / 特殊文件名 → 语言。 */
const BASENAME_LANGUAGE = {
  dockerfile: 'text',
  'dockerfile.dev': 'text',
  'dockerfile.prod': 'text',
  makefile: 'text',
  gnumakefile: 'text',
  'cmakelists.txt': 'text',
  rakefile: 'ruby',
  gemfile: 'ruby',
  procfile: 'text',
  license: 'text',
  notice: 'text',
  authors: 'text',
  changelog: 'markdown',
  readme: 'markdown',
  '.gitignore': 'text',
  '.gitattributes': 'text',
  '.dockerignore': 'text',
  '.npmignore': 'text',
  '.editorconfig': 'text',
  '.env': 'text',
  '.env.example': 'text',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.babelrc': 'json',
  '.eslintrc': 'json',
  '.prettierrc': 'json',
  '.stylelintrc': 'json',
  '.compassignore': 'text',
  'package.json': 'json',
  'package-lock.json': 'json',
  'requirements.txt': 'text',
  'tsconfig.json': 'json',
}

/** 是否为深度解析语言。 */
export function isDeepLanguage(language) {
  return DEEP_LANGUAGES.has(String(language ?? '').toLowerCase())
}

/**
 * 按相对路径判定语言；无法判定返回 'text'。永不抛错。
 * @param relPath 相对路径（posix 或本地分隔符均可）。
 * @returns SUPPORTED_LANGUAGES 中的一项。
 */
export function detectLanguage(relPath) {
  try {
    const posix = toPosix(relPath)
    const base = (posix.split('/').pop() ?? '').toLowerCase()
    if (base.length === 0) return 'text'

    // 1) 特殊/复合文件名优先（package.json、requirements.txt、Dockerfile…）
    const exact = BASENAME_LANGUAGE[base]
    if (exact !== undefined) return exact
    if (base.startsWith('dockerfile')) return 'text'
    if (base.startsWith('makefile')) return 'text'

    // 2) 扩展名
    const ext = extensionOf(base)
    const byExt = EXTENSION_LANGUAGE[ext]
    if (byExt !== undefined) return byExt

    // 3) 无扩展名的约定文件
    if (base === 'readme' || base === 'changelog' || base.startsWith('readme.')) return 'markdown'
    if (base.startsWith('license') || base === 'makefile') return 'text'

    return 'text'
  } catch {
    return 'text'
  }
}

/* ------------------------------------------------------------------ *
 * 各语言解析器按需引入
 * ------------------------------------------------------------------ */

const PARSERS = {
  typescript: parseJsTs,
  javascript: parseJsTs,
  tsx: parseJsTs,
  jsx: parseJsTs,
  python: parsePython,
  java: parseJava,
}

/** 空的 ParsedFile 骨架。 */
function emptyParsed(language, notes) {
  return {
    language,
    symbols: [],
    imports: [],
    calls: [],
    routes: [],
    exports: [],
    todos: [],
    notes: Array.isArray(notes) ? notes.slice() : [],
  }
}

/**
 * 统一入口：按语言分派。永不抛错。
 * @param input {relPath, content, language, fileId, moduleId}
 * @returns ParsedFile
 */
export function parseFile(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const notes = []
  const fallback = () => {
    const detected = detectLanguage(source.relPath)
    return emptyParsed(isDeepLanguage(detected) && source.language === undefined ? 'text' : detected, notes)
  }

  let language
  try {
    const declared = source.language === undefined || source.language === null ? '' : String(source.language)
    language = declared.length > 0 ? declared : detectLanguage(source.relPath)
  } catch {
    language = 'text'
  }

  if (!SUPPORTED_LANGUAGES.includes(language)) {
    notes.push(`未知语言 ${clip(language, 40)}，降级为 text`)
    language = 'text'
  }

  let content
  try {
    content = normalizeText(source.content)
  } catch (error) {
    notes.push(`内容读取失败：${clip(error && error.message ? error.message : error, 120)}`)
    content = ''
  }

  const base = { ...source, content, language, fileId: source.fileId, moduleId: source.moduleId }
  const parser = PARSERS[language]

  try {
    const parsed = parser ? parser(base) : parseGeneric(base)
    return finalize(parsed, language, notes, content, source)
  } catch (error) {
    notes.push(`解析 ${language} 失败，已降级：${clip(error && error.message ? error.message : error, 160)}`)
    return finalize(null, language, notes, content, source)
  }
}

/** 兜底归一化：无论解析器返回什么，都产出形状合法的 ParsedFile。 */
function finalize(parsed, language, notes, content, source) {
  try {
    const value = parsed !== null && typeof parsed === 'object' ? parsed : {}
    const out = {
      language: typeof value.language === 'string' && value.language.length > 0 ? value.language : language,
      symbols: Array.isArray(value.symbols) ? value.symbols : [],
      imports: Array.isArray(value.imports) ? value.imports : [],
      calls: Array.isArray(value.calls) ? value.calls : [],
      routes: Array.isArray(value.routes) ? value.routes : [],
      exports: Array.isArray(value.exports) ? value.exports : [],
      todos: Array.isArray(value.todos) ? value.todos : [],
      notes: [],
    }
    out.notes = uniq([...notes, ...(Array.isArray(value.notes) ? value.notes : [])])

    const lineCount = content.length === 0 ? 0 : content.split('\n').length
    let outOfRange = 0
    for (const symbol of out.symbols) {
      if (!symbol || typeof symbol !== 'object') continue
      if (!Number.isFinite(symbol.line)) symbol.line = 1
      if (!Number.isFinite(symbol.endLine)) symbol.endLine = symbol.line
      symbol.line = Math.max(1, Math.trunc(symbol.line))
      symbol.endLine = Math.max(symbol.line, Math.trunc(symbol.endLine))
      if (lineCount > 0 && symbol.line > lineCount) outOfRange += 1
      if (symbol.parent === undefined) symbol.parent = null
      if (symbol.signature === undefined) symbol.signature = null
      if (symbol.doc === undefined) symbol.doc = null
      if (typeof symbol.exported !== 'boolean') symbol.exported = false
    }
    if (outOfRange > 0) out.notes.push(`${outOfRange} 个符号行号超出文件行数，已按原值保留`)

    if (source && typeof source.relPath === 'string' && source.relPath.length > 0) {
      out.notes = out.notes.filter((note) => typeof note === 'string' && note.length > 0)
    }
    return out
  } catch (error) {
    return emptyParsed(language, [...notes, `结果归一化失败：${clip(error && error.message ? error.message : error, 120)}`])
  }
}

/* ------------------------------------------------------------------ *
 * 公共工具（供子解析器复用）
 * ------------------------------------------------------------------ */

const TODO_PATTERN = /(?:\/\/|#|--|\/\*|\*|<!--|;;)\s*[!]?\s*(TODO|FIXME|HACK|XXX|NOTE)\b[:：]?\s*(.*)$/gim

/**
 * 抽 TODO/FIXME/HACK/XXX/NOTE 注释（行注释与块注释行均可）。
 * 正则扫描的是原文，因此字符串里形如 TODO 的文本也可能命中——契约允许。
 * @param content 原文。
 * @returns Todo[]
 */
export function extractTodos(content) {
  const todos = []
  if (typeof content !== 'string' || content.length === 0) return todos
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]
    if (text.length === 0 || text.length > 4000) continue
    TODO_PATTERN.lastIndex = 0
    let match
    while ((match = TODO_PATTERN.exec(text)) !== null) {
      const kind = match[1].toLowerCase()
      const body = String(match[2] ?? '').replace(/[\s*]+$/, '').trim()
      todos.push({ line: index + 1, text: body.length > 0 ? clip(body, 200) : kind.toUpperCase(), kind })
      if (todos.length > 500) return todos
      if (match.index === TODO_PATTERN.lastIndex) TODO_PATTERN.lastIndex += 1
    }
  }
  return todos
}

/**
 * 用引号字符串自身遮蔽内容，保留引号本身（轻量解析器用）。
 * @param text 单行文本。
 * @param quoteChars 引号字符集合。
 * @param escape 转义字符（默认反斜杠）。
 */
export function maskQuoted(text, quoteChars = '"\'`', escape = '\\') {
  const source = typeof text === 'string' ? text : ''
  const chars = source.split('')
  const quotes = new Set(String(quoteChars).split(''))
  let current = null
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    if (current !== null) {
      if (char === escape) {
        chars[index] = ' '
        if (index + 1 < chars.length && chars[index + 1] !== '\n') {
          chars[index + 1] = ' '
          index += 1
        }
        continue
      }
      if (char === current) {
        current = null
        continue
      }
      chars[index] = ' '
      continue
    }
    if (quotes.has(char)) current = char
  }
  return chars.join('')
}

/** 一行中的前导空白宽度（Tab 记 4 列）。 */
export function indentWidth(line) {
  let width = 0
  for (const char of String(line ?? '')) {
    if (char === ' ') width += 1
    else if (char === '\t') width += 4
    else break
  }
  return width
}

/** 括号深度（不含字符串/注释，已由调用方遮蔽）。 */
export function bracketDelta(text) {
  let delta = 0
  for (const char of String(text ?? '')) {
    if (char === '(' || char === '[' || char === '{') delta += 1
    else if (char === ')' || char === ']' || char === '}') delta -= 1
  }
  return delta
}
