/**
 * 通用轻量解析器：覆盖 go / rust / c / cpp / csharp / ruby / php / kotlin / scala / swift /
 * shell / sql / vue / svelte / html / css / yaml / json / markdown / text。
 *
 * 设计：**块级符号 + 逐行扫描**。产出与深度语言同构（字段完全一致），允许 symbols 稀疏；
 * 数据/文档类语言返回 `symbols: []` 也不算失败。
 *
 * 契约：docs/INTERNAL-CONTRACTS.md §2 / §3。
 * @module dsh-project-compass/parse/generic
 */

import { clip } from '../util.js'
import { extractTodos, maskQuoted, indentWidth } from './index.js'

/** 调用名黑名单（跨语言取并集：宁可少报，不可错报）。 */
const CALL_KEYWORDS = new Set([
  'if', 'elif', 'else', 'elseif', 'elsif', 'for', 'foreach', 'while', 'switch', 'case', 'catch',
  'finally', 'return', 'new', 'delete', 'throw', 'try', 'do', 'end', 'then', 'begin', 'fn',
  'func', 'function', 'def', 'class', 'struct', 'enum', 'interface', 'type', 'var', 'let',
  'const', 'val', 'using', 'import', 'package', 'require', 'include', 'match', 'select', 'when',
  'unless', 'until', 'loop', 'guard', 'super', 'this', 'self', 'sizeof', 'typeof', 'instanceof',
  'and', 'or', 'not', 'in', 'is', 'print', 'printf', 'println', 'puts', 'echo', 'assert',
  'panic', 'recover', 'defer', 'go', 'fn', 'pub', 'mod', 'impl', 'trait', 'where', 'move',
  'ref', 'mut', 'dyn', 'async', 'await', 'with', 'as', 'get', 'set', 'init',
])

/** 定义/声明关键字：这些名字后跟 `(` 不算调用。 */
const DECL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'func', 'fn', 'def', 'sub',
  'class', 'struct', 'enum', 'interface', 'new', 'delete', 'typeof', 'sizeof', 'include',
  'require', 'import', 'using', 'package', 'module', 'case', 'when', 'unless', 'until', 'do',
  'then', 'match', 'guard', 'and', 'or', 'not', 'assert', 'raise', 'throw', 'if', 'else',
])

/* ------------------------------------------------------------------ *
 * 各语言的符号模式（按顺序匹配，命中即停）
 * ------------------------------------------------------------------ */

const SYMBOL_PATTERNS = {
  go: [
    { pattern: /^\s*func\s+\(\s*[\w*]*\s*\*?[\w]+\s*\)\s*([A-Za-z_]\w*)/, kind: 'method', group: 1 },
    { pattern: /^\s*func\s+([A-Za-z_]\w*)/, kind: 'function', group: 1 },
    { pattern: /^\s*type\s+([A-Za-z_]\w*)\s+struct\b/, kind: 'class', group: 1 },
    { pattern: /^\s*type\s+([A-Za-z_]\w*)\s+interface\b/, kind: 'interface', group: 1 },
    { pattern: /^\s*type\s+([A-Za-z_]\w*)\s+/, kind: 'type', group: 1 },
    { pattern: /^\s*(?:var|const)\s+([A-Za-z_]\w*)/, kind: 'const', group: 1 },
  ],
  rust: [
    { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)\s*(?![=:])/, kind: 'function', group: 1 },
    { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum', group: 1 },
    { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'interface', group: 1 },
    { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, kind: 'type', group: 1 },
    { pattern: /^\s*impl(?:<[^>]*>)?\s+\w+\s+for\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*(?:pub\s+)?const\s+([A-Za-z_]\w*)/, kind: 'const', group: 1 },
    { pattern: /^\s*(?:pub\s+)?static\s+([A-Za-z_]\w*)/, kind: 'variable', group: 1 },
  ],
  c: [
    { pattern: /^\s*(?:static\s+|inline\s+|extern\s+|const\s+|unsigned\s+|signed\s+|struct\s+|enum\s+)*[A-Za-z_]\w*\s*\**\s*([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/, kind: 'function', group: 1 },
    { pattern: /^\s*typedef\s+struct\s+(?:[A-Za-z_]\w*\s*)?\{/, kind: null },
    { pattern: /^\s*(?:typedef\s+)?(?:struct|union|enum)\s+([A-Za-z_]\w*)\s*\{/, kind: 'class', group: 1 },
    { pattern: /^\s*#\s*define\s+([A-Za-z_]\w*)/, kind: 'const', group: 1 },
  ],
  cpp: [
    { pattern: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*namespace\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*(?:virtual\s+|static\s+|inline\s+|explicit\s+|constexpr\s+|const\s+)*[A-Za-z_][\w:<>,\s*&]*?\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/, kind: 'function', group: 1 },
    { pattern: /^\s*using\s+([A-Za-z_]\w*)\s*=/, kind: 'type', group: 1 },
  ],
  csharp: [
    { pattern: /^\s*(?:(?:public|private|protected|internal|static|partial|sealed|abstract|readonly|override|virtual|async|unsafe|new)\s+)*(?:class|struct|record)\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*(?:(?:public|private|protected|internal|static|partial|sealed|abstract)\s+)*interface\s+([A-Za-z_]\w*)/, kind: 'interface', group: 1 },
    { pattern: /^\s*(?:(?:public|private|protected|internal|static|sealed)\s+)*enum\s+([A-Za-z_]\w*)/, kind: 'enum', group: 1 },
    { pattern: /^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|partial|extern|unsafe|new)\s+)+[A-Za-z_][\w<>\[\],.?]*\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{?/, kind: 'method', group: 1 },
    { pattern: /^\s*(?:(?:public|private|protected|internal|static|const|readonly)\s+)+[A-Za-z_][\w<>\[\],.?]*\s+([A-Za-z_]\w*)\s*(?:=[^=]|;)/, kind: 'variable', group: 1 },
  ],
  ruby: [
    { pattern: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, kind: 'method', group: 1 },
    { pattern: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*module\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*([A-Z][A-Z0-9_]*)\s*=/, kind: 'const', group: 1 },
  ],
  php: [
    { pattern: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?\s*([A-Za-z_]\w*)/, kind: 'function', group: 1 },
    { pattern: /^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|trait)\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*interface\s+([A-Za-z_]\w*)/, kind: 'interface', group: 1 },
    { pattern: /^\s*const\s+([A-Za-z_]\w*)/, kind: 'const', group: 1 },
    { pattern: /^\s*define\s*\(\s*['"]([A-Za-z_]\w*)['"]/, kind: 'const', group: 1 },
  ],
  kotlin: [
    { pattern: /^\s*(?:(?:public|private|internal|protected|open|abstract|sealed|data|enum|annotation|inner|value|suspend|inline|operator|override|tailrec|external)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*(?:(?:public|private|internal|protected|open|abstract|suspend|inline|operator|override|tailrec|external)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.<>?]+\.)?([A-Za-z_]\w*)\s*\(/, kind: 'function', group: 1 },
    { pattern: /^\s*(?:val|var)\s+([A-Za-z_]\w*)/, kind: 'variable', group: 1 },
  ],
  scala: [
    { pattern: /^\s*(?:(?:private|protected|final|sealed|abstract|implicit|lazy|case)\s+)*(?:class|trait|object)\s+([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*(?:(?:private|protected|override|final|implicit|lazy)\s+)*def\s+([A-Za-z_]\w*)/, kind: 'function', group: 1 },
    { pattern: /^\s*(?:val|var)\s+([A-Za-z_]\w*)/, kind: 'variable', group: 1 },
  ],
  swift: [
    { pattern: /^\s*(?:(?:public|private|internal|fileprivate|open|final|static)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+(?!(?:func|var|let|subscript|static|class)\b)([A-Za-z_]\w*)/, kind: 'class', group: 1 },
    { pattern: /^\s*(?:(?:public|private|internal|fileprivate|open|static|override|final|mutating|class|nonisolated)\s+)*func\s+([A-Za-z_]\w*)/, kind: 'function', group: 1 },
    { pattern: /^\s*(?:let|var)\s+([A-Za-z_]\w*)/, kind: 'variable', group: 1 },
  ],
  shell: [
    { pattern: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{/, kind: 'function', group: 1 },
    { pattern: /^\s*function\s+([A-Za-z_]\w*)/, kind: 'function', group: 1 },
  ],
}

/** 数据/文档类语言：不产符号（契约允许空 symbols）。 */
const DATA_LANGUAGES = new Set(['json', 'yaml', 'markdown', 'html', 'css', 'text'])

/* ------------------------------------------------------------------ *
 * 主解析
 * ------------------------------------------------------------------ */

export function parseGeneric(input) {
  const content = typeof input?.content === 'string' ? input.content : ''
  const language = typeof input?.language === 'string' ? input.language : 'text'
  const symbols = []
  const imports = []
  const calls = []
  const routes = []
  const exports = []
  const notes = []

  if (content.length === 0) {
    return { language, symbols, imports, calls, routes, exports, todos: [], notes }
  }

  const lines = content.split('\n')
  const maskedLines = lines.map((line) => maskQuoted(line, '"\'`'))
  const isData = DATA_LANGUAGES.has(language)
  const isMarkup = language === 'vue' || language === 'svelte'
  const isCStyle = language === 'go' || language === 'rust' || language === 'c' || language === 'cpp' ||
    language === 'csharp' || language === 'kotlin' || language === 'scala' || language === 'swift' || language === 'php'

  /* ---------- 1. 符号 ---------- */

  if (!isData) {
    const patterns = SYMBOL_PATTERNS[language] ?? []
    const seen = new Set()
    const endCache = new Map()
    for (let index = 0; index < lines.length; index += 1) {
      const code = maskedLines[index]
      if (code.trim().length === 0) continue
      if (code.length > 4000) continue // 压缩单行不抽符号，避免灾难性回溯
      for (const entry of patterns) {
        const found = entry.pattern.exec(code)
        if (!found || !entry.kind) continue
        const name = found[entry.group]
        if (typeof name !== 'string' || name.length === 0) continue
        if (CALL_KEYWORDS.has(name) && name !== 'new' && name !== 'delete' && name !== 'init') continue
        if (!/^[A-Za-z_]\w*$/.test(name)) continue
        const key = `${name}@${index + 1}`
        if (seen.has(key)) continue
        seen.add(key)
        if (!endCache.has(index)) endCache.set(index, findBlockEnd(lines, maskedLines, index, language))
        symbols.push({
          name,
          kind: entry.kind,
          line: index + 1,
          endLine: endCache.get(index),
          exported: /(?:^|\s)(?:export|pub|public)\s/.test(lines[index]),
          parent: null,
          signature: signatureFor(lines[index], maskedLines[index]),
          doc: docFor(lines, index),
          __indent: indentWidth(lines[index]),
        })
        break
      }
    }
    // parent：最近的、缩进更浅且覆盖当前行的符号
    for (let index = 0; index < symbols.length; index += 1) {
      const symbol = symbols[index]
      let parent = null
      for (let scan = index - 1; scan >= 0; scan -= 1) {
        const candidate = symbols[scan]
        if (candidate.__indent < symbol.__indent && candidate.endLine >= symbol.endLine) {
          parent = candidate.name
          break
        }
      }
      symbol.parent = parent
    }
    for (const symbol of symbols) delete symbol.__indent
    // C/C++：额外的头文件引入
    if (language === 'c' || language === 'cpp') {
      for (let index = 0; index < lines.length; index += 1) {
        const found = /^\s*#\s*include\s*[<"]([^">]+)[>"]/.exec(lines[index])
        if (found) imports.push({ specifier: found[1], line: index + 1, names: [], kind: 'static' })
      }
    }
  }

  /* ---------- 2. import / require / use / source ---------- */

  const addImport = (specifier, line, names) => {
    if (typeof specifier !== 'string' || specifier.length === 0) return
    imports.push({ specifier, line, names: names ?? [], kind: 'static' })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const code = maskedLines[index]
    const line = index + 1
    if (code.trim().length === 0) continue

    if (language === 'go') {
      if (/^\s*import\s/.test(code)) {
        if (code.includes('(')) {
          for (let scan = index + 1; scan < lines.length && scan <= index + 300; scan += 1) {
            const entry = /^\s*(?:[\w.]+\s+)?"([^"]+)"/.exec(lines[scan])
            if (entry) addImport(entry[1], scan + 1, [])
            if (/^\s*\)/.test(lines[scan])) break
          }
        } else {
          const entry = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(code)
          if (entry) addImport(entry[1], line, [])
        }
      }
      continue
    }
    if (language === 'rust') {
      const found = /^\s*(?:pub\s+)?use\s+([\w:{},*\s]+);/.exec(code)
      if (found) addImport(found[1].replace(/\s+/g, ''), line, [])
      const external = /^\s*extern\s+crate\s+([A-Za-z_]\w*)/.exec(code)
      if (external) addImport(external[1], line, [])
      continue
    }
    if (language === 'ruby') {
      const found = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/.exec(raw)
      if (found) addImport(found[1], line, [])
      continue
    }
    if (language === 'php') {
      const found = /^\s*(?:include|include_once|require|require_once)\s*\(?\s*['"]([^'"]+)['"]/.exec(raw)
      if (found) addImport(found[1], line, [])
      const use = /^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?/.exec(code)
      if (use) addImport(use[1], line, [use[2] ?? use[1].split('\\').pop()])
      continue
    }
    if (language === 'csharp') {
      const found = /^\s*using\s+([\w.]+)\s*;/.exec(code)
      if (found) addImport(found[1], line, [])
      continue
    }
    if (language === 'kotlin' || language === 'scala') {
      const found = /^\s*import\s+([\w.{}*,\s]+)/.exec(code)
      if (found) addImport(found[1].replace(/\s+/g, ''), line, [])
      continue
    }
    if (language === 'swift') {
      const found = /^\s*import\s+([A-Za-z_]\w*)/.exec(code)
      if (found) addImport(found[1], line, [])
      continue
    }
    if (language === 'shell') {
      const found = /^\s*(?:source|\.)\s+([^\s;]+)/.exec(raw)
      if (found) addImport(found[1].replace(/^["']|["']$/g, ''), line, [])
      continue
    }
    if (language === 'c' || language === 'cpp') continue
    if (language === 'vue' || language === 'svelte' || language === 'html') {
      // 必须读原文：掩码把字符串内容换成了空格
      const found = /^[ \t]*import\s+(?:[\w${}*,\s]+from\s+)?['"]([^'"]+)['"]/.exec(raw)
      if (found) addImport(found[1], line, [])
      continue
    }
  }

  /* ---------- 3. 调用 ---------- */

  if (!isData && language !== 'sql') {
    const callPattern = /(?<![.\w])((?:[A-Za-z_]\w*\.)*)([A-Za-z_]\w*)\s*\(/g
    const seen = new Set()
    for (let index = 0; index < lines.length; index += 1) {
      const code = maskedLines[index]
      if (code.trim().length === 0 || code.length > 4000) continue
      const line = index + 1
      const controlFlow = /^\s*(?:if|while|for|switch|catch|return|elif|elsif|unless|until|when|case|match)\b/.test(code)
      const headDecl = /\b(?:func|fn|fun|function|def|sub|class|struct|enum|interface|trait|type|record|impl|mod|namespace|object|protocol|extension|actor)\s+$/
      let match
      callPattern.lastIndex = 0
      while ((match = callPattern.exec(code)) !== null) {
        const receiver = (match[1] ?? '').replace(/\.$/, '')
        const name = match[2]
        if (CALL_KEYWORDS.has(name) || DECL_KEYWORDS.has(name)) continue
        if (controlFlow && receiver.length === 0) continue
        if (headDecl.test(code.slice(0, match.index))) continue
        const key = `${line}:${name}`
        if (seen.has(key)) continue
        seen.add(key)
        calls.push({
          calleeName: name,
          line,
          fromSymbolName: null,
          kind: 'call',
          ...(receiver.length > 0 ? { receiver } : {}),
        })
      }
    }
  }

  /* ---------- 4. SQL ---------- */

  if (language === 'sql') {
    const pattern = /^[ \t]*CREATE[ \t]+(?:OR[ \t]+REPLACE[ \t]+)?(TABLE|VIEW|FUNCTION|PROCEDURE|INDEX|SCHEMA|TRIGGER)[ \t]+(?:IF[ \t]+NOT[ \t]+EXISTS[ \t]+)?([\w."`[\]]+)/gim
    let match
    while ((match = pattern.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length
      const kind = match[1].toUpperCase()
      symbols.push({
        name: match[2].replace(/["`[\]]/g, ''),
        kind: kind === 'FUNCTION' || kind === 'PROCEDURE' ? 'function' : 'class',
        line,
        endLine: line,
        exported: kind === 'FUNCTION' || kind === 'PROCEDURE',
        parent: null,
        signature: null,
        doc: null,
      })
    }
  }

  /* ---------- 5. Vue / Svelte 的 script 导出 ---------- */

  if (isMarkup) {
    let match
    const pattern = /^[ \t]*export[ \t]+(?:default[ \t]+)?(?:async[ \t]+)?(?:const|let|var|function|class)[ \t]+([A-Za-z_$][\w$]*)/gm
    while ((match = pattern.exec(content)) !== null) exports.push(match[1])
    if (/export[ \t]+default\b/.test(content)) exports.push('default')
  }

  void isCStyle
  void routes

  return {
    language,
    symbols,
    imports: dedupeImports(imports),
    calls: calls.sort((a, b) => a.line - b.line || a.calleeName.localeCompare(b.calleeName)).slice(0, 4000),
    routes,
    exports: [...new Set(exports)],
    todos: extractTodos(content),
    notes,
  }
}

/* ------------------------------------------------------------------ *
 * 局部工具
 * ------------------------------------------------------------------ */

/** 块结束行（1-based）；Ruby 用 `end` 配平，shell 用 `{}`，其余用 `{}`。 */
function findBlockEnd(lines, maskedLines, startIndex, language) {
  const startLine = startIndex + 1
  if (language === 'ruby') {
    const baseIndent = indentWidth(lines[startIndex])
    let last = startLine
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const text = lines[index]
      if (text.trim().length === 0) continue
      const indent = indentWidth(text)
      if (indent < baseIndent) break
      if (indent === baseIndent && /^\s*(?:end|else|elsif|rescue|ensure|when)\b/.test(text)) break
      last = index + 1
    }
    return last
  }
  let depth = braceDelta(maskedLines[startIndex])
  if (depth <= 0) {
    // 大括号可能在下一行（K&R / PHP / C# 常见写法），向前找第一个非空行
    let index = startIndex + 1
    while (index < lines.length && lines[index].trim().length === 0) index += 1
    if (index >= lines.length || !maskedLines[index].includes('{')) return startLine
    depth = braceDelta(maskedLines[index])
    if (depth <= 0) return index + 1
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      depth += braceDelta(maskedLines[scan])
      if (depth <= 0) return scan + 1
    }
    return lines.length
  }
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    depth += braceDelta(maskedLines[index])
    if (depth <= 0) return index + 1
  }
  return lines.length
}

/** 花括号深度增量（只看 `{}`，`()`/`[]` 不参与块判定）。 */
function braceDelta(text) {
  let delta = 0
  for (const char of String(text ?? '')) {
    if (char === '{') delta += 1
    else if (char === '}') delta -= 1
  }
  return delta
}

/** 形参列表（取原文括号内内容，空白归一）。 */
function signatureFor(raw, maskedLine) {
  const open = maskedLine.indexOf('(')
  if (open === -1) return null
  const rawOpen = raw.indexOf('(')
  if (rawOpen === -1) return null
  let depth = 0
  for (let index = open; index < maskedLine.length; index += 1) {
    if (maskedLine[index] === '(') depth += 1
    else if (maskedLine[index] === ')') {
      depth -= 1
      if (depth === 0) {
        const slice = raw.slice(rawOpen, rawOpen + (index - open) + 1)
        return slice.replace(/\s+/g, ' ').trim()
      }
    }
  }
  return null
}

/** 紧邻上方注释首行。 */
function docFor(lines, index) {
  let scan = index - 1
  while (scan >= 0 && lines[scan].trim() === '') scan -= 1
  if (scan < 0) return null
  const text = lines[scan].trim()
  if (text.startsWith('///')) return clip(text.replace(/^\/\/\/\s?/, ''), 200)
  if (text.startsWith('//')) return clip(text.replace(/^\/\/\s?/, ''), 200)
  if (text.startsWith('#')) return clip(text.replace(/^#+\s?/, ''), 200)
  if (text.startsWith('--')) return clip(text.replace(/^--\s?/, ''), 200)
  if (text.endsWith('*/')) {
    let start = scan
    while (start >= 0 && !lines[start].trim().startsWith('/*')) start -= 1
    if (start < 0) start = scan
    for (let entry = start; entry <= scan; entry += 1) {
      const raw = lines[entry].trim().replace(/^\/\*\*?/, '').replace(/\*\/$/, '').replace(/^\*\s?/, '').trim()
      if (raw.length > 0 && !raw.startsWith('@')) return clip(raw, 200)
    }
    return null
  }
  if (text.startsWith('*')) return clip(text.replace(/^\*\s?/, ''), 200)
  return null
}

function dedupeImports(imports) {
  const seen = new Set()
  const out = []
  for (const entry of imports) {
    const key = `${entry.line}:${entry.specifier}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out.sort((a, b) => a.line - b.line)
}
