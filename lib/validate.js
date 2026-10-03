/**
 * 引用验证器（FR6 的"防幻觉"半边）。
 *
 * 核心信念：**LLM 只负责措辞，事实由 IR 负责**。因此任何进入报告的 LLM 输出，
 * 都必须先经过这里逐条核对；核对不上的内容不是"打个问号"，而是**直接丢弃**，
 * 并把丢弃原因写进报告的元信息，让读者知道有多少内容被拦下。
 *
 * 判定口径（严格）：
 *   - 路径必须在 IR 的文件集合里（大小写敏感，与磁盘一致）；
 *   - 行号必须落在该文件 `1..loc` 区间内（包含端点）；
 *   - 符号必须能在 IR 中找到；同名多义视为合法但标注 `ambiguous`；
 *   - 没有任何引用的断言在 `requireCitation` 下视为无效。
 *
 * @module dsh-project-compass/validate
 */

import { toPosix } from './util.js'

/** 匹配 `path/to/file.ext:123`、`./a/b.ts#symbol`、`file.py:12-30` 形式。 */
const CITE_PATTERN = /`?([A-Za-z0-9_@./-]+\.[A-Za-z0-9]{1,10})(?::(\d+)(?:\s*-\s*(\d+))?)?(?:#([A-Za-z0-9_$]+))?`?/g

/** 反引号包裹的裸标识符（候选符号名）。 */
const BACKTICK_SYMBOL_PATTERN = /`([A-Za-z_$][A-Za-z0-9_$]{1,80})`/g

/**
 * 创建验证器。
 * @param ir 统一 IR。
 * @param options.maxLineSlack 允许的行号外扩（默认 0，严格）。
 */
export function createValidator(ir, options = {}) {
  const maxLineSlack = Number.isFinite(options.maxLineSlack) ? Math.max(0, Math.trunc(options.maxLineSlack)) : 0
  const files = ir?.files ?? []
  const symbols = ir?.symbols ?? []
  const routes = ir?.routes ?? []

  const fileById = new Map(files.map((file) => [toPosix(file.id), file]))
  const fileByLower = new Map(files.map((file) => [toPosix(file.id).toLowerCase(), file]))
  const symbolIds = new Set(symbols.map((symbol) => symbol.id))
  const symbolsByName = new Map()
  for (const symbol of symbols) {
    const bucket = symbolsByName.get(symbol.name)
    if (bucket === undefined) symbolsByName.set(symbol.name, [symbol])
    else bucket.push(symbol)
  }
  const routeKeys = new Set(routes.map((route) => `${route.method} ${route.path}`))

  let checkedCitations = 0
  let droppedCitations = 0
  let checkedTexts = 0

  const validator = {
    /** 文件是否存在于 IR。 */
    hasFile(fileId) {
      return fileById.has(toPosix(fileId))
    },
    /** 符号 id 是否存在。 */
    hasSymbol(symbolId) {
      return symbolIds.has(symbolId)
    },
    /** 按名找符号（可能多个同名）。 */
    findSymbolByName(name) {
      return symbolsByName.get(String(name ?? '')) ?? []
    },
    /** 路由是否存在（方法 + 路径）。 */
    hasRoute(method, routePath) {
      return routeKeys.has(`${String(method ?? '').toUpperCase()} ${String(routePath ?? '')}`)
    },
    fileCount() {
      return files.length
    },
    symbolCount() {
      return symbols.length
    },

    /**
     * 核对单条引用。
     * @returns { ok, reason, ambiguous }
     */
    checkCitation(citation) {
      const path = toPosix(citation?.path ?? '')
      if (path.length === 0) return { ok: false, reason: '缺少路径', ambiguous: false }
      const file = fileById.get(path) ?? fileByLower.get(path.toLowerCase())
      if (file === undefined) return { ok: false, reason: `路径不存在于项目：${path}`, ambiguous: false }

      if (citation.symbol !== undefined && citation.symbol !== null && String(citation.symbol).length > 0) {
        const byId = symbolIds.has(String(citation.symbol))
        const matches = symbolsByName.get(String(citation.symbol)) ?? []
        if (!byId && matches.length === 0) return { ok: false, reason: `符号不存在：${citation.symbol}`, ambiguous: false }
        if (matches.length > 1) return { ok: true, reason: `符号同名 ${matches.length} 处`, ambiguous: true }
      }

      if (Number.isFinite(citation.line)) {
        const line = Math.trunc(citation.line)
        const loc = Number(file.loc) || 0
        if (line < 1 || (loc > 0 && line > loc + maxLineSlack)) {
          return { ok: false, reason: `行号越界：${path} 只有 ${loc} 行，声称第 ${line} 行`, ambiguous: false }
        }
      }
      return { ok: true, reason: null, ambiguous: false }
    },

    /**
     * 核对一段自然语言：抽出所有 `path:line` 与反引号符号名，逐条验证。
     * @param text 待核对文本。
     * @returns 核对报告（不会修改文本）。
     */
    checkText(text) {
      const raw = String(text ?? '')
      checkedTexts += 1
      const citations = []
      const dropped = []
      const unknownPaths = []
      const unknownSymbols = []
      const unknownLines = []
      const validPaths = new Set()
      const validSymbols = new Set()

      CITE_PATTERN.lastIndex = 0
      let match
      while ((match = CITE_PATTERN.exec(raw)) !== null) {
        const path = toPosix(match[1])
        const line = match[2] === undefined ? undefined : Number(match[2])
        const lineEnd = match[3] === undefined ? undefined : Number(match[3])
        const symbol = match[4] ?? undefined
        checkedCitations += 1
        const verdict = validator.checkCitation({ path, line, symbol })
        const entry = { claim: match[0].trim(), path, line, symbol }
        if (verdict.ok) {
          citations.push({ ...entry, ambiguous: verdict.ambiguous })
          validPaths.add(path)
          if (symbol) validSymbols.add(symbol)
          if (lineEnd !== undefined) {
            const endVerdict = validator.checkCitation({ path, line: lineEnd })
            if (!endVerdict.ok) {
              droppedCitations += 1
              dropped.push({ ...entry, reason: endVerdict.reason })
            }
          }
        } else {
          droppedCitations += 1
          dropped.push({ ...entry, reason: verdict.reason })
          if (!validator.hasFile(path)) unknownPaths.push(path)
          else unknownLines.push({ path, line })
          if (symbol && !validator.findSymbolByName(symbol).length) unknownSymbols.push(symbol)
        }
      }

      BACKTICK_SYMBOL_PATTERN.lastIndex = 0
      while ((match = BACKTICK_SYMBOL_PATTERN.exec(raw)) !== null) {
        const name = match[1]
        // 已被引文模式覆盖的（路径形态）跳过
        if (/[./]/.test(name)) continue
        const matches = validator.findSymbolByName(name)
        if (matches.length > 0) {
          validSymbols.add(name)
          continue
        }
        unknownSymbols.push(name)
        dropped.push({ claim: `\`${name}\``, path: null, line: null, symbol: name, reason: `符号不存在：${name}` })
      }

      return {
        ok: dropped.length === 0,
        total: citations.length + dropped.length,
        valid: citations.length,
        citations,
        dropped,
        unknownPaths: [...new Set(unknownPaths)],
        unknownSymbols: [...new Set(unknownSymbols)],
        unknownLines,
        validPaths: [...validPaths],
        validSymbols: [...validSymbols],
      }
    },

    /**
     * 核对结构化断言（推荐路径：让模型直接产出 JSON 断言，而不是自由文本）。
     * @param claims `[{ text, citations: [{path,line,symbol}], confidence }]`。
     * @param claimOptions.requireCitation 无引用的断言是否丢弃（默认 true）。
     * @returns { kept, dropped, report }
     */
    checkClaims(claims, claimOptions = {}) {
      const requireCitation = claimOptions.requireCitation !== false
      const kept = []
      const dropped = []
      for (const claim of claims ?? []) {
        const text = String(claim?.text ?? '').trim()
        const citations = Array.isArray(claim?.citations) ? claim.citations : []
        if (text.length === 0) {
          dropped.push({ text: '', reason: '空断言' })
          continue
        }
        if (citations.length === 0 && requireCitation) {
          dropped.push({ text, reason: '没有引用支撑' })
          continue
        }
        const verdicts = citations.map((citation) => ({ citation, verdict: validator.checkCitation(citation) }))
        const bad = verdicts.filter((entry) => !entry.verdict.ok)
        checkedCitations += citations.length
        droppedCitations += bad.length
        if (bad.length > 0) {
          dropped.push({ text, reason: bad.map((entry) => entry.verdict.reason).join('；'), citations })
          continue
        }
        kept.push({
          text,
          citations: citations.map((citation) => ({
            path: toPosix(citation.path),
            line: Number.isFinite(citation.line) ? Math.trunc(citation.line) : undefined,
            symbol: citation.symbol ?? undefined,
            text: `${toPosix(citation.path)}${Number.isFinite(citation.line) ? `:${Math.trunc(citation.line)}` : ''}${citation.symbol ? `#${citation.symbol}` : ''}`,
          })),
          confidence: claim.confidence ?? 'medium',
          ambiguous: verdicts.some((entry) => entry.verdict.ambiguous),
        })
      }
      return {
        kept,
        dropped,
        report: {
          claims: (claims ?? []).length,
          kept: kept.length,
          dropped: dropped.length,
          citationDropRate: checkedCitations === 0 ? 0 : droppedCitations / checkedCitations,
        },
      }
    },

    /**
     * 清洗自由文本：删掉含无效引用的句子，保留其余内容。
     * 返回清洗后的文本与被删句子的原因清单。
     * @param text 待清洗文本。
     * @param cleanOptions.dropMarker 被删句子的占位标记（默认空，即直接删除）。
     */
    sanitizeText(text, cleanOptions = {}) {
      const dropMarker = cleanOptions.dropMarker ?? ''
      const raw = String(text ?? '')
      const sentences = raw.split(/(?<=[。！？!?\n])/)
      const kept = []
      const dropped = []
      for (const sentence of sentences) {
        if (sentence.trim().length === 0) {
          kept.push(sentence)
          continue
        }
        const report = validator.checkText(sentence)
        if (report.ok) kept.push(sentence)
        else {
          dropped.push({ text: sentence.trim(), reasons: report.dropped.map((entry) => entry.reason) })
          if (dropMarker.length > 0) kept.push(dropMarker)
        }
      }
      return { text: kept.join(''), dropped }
    },

    /** 验证器自身的使用统计，写进报告元信息。 */
    stats() {
      return { checkedTexts, checkedCitations, droppedCitations, files: files.length, symbols: symbols.length }
    },
  }

  return validator
}
