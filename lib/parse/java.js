/**
 * Java 深度解析器：**花括号配平**。
 *
 * 要点：
 *   - 先遮蔽字符串 / 字符字面量 / 注释（保留换行），字符串里的 `{}` 不参与配平；
 *   - 逐行统计花括号深度，得到每个类型体的成员范围；
 *   - 抽 package（notes 元信息）/ import / 类型声明 / 方法 / 字段；
 *   - Spring 注解路由（@GetMapping 等）+ JAX-RS（@GET + @Path）→ routes；
 *   - Javadoc → doc；尾随 `// TODO` → todos。
 *
 * 契约：docs/INTERNAL-CONTRACTS.md §2 / §3。
 * @module dsh-project-compass/parse/java
 */

import { clip } from '../util.js'
import { extractTodos } from './index.js'

const MODIFIERS = new Set([
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'native', 'synchronized',
  'transient', 'volatile', 'strictfp', 'default', 'sealed', 'non-sealed',
])

const CALL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch', 'finally', 'return', 'throw',
  'new', 'super', 'this', 'instanceof', 'synchronized', 'assert', 'break', 'continue', 'try',
  'class', 'interface', 'enum', 'record', 'void', 'package', 'import', 'yield',
])

/** 注解路径属性。 */
const MAPPING_ANNOTATIONS = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  PatchMapping: 'PATCH',
  DeleteMapping: 'DELETE',
  RequestMapping: 'REQUEST',
}

/** 遮蔽 Java 源码（字符串/字符/注释 → 空格，换行保留）。 */
function maskJava(source) {
  const text = typeof source === 'string' ? source : ''
  const chars = text.split('')
  const notes = []
  let mode = 'code'
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = chars[index]
    if (mode === 'line-comment') {
      if (char === '\n') mode = 'code'
      else chars[index] = ' '
      continue
    }
    if (mode === 'block-comment') {
      if (char === '*' && text[index + 1] === '/') {
        chars[index] = ' '
        chars[index + 1] = ' '
        index += 1
        mode = 'code'
        continue
      }
      if (char !== '\n') chars[index] = ' '
      continue
    }
    if (mode === 'string' || mode === 'char') {
      if (escaped) {
        escaped = false
        if (char !== '\n') chars[index] = ' '
        continue
      }
      if (char === '\\') {
        escaped = true
        chars[index] = ' '
        continue
      }
      if ((mode === 'string' && char === '"') || (mode === 'char' && char === "'")) {
        mode = 'code'
        continue
      }
      if (mode === 'string' && char === '\n') {
        mode = 'code'
        notes.push('检测到未闭合的字符串字面量，已按行尾降级')
        continue
      }
      if (char !== '\n') chars[index] = ' '
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      mode = 'line-comment'
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      chars[index] = ' '
      chars[index + 1] = ' '
      index += 1
      mode = 'block-comment'
      continue
    }
    if (char === '"') {
      mode = 'string'
      escaped = false
      continue
    }
    if (char === "'") {
      mode = 'char'
      escaped = false
      continue
    }
  }
  return { masked: chars.join(''), notes }
}

/** 遮蔽一行内的注释（保留字符串，用于取注解参数）。 */
function stripLineComment(text) {
  let quote = null
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '/' && text[index + 1] === '/') return text.slice(0, index)
  }
  return text
}

/** 跳过尖括号（泛型）后向前找名字。 */
function identifierBefore(text, closeIndex) {
  let index = closeIndex - 1
  while (index >= 0) {
    const char = text[index]
    if (char === '>') {
      let depth = 1
      index -= 1
      while (index >= 0 && depth > 0) {
        if (text[index] === '>') depth += 1
        else if (text[index] === '<') depth -= 1
        index -= 1
      }
      while (index >= 0 && /\s/.test(text[index])) index -= 1
      continue
    }
    break
  }
  const end = index + 1
  while (index >= 0 && /[\w$]/.test(text[index])) index -= 1
  const name = text.slice(index + 1, end)
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
  return { name, start: index + 1 }
}

/** 解析一行方法/字段声明。 */
function parseDeclaration(rawLine) {
  const line = stripLineComment(rawLine).trim()
  if (line.length === 0) return null
  let body = line.replace(/^(@[\w$.]+(?:\([^)]*\))?\s*)+/, '').trim()
  if (body.length === 0) return null
  body = body.replace(/\{\s*$/, '').replace(/;\s*$/, '').trim()
  if (body.length === 0) return null
  if (/^(?:if|for|while|switch|catch|try|do|else|return|throw|new|assert|synchronized|case)\b/.test(body)) return null
  if (body.includes('=>')) return null

  const open = body.indexOf('(')
  if (open !== -1) {
    const eq = body.indexOf('=')
    if (eq === -1 || eq > open) {
      const found = identifierBefore(body, open)
      if (found && !CALL_KEYWORDS.has(found.name)) {
        let close = -1
        let depth = 0
        for (let index = open; index < body.length; index += 1) {
          if (body[index] === '(') depth += 1
          else if (body[index] === ')') {
            depth -= 1
            if (depth === 0) {
              close = index
              break
            }
          }
        }
        const params = close === -1 ? body.slice(open) : body.slice(open, close + 1)
        const head = body.slice(0, found.start).trim()
        const words = head.split(/\s+/).filter((word) => word.length > 0 && !MODIFIERS.has(word))
        const isConstructor = words.length === 0 && /^[A-Z]/.test(found.name)
        let returnType = words.length > 0 ? words[words.length - 1] : null
        if (returnType && /^[A-Z_$][\w$.]*$/.test(returnType) && !/^[A-Z][a-z]/.test(returnType) && words.length === 1) {
          // 形如 `Foo()` 无返回值声明：视为构造器候选
          returnType = null
        }
        return {
          kind: 'method',
          name: found.name,
          signature: `${found.name}${params.replace(/\s+/g, ' ')}`,
          returnType: isConstructor ? null : returnType,
          constructor: isConstructor,
        }
      }
      return null
    }
  }

  if (body.includes('=') && !/\b(?:class|interface|enum|record)\b/.test(body)) {
    const name = /([\w$]+)\s*=/.exec(body)
    if (name) {
      const head = body.slice(0, name.index).trim()
      const words = head.split(/\s+/).filter((word) => word.length > 0 && !MODIFIERS.has(word))
      if (words.length >= 1) {
        return { kind: 'variable', name: name[1], signature: head, returnType: words[words.length - 1] }
      }
    }
  }
  return null
}

/** 注解名 + 路径参数。 */
function parseAnnotation(text) {
  const match = /^@([\w$.]+)\s*(?:\((.*)\))?\s*$/.exec(text.trim())
  if (!match) return null
  const name = match[1].split('.').pop()
  const args = String(match[2] ?? '').trim()
  let path = null
  const value = /(?:^|,)\s*(?:value|path)\s*=\s*(\{[^}]*\}|["'][^"']*["'])/.exec(args)
  if (value) {
    const first = /["']([^"']*)["']/.exec(value[1])
    if (first) path = first[1]
  } else if (/^["']/.test(args)) {
    const first = /^["']([^"']*)["']/.exec(args)
    if (first) path = first[1]
  }
  const method = /method\s*=\s*(?:RequestMethod\.)?([A-Z]+)/.exec(args)
  return { name, path, method: method ? method[1] : null, raw: text.trim() }
}

/** 归一化路径。 */
function normalizePath(value, fallback = '/') {
  const text = String(value ?? '').trim()
  if (text.length === 0) return fallback
  return text.startsWith('/') ? text.replace(/\/+$/, '') || '/' : `/${text}`
}

function joinPath(prefix, path) {
  const left = normalizePath(prefix)
  const right = normalizePath(path)
  if (left === '/') return right
  if (right === '/') return left
  return `${left}${right}`
}

/* ------------------------------------------------------------------ *
 * 主解析
 * ------------------------------------------------------------------ */

export function parseJava(input) {
  const content = typeof input?.content === 'string' ? input.content : ''
  const language = 'java'
  const symbols = []
  const imports = []
  const calls = []
  const routes = []
  const exports = []
  const notes = []

  if (content.length === 0) {
    return { language, symbols, imports, calls, routes, exports, todos: [], notes }
  }

  const { masked, notes: maskNotes } = maskJava(content)
  notes.push(...maskNotes)
  const lines = content.split('\n')
  const maskedLines = masked.split('\n')
  const lineCount = lines.length

  /** 每行开始时的花括号深度。 */
  const depthBefore = new Array(lineCount).fill(0)
  const depthAfter = new Array(lineCount).fill(0)
  {
    let depth = 0
    for (let index = 0; index < lineCount; index += 1) {
      depthBefore[index] = depth
      for (const char of maskedLines[index]) {
        if (char === '{') depth += 1
        else if (char === '}') depth = Math.max(0, depth - 1)
      }
      depthAfter[index] = depth
    }
  }
  const depthAt = (lineNumber) => depthBefore[Math.max(0, Math.min(lineCount, lineNumber) - 1)] ?? 0

  /** 从 startLine 起找配平的结束行（1-based）。 */
  const findBlockEnd = (startLine) => {
    const target = depthBefore[startLine - 1] ?? 0
    if ((depthAfter[startLine - 1] ?? 0) <= target) return startLine // 同行开闭
    for (let index = startLine; index < lineCount; index += 1) {
      // index 是 1-based 的下一行，数组下标要减一
      if ((depthAfter[index - 1] ?? 0) <= target) return index
    }
    notes.push('检测到未闭合的花括号，endLine 已截断到文件末尾')
    return lineCount
  }

  /* ---------- 1. package / import ---------- */

  let packageName = null
  for (let index = 0; index < lineCount; index += 1) {
    const code = maskedLines[index]
    const pkg = /^\s*package\s+([\w.]+)\s*;/.exec(code)
    if (pkg && packageName === null) {
      packageName = pkg[1]
      continue
    }
    const imported = /^\s*import\s+(static\s+)?([\w.*]+)\s*;/.exec(code)
    if (imported) {
      const fqn = imported[2]
      const name = fqn === '*' || fqn.endsWith('.*') ? '*' : fqn.split('.').pop()
      imports.push({ specifier: fqn, line: index + 1, names: name === '*' ? [] : [name], kind: 'static' })
    }
  }
  if (packageName) notes.push(`package: ${packageName}`)

  /* ---------- 2. 类型声明与成员 ---------- */

  const typeStack = []
  /** 类型名 → 类级 @RequestMapping 路径前缀。 */
  const typePrefixes = new Map()
  /** 类型/方法体（用于排除方法体内的局部变量）。 */
  const methodRanges = []
  const popClosedTypes = (index) => {
    const depth = index === null || index < 0 ? 0 : (depthBefore[index] ?? 0)
    while (typeStack.length > 0 && depth <= typeStack[typeStack.length - 1].depth) typeStack.pop()
  }
  for (let index = 0; index < lineCount; index += 1) {
    const lineNumber = index + 1
    const raw = lines[index]
    const code = maskedLines[index]
    const trimmed = stripLineComment(raw).trim()
    if (trimmed.length === 0) continue
    if (/^\s*(?:\/\/|\*|\/\*)/.test(raw.trim()) && !/@/.test(trimmed)) continue

    // 收集紧邻上方（含本行）的注解；一组注解必须以"方法/类型声明"结尾，否则本行跳过
    const annotations = []
    let scan = index
    while (scan < lineCount) {
      const text = stripLineComment(lines[scan]).trim()
      const found = /^@([\w$.]+)(?:\s*\((.*)\))?\s*$/.exec(text)
      if (!found) break
      annotations.push(parseAnnotation(text))
      scan += 1
    }
    if (annotations.length > 0) {
      if (scan >= lineCount) continue
      if (stripLineComment(lines[scan]).trim().length === 0) continue
      if (scan !== index) continue // 本行是注解行，真正处理在下面
    }
    const attachedAnnotations = annotations.length > 0 ? annotations : collectAnnotationsAbove(lines, index)

    // 离开已结束的类型体（按花括号深度判定，支持同行开闭）
    popClosedTypes(index)

    const atInterface = /@\s*interface\s+([A-Za-z_$][\w$]*)/.exec(code)
    if (atInterface) {
      const name = atInterface[1]
      const endLine = findBlockEnd(lineNumber)
      symbols.push({
        name,
        kind: 'interface',
        line: lineNumber,
        endLine,
        exported: true,
        parent: typeStack.length > 0 ? typeStack[typeStack.length - 1].name : null,
        signature: null,
        doc: extractJavadoc(lines, lineNumber),
        __type: true,
      })
      typeStack.push({ name, depth: depthBefore[index] ?? 0 })
      continue
    }
    const typeMatch = /(?:^|[\s;{}])(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/.exec(code)
    if (typeMatch) {
      const name = typeMatch[2]
      const kind = typeMatch[1]
      const endLine = findBlockEnd(lineNumber)
      const parent = typeStack.length > 0 ? typeStack[typeStack.length - 1].name : null
      // 类级 @RequestMapping 作为方法路由的前缀
      const classMapping = attachedAnnotations.find((entry) => entry && entry.name === 'RequestMapping')
      if (classMapping && classMapping.path) typePrefixes.set(name, classMapping.path)
      symbols.push({
        name,
        kind: kind === 'record' ? 'class' : kind,
        line: lineNumber,
        endLine,
        exported: true,
        parent,
        signature: null,
        doc: extractJavadoc(lines, lineNumber),
        __type: true,
      })
      typeStack.push({ name, depth: depthBefore[index] ?? 0 })
      continue
    }

    const insideType = typeStack.length > 0
    const declaration = parseDeclaration(raw)
    if (!declaration) continue
    if (!insideType && declaration.kind !== 'variable' && declaration.kind !== 'method') continue

    if (declaration.kind === 'method') {
      const hasBody = !trimmed.endsWith(';')
      const endLine = hasBody ? findBlockEnd(lineNumber) : lineNumber
      const parentName = typeStack[typeStack.length - 1]?.name ?? null
      const route = springRoute(attachedAnnotations, lineNumber, declaration.name, typePrefixes.get(parentName) ?? '')
      if (route) routes.push(route)
      symbols.push({
        name: declaration.name,
        kind: 'method',
        line: lineNumber,
        endLine,
        exported: !declaration.name.startsWith('private'),
        parent: parentName,
        signature: declaration.signature,
        doc: extractJavadoc(lines, lineNumber),
        __returnType: declaration.returnType,
      })
      if (hasBody) methodRanges.push({ start: lineNumber, end: endLine })
    } else {
      // 方法体内的局部变量不是类型成员，跳过
      if (methodRanges.some((range) => range.start < lineNumber && lineNumber <= range.end)) continue
      symbols.push({
        name: declaration.name,
        kind: 'variable',
        line: lineNumber,
        endLine: lineNumber,
        exported: false,
        parent: typeStack[typeStack.length - 1]?.name ?? null,
        signature: declaration.signature,
        doc: extractJavadoc(lines, lineNumber),
      })
    }
  }

  /* ---------- 3. 调用 ---------- */

  const callPattern = /(?<![.\w])((?:[A-Za-z_$][\w$]*\.)*)([A-Za-z_$][\w$]*)\s*\(/g
  const seen = new Set()
  for (let index = 0; index < lineCount; index += 1) {
    const code = maskedLines[index]
    if (code.trim().length === 0) continue
    const lineNumber = index + 1
    let match
    callPattern.lastIndex = 0
    while ((match = callPattern.exec(code)) !== null) {
      const receiver = (match[1] ?? '').replace(/\.$/, '')
      const name = match[2]
      if (CALL_KEYWORDS.has(name)) continue
      const key = `${lineNumber}:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      const owner = ownerAt(symbols, lineNumber)
      calls.push({
        calleeName: name,
        line: lineNumber,
        fromSymbolName: owner && owner.kind === 'method' ? owner.name : null,
        kind: lineBefore(code, match.index) === 'new' ? 'new' : 'call',
        ...(receiver.length > 0 ? { receiver } : {}),
      })
    }
  }

  /* ---------- 4. 收尾 ---------- */

  for (const symbol of symbols) {
    if (symbol.__type) exports.push(symbol.name)
    delete symbol.__type
    delete symbol.__returnType
  }

  return {
    language,
    symbols,
    imports,
    calls: calls.sort((a, b) => a.line - b.line || a.calleeName.localeCompare(b.calleeName)).slice(0, 6000),
    routes: dedupeRoutes(routes),
    exports: [...new Set(exports)],
    todos: extractTodos(content),
    notes,
  }
}

/* ------------------------------------------------------------------ *
 * 局部工具
 * ------------------------------------------------------------------ */

function lineBefore(code, index) {
  const before = code.slice(Math.max(0, index - 12), index)
  return /\bnew\s*$/.test(before) ? 'new' : 'call'
}

function ownerAt(symbols, lineNumber) {
  const candidates = symbols.filter((symbol) => symbol.line <= lineNumber && lineNumber <= symbol.endLine && symbol.kind === 'method')
  if (candidates.length === 0) return null
  return candidates.reduce((best, symbol) => (best === null || symbol.line >= best.line ? symbol : best), null)
}

/** Javadoc（`/** … *\/`）取正文首行。 */
function extractJavadoc(lines, lineNumber) {
  let index = lineNumber - 2
  // 跳过紧邻的注解行（`@GetMapping` 插在 Javadoc 与声明之间很常见）
  for (;;) {
    while (index >= 0 && lines[index].trim() === '') index -= 1
    if (index >= 0 && lines[index].trim().startsWith('@')) {
      index -= 1
      continue
    }
    break
  }
  if (index < 0) return null
  if (!lines[index].trim().endsWith('*/')) return null
  let start = index
  while (start >= 0 && !lines[start].trim().startsWith('/*')) start -= 1
  if (start < 0) start = index
  for (let scan = start; scan <= index; scan += 1) {
    const raw = lines[scan].trim().replace(/^\/\*\*?/, '').replace(/\*\/$/, '').replace(/^\*\s?/, '').trim()
    if (raw.length > 0 && !raw.startsWith('@')) return clip(raw, 200)
  }
  return null
}

/** 取紧邻上方的注解（允许跨行块注解）。 */
function collectAnnotationsAbove(lines, index) {
  const out = []
  let scan = index - 1
  while (scan >= 0) {
    const text = stripLineComment(lines[scan]).trim()
    if (text.length === 0) break
    if (!text.startsWith('@')) break
    const parsed = parseAnnotation(text)
    if (parsed) out.unshift(parsed)
    scan -= 1
  }
  return out
}

/** Spring / JAX-RS 注解 → 路由。 */
function springRoute(annotations, line, handler, classPrefix = '') {
  const list = annotations.filter((entry) => entry !== null && entry !== undefined)
  const mapping = list.find((entry) => MAPPING_ANNOTATIONS[entry.name] !== undefined)
  const jaxrs = list.find((entry) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(entry.name))
  if (!mapping && !jaxrs) return null
  const prefix = classPrefix
  if (mapping) {
    const method = mapping.name === 'RequestMapping' ? (mapping.method ?? 'GET') : MAPPING_ANNOTATIONS[mapping.name]
    return {
      method: String(method).toUpperCase(),
      path: normalizePath(joinPath(prefix, mapping.path ?? '')),
      line,
      handlerName: handler,
      framework: 'spring',
    }
  }
  return {
    method: jaxrs.name,
    path: normalizePath(joinPath(prefix, jaxrs.path ?? '')),
    line,
    handlerName: handler,
    framework: 'jaxrs',
  }
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
