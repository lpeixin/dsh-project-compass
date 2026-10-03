/**
 * Python 深度解析器：**缩进配平**。
 *
 * 要点：
 *   - 行号 1-based；`def` / `async def` / `class` 的 endLine 由"下一行缩进回退"决定；
 *   - 跨行括号（参数表、列表、装饰器实参）不改变块缩进，需要单独跟踪括号深度；
 *   - docstring（`"""…"""`）作为 `doc`，不参与符号定位；
 *   - 装饰器（Flask/FastAPI/Celery/Django）→ routes；
 *   - `import a.b as c` / `from x import y as z` → imports.names 收集本地绑定名；
 *   - 尾随 `# TODO` → todos；`__all__` → exports。
 *
 * 契约：docs/INTERNAL-CONTRACTS.md §2 / §3。
 * @module dsh-project-compass/parse/python
 */

import { clip } from '../util.js'
import { extractTodos, indentWidth } from './index.js'

const CALL_KEYWORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'with', 'return', 'yield', 'assert', 'raise', 'del',
  'print', 'lambda', 'not', 'and', 'or', 'in', 'is', 'None', 'True', 'False', 'async', 'await',
  'try', 'except', 'finally', 'class', 'def', 'import', 'from', 'as', 'global', 'nonlocal',
  'pass', 'break', 'continue', 'super', 'self', 'match', 'case',
])

/** HTTP 动词 → 路径提取用的正则。 */
const ROUTE_DECORATORS = [
  { pattern: /^([A-Za-z_][\w.]*)\.(get|post|put|patch|delete|options|head|trace)\s*\(/i, framework: null, methodFrom: 'verb' },
  { pattern: /^([A-Za-z_][\w.]*)\.route\s*\(/i, framework: 'flask', methodFrom: 'methods' },
  { pattern: /^([A-Za-z_][\w.]*)\.(?:websocket)\s*\(/i, framework: 'fastapi', methodFrom: 'fixed', method: 'WEBSOCKET' },
]

/** 遮蔽一行里的字符串内容（保留引号），O(n) 状态机。 */
function maskLine(text) {
  const chars = String(text ?? '').split('')
  let quote = null
  let triple = false
  let escaped = false
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]
    if (quote !== null) {
      if (escaped) {
        chars[index] = ' '
        escaped = false
        continue
      }
      if (char === '\\') {
        chars[index] = ' '
        escaped = true
        continue
      }
      if (triple) {
        if (char === quote && chars[index + 1] === quote && chars[index + 2] === quote) {
          chars[index + 1] = ' '
          chars[index + 2] = ' '
          index += 2
          quote = null
          triple = false
          continue
        }
        chars[index] = ' '
        continue
      }
      if (char === quote) {
        quote = null
        continue
      }
      chars[index] = ' '
      continue
    }
    if (char === '#') {
      for (let rest = index; rest < chars.length; rest += 1) chars[rest] = ' '
      break
    }
    if (char === '"' || char === "'") {
      quote = char
      triple = chars[index + 1] === char && chars[index + 2] === char
      if (triple) {
        chars[index + 1] = ' '
        chars[index + 2] = ' '
        index += 2
      }
      continue
    }
  }
  return { code: chars.join(''), openQuote: quote, triple }
}

/** 求代码里的括号深度变化。 */
function depthDelta(code) {
  let delta = 0
  for (const char of code) {
    if (char === '(' || char === '[' || char === '{') delta += 1
    else if (char === ')' || char === ']' || char === '}') delta -= 1
  }
  return delta
}

/** 从 pos 开始读一个 Python 字符串字面量内容（处理三引号）。 */
function readStringAt(line, pos) {
  const quote = line[pos]
  if (quote !== '"' && quote !== "'") return { value: '', end: pos }
  const triple = line.slice(pos, pos + 3) === quote.repeat(3)
  const width = triple ? 3 : 1
  let index = pos + width
  let escaped = false
  let value = ''
  while (index < line.length) {
    const char = line[index]
    if (escaped) {
      value += char
      escaped = false
      index += 1
      continue
    }
    if (char === '\\') {
      escaped = true
      value += char
      index += 1
      continue
    }
    if (triple ? line.slice(index, index + 3) === quote.repeat(3) : char === quote) {
      return { value, end: index + width }
    }
    value += char
    index += 1
  }
  return { value, end: line.length, unterminated: true }
}

/** 缩进配平求块结束行（1-based，含）。 */
function findBlockEnd(lines, defLine, defIndent, depthAtLine) {
  let last = defLine
  let depth = depthAtLine(defLine)
  for (let index = defLine; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw.trim().length === 0) continue
    const indent = indentWidth(raw)
    const lineNumber = index + 1
    if (lineNumber > defLine && depth <= 0 && indent <= defIndent) break
    last = lineNumber
    depth += depthAtLine(lineNumber)
  }
  return Math.max(defLine, last)
}

/** 收集 lineNumber 紧邻上方的装饰器（不跨空行）。 */
function collectDecorators(lines, lineNumber) {
  const out = []
  let index = lineNumber - 2
  while (index >= 0) {
    const text = lines[index]
    if (text.trim().length === 0) break
    if (!text.trim().startsWith('@')) break
    out.unshift({ line: index + 1, text: text.trim() })
    index -= 1
  }
  return out
}

/** 提取装饰器中的路由信息。 */
function decoratorRoutes(decorator) {
  const body = decorator.text.replace(/^@/, '').trim()
  const routes = []

  // Celery / 异步任务
  if (/^(?:[\w.]*\.)?(?:task|shared_task|periodic_task)\s*(?:\(|$)/.test(body)) {
    const nameMatch = /name\s*=\s*['"]([^'"]+)['"]/.exec(body)
    routes.push({
      method: 'TASK',
      path: nameMatch ? nameMatch[1] : body.split('(')[0].split('.').pop(),
      line: decorator.line,
      framework: 'celery',
      kind: 'event',
    })
    return routes
  }

  // Django: @api_view(['GET']) / @action(methods=['post'], detail=True) /
  //         @require_http_methods(['GET','POST'])
  const djangoMethods = /(?:methods|http_method_names)\s*=\s*\[([^\]]*)\]/.exec(body)
  if (/^(?:api_view|action|require_http_methods|require_POST|require_GET)\b/.test(body)) {
    const verbs = djangoMethods
      ? [...djangoMethods[1].matchAll(/['"]([A-Za-z]+)['"]/g)].map((entry) => entry[1].toUpperCase())
      : [body.split('(')[0].replace(/^require_/, '').toUpperCase()]
    for (const verb of verbs.length > 0 ? verbs : ['GET']) {
      routes.push({ method: verb, path: '/', line: decorator.line, framework: 'django', kind: 'http' })
    }
    return routes
  }

  // Flask / FastAPI / 通用蓝图
  for (const entry of ROUTE_DECORATORS) {
    const found = entry.pattern.exec(body)
    if (!found) continue
    const path = (() => {
      const quoted = /['"]([^'"]*)['"]/.exec(body.slice(found[0].length - 1))
      return quoted ? quoted[1] : ''
    })()
    if (entry.methodFrom === 'fixed') {
      routes.push({ method: entry.method, path: path || '/', line: decorator.line, framework: entry.framework ?? 'flask', kind: 'http' })
      continue
    }
    if (entry.methodFrom === 'methods') {
      const methods = /methods\s*=\s*\[([^\]]*)\]/.exec(body)
      const verbs = methods
        ? [...methods[1].matchAll(/['"]([A-Za-z]+)['"]/g)].map((match) => match[1].toUpperCase())
        : ['GET']
      for (const verb of verbs) {
        routes.push({ method: verb, path: path || '/', line: decorator.line, framework: entry.framework ?? 'flask', kind: 'http' })
      }
      continue
    }
    // 接收者必须像 Web 框架对象：`@cache.get('/x')`、`@config.get('/y')` 不是路由
    const receiverName = found[1].split('.').pop()
    if (!/^(?:app|api|router|bp|blueprint|server|fastapi|flask|route|routes|controller|view|views|urls)$/i.test(receiverName)) continue
    const framework = entry.framework ?? (/^(?:bp|blueprint|flask)$/i.test(receiverName) ? 'flask' : 'fastapi')
    routes.push({
      method: found[2].toUpperCase(),
      path: path || '/',
      line: decorator.line,
      framework,
      kind: 'http',
    })
    return routes
  }
  return routes
}

/* ------------------------------------------------------------------ *
 * 主解析
 * ------------------------------------------------------------------ */

export function parsePython(input) {
  const content = typeof input?.content === 'string' ? input.content : ''
  const language = 'python'
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
  const masked = []
  for (const line of lines) masked.push(maskLine(line).code)
  /** 每行起止括号深度（用于判断跨行表达式）。 */
  const depthBefore = new Array(lines.length).fill(0)
  const depthAfter = new Array(lines.length).fill(0)
  {
    let depth = 0
    for (let index = 0; index < lines.length; index += 1) {
      depthBefore[index] = depth
      depth = Math.max(0, depth + depthDelta(masked[index]))
      depthAfter[index] = depth
    }
  }
  const depthAtLine = (lineNumber) => depthAfter[Math.max(0, Math.min(lines.length, lineNumber) - 1)] ?? 0

  /* ---------- 1. 符号（def / async def / class） ---------- */

  const pendingDecorators = []
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const lineNumber = index + 1
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('@')) {
      pendingDecorators.push({ line: lineNumber, text: trimmed })
      continue
    }
    if (depthBefore[index] > 0) continue

    const match = /^(\s*)(?:(async)\s+)?(def|class)\s+([A-Za-z_]\w*)\s*(\(|:|$)/.exec(raw)
    if (!match) {
      pendingDecorators.length = 0
      continue
    }
    const indent = indentWidth(raw)
    const name = match[4]
    const defLine = lineNumber
    const endLine = findBlockEnd(lines, defLine, indent, depthAtLine)
    const decorators = collectDecorators(lines, lineNumber)
    const decoratorRoutesForSymbol = []

    for (const decorator of decorators) {
      for (const route of decoratorRoutes(decorator)) {
        routes.push({ ...route, handlerName: name })
        decoratorRoutesForSymbol.push(route)
      }
    }
    // 兼容 pendingDecorators（同一行块被 continue 打散的情况）
    for (const decorator of pendingDecorators) {
      if (decorators.some((entry) => entry.line === decorator.line)) continue
      for (const route of decoratorRoutes(decorator)) routes.push({ ...route, handlerName: name })
    }
    pendingDecorators.length = 0

    // signature：形参表（原文，跨行归一）
    const signature = (() => {
      if (match[3] === 'class') {
        const paren = raw.indexOf('(')
        if (paren === -1) return '()'
      }
      let text = ''
      for (let scan = index; scan < lines.length && scan <= index + 40; scan += 1) {
        text += lines[scan]
        if (depthAfter[scan] <= 0) break
        text += ' '
      }
      const open = text.indexOf('(')
      if (open === -1) return '()'
      let depth = 0
      let end = -1
      for (let pos = open; pos < text.length; pos += 1) {
        if (text[pos] === '(') depth += 1
        else if (text[pos] === ')') {
          depth -= 1
          if (depth === 0) {
            end = pos
            break
          }
        }
      }
      const slice = end === -1 ? text.slice(open) : text.slice(open, end + 1)
      return slice.replace(/\s+/g, ' ').trim()
    })()

    const doc = extractPythonDoc(lines, index, endLine)

    symbols.push({
      name,
      kind: match[3] === 'class' ? 'class' : 'function',
      line: defLine,
      endLine,
      exported: false,
      parent: null,
      signature,
      doc,
      __indent: indent,
    })
    if (decoratorRoutesForSymbol.length > 0) {
      // 路由处理函数补一个 route-handler 语义（保持与 JS 端一致的 kind 体系）
      const symbol = symbols[symbols.length - 1]
      symbol.kind = symbol.kind === 'function' ? 'route-handler' : symbol.kind
    }
  }

  // parent：按缩进层级归属
  for (let index = 0; index < symbols.length; index += 1) {
    const symbol = symbols[index]
    let parent = null
    for (let scan = index - 1; scan >= 0; scan -= 1) {
      const candidate = symbols[scan]
      if (candidate.__indent < symbol.__indent && candidate.endLine >= symbol.endLine && candidate.line < symbol.line) {
        parent = candidate
        break
      }
    }
    symbol.parent = parent ? parent.name : null
  }
  for (const symbol of symbols) delete symbol.__indent

  /* ---------- 2. import ---------- */

  for (let index = 0; index < lines.length; index += 1) {
    const code = masked[index]
    if (code.trim().length === 0) continue
    const lineNumber = index + 1
    const fromMatch = /^\s*from\s+([.\w]+)\s+import\s+([^#\n]+)/.exec(code)
    if (fromMatch) {
      const names = []
      const body = fromMatch[2].replace(/[()]/g, ' ')
      for (const part of body.split(',')) {
        const piece = part.trim()
        if (piece.length === 0) continue
        const alias = /^([A-Za-z_]\w*|\*)\s+as\s+([A-Za-z_]\w*)$/.exec(piece)
        if (alias) {
          names.push(alias[1] === '*' ? alias[2] : alias[2])
          continue
        }
        const bare = /^([A-Za-z_]\w*|\*)$/.exec(piece)
        if (bare && bare[1] !== '*') names.push(bare[1])
      }
      imports.push({ specifier: fromMatch[1], line: lineNumber, names, kind: 'static' })
      continue
    }
    const importMatch = /^\s*import\s+([^#\n]+)/.exec(code)
    if (importMatch) {
      for (const part of importMatch[1].split(',')) {
        const piece = part.trim()
        if (piece.length === 0) continue
        const alias = /^([\w.]+)\s+as\s+([A-Za-z_]\w*)$/.exec(piece)
        if (alias) {
          imports.push({ specifier: alias[1], line: lineNumber, names: [alias[2]], kind: 'static' })
          continue
        }
        const bare = /^([\w.]+)$/.exec(piece)
        if (!bare) continue
        const root = bare[1].split('.')[0]
        imports.push({ specifier: bare[1], line: lineNumber, names: [root], kind: 'static' })
      }
    }
  }

  /* ---------- 3. 调用 ---------- */

  const callSeen = new Set()
  const ownerAt = (lineNumber) => {
    const candidates = symbols.filter((symbol) => symbol.line <= lineNumber && lineNumber <= symbol.endLine)
    if (candidates.length === 0) return null
    return candidates.reduce((best, symbol) => (best === null || symbol.line >= best.line ? symbol : best), null)
  }

  // 声明头/装饰器行上的名字不是调用
  const HEAD_BEFORE = /(?:\bdef|\bclass|\blambda|=|@)\s*$/
  const callPattern = /(?<![.\w])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g
  for (let index = 0; index < lines.length; index += 1) {
    const code = masked[index]
    if (code.trim().length === 0) continue
    const lineNumber = index + 1
    const isDecorator = lines[index].trim().startsWith('@')
    let match
    callPattern.lastIndex = 0
    while ((match = callPattern.exec(code)) !== null) {
      const full = match[1]
      const parts = full.split('.')
      const name = parts[parts.length - 1]
      const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : ''
      if (CALL_KEYWORDS.has(name)) continue
      if (isDecorator) continue
      const before = code.slice(Math.max(0, match.index - 24), match.index)
      if (HEAD_BEFORE.test(before)) continue
      const key = `${lineNumber}:${name}:call`
      if (callSeen.has(key)) continue
      callSeen.add(key)
      const owner = ownerAt(lineNumber)
      calls.push({
        calleeName: name,
        line: lineNumber,
        fromSymbolName: owner && owner.kind !== 'class' ? owner.name : null,
        kind: 'call',
        ...(receiver.length > 0 ? { receiver } : {}),
      })
    }
  }

  /* ---------- 4. exports（__all__） ---------- */

  const declaredAll = /^[ \t]*__all__[ \t]*(?::[^=\n]+)?=/m.test(content)
  const allMatch = /^[ \t]*__all__[ \t]*(?::[^=\n]+)?=[ \t]*\[([\s\S]*?)\]/m.exec(content)
  if (allMatch) {
    for (const entry of allMatch[1].matchAll(/['"]([^'"]+)['"]/g)) exports.push(entry[1])
  } else {
    const tupleAll = /^[ \t]*__all__[ \t]*(?::[^=\n]+)?=[ \t]*\(([\s\S]*?)\)/m.exec(content)
    if (tupleAll) for (const entry of tupleAll[1].matchAll(/['"]([^'"]+)['"]/g)) exports.push(entry[1])
  }
  if (!declaredAll) {
    // 无 __all__ 时：非下划线开头的顶层符号即为导出面
    for (const symbol of symbols) {
      if (symbol.parent === null && !symbol.name.startsWith('_')) exports.push(symbol.name)
    }
  }

  const leftParenBalance = depthAfter[depthAfter.length - 1] ?? 0
  if (leftParenBalance !== 0) notes.push('检测到未闭合的括号，缩进配平已降级')

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

/** 块首的 docstring（支持三引号跨行）。 */
function extractPythonDoc(lines, defIndex, endLine) {
  for (let index = defIndex + 1; index < lines.length && index < endLine; index += 1) {
    const text = lines[index]
    if (text.trim().length === 0) continue
    const trimmed = text.trim()
    const triple = /^([rRbBuUfF]{0,2})("""|''')/.exec(trimmed)
    if (triple) {
      const marker = triple[2]
      let rest = trimmed.slice(triple[0].length)
      if (rest.includes(marker)) return pickDocLine(rest.slice(0, rest.indexOf(marker)))
      const collected = [rest]
      for (let scan = index + 1; scan < lines.length && scan <= index + 200; scan += 1) {
        const next = lines[scan]
        const close = next.indexOf(marker)
        if (close !== -1) {
          collected.push(next.slice(0, close))
          break
        }
        collected.push(next)
      }
      return pickDocLine(collected.join('\n'))
    }
    const single = /^([rRbBuUfF]{0,2})(["'])(.*)\2\s*$/.exec(trimmed)
    if (single) return single[3].trim().length > 0 ? pickDocLine(single[3]) : null
    return null
  }
  return null
}

/** 取 docstring 的第一条非空文本行。 */
function pickDocLine(body) {
  const line = String(body ?? '').split('\n').map((part) => part.trim()).find((part) => part.length > 0)
  return line ? clip(line, 200) : null
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
