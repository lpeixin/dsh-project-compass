/**
 * 分析编排（FR1→FR5 的主流水线）：扫描 → 读文件 → 解析（带增量缓存）→ IR → 图谱 → 流程。
 *
 * 分层意图：本模块是**唯一**把 scan / parse / cache / ir / graph / flows 串起来的地方，
 * 因此预算控制、并发、进度、降级都只在这里实现一次；工具层只负责参数校验与落盘。
 *
 * 两个刻意的取舍：
 *   1. 每轮都会读一遍文件内容——因为内容哈希是"是否复用解析结果"的唯一权威依据，
 *      靠 mtime + size 走捷径会在 checkout/回滚场景下给出错误的增量结果；
 *   2. 解析失败不中断整体分析：单个文件降级为"无符号"，问题记进 warnings，
 *      一个 YAML 里塞了段坏代码不该让整份报告失败。
 *
 * @module dsh-project-compass/analyze
 */

import { absPath } from './paths.js'
import { readTextFile } from './store.js'
import { clip, countLines, hashContent, mapLimit, uniq } from './util.js'
import { cacheKey, createCache, PARSER_VERSION } from './cache.js'
import { buildIR, fileKindOf } from './ir.js'
import { buildGraphs } from './graph.js'
import { detectFlows } from './flows.js'
import { detectLanguage, isDeepLanguage, parseFile } from './parse/index.js'
import { scanProject } from './scan.js'

/** 默认预算：默认值偏保守，宁可截断也要保证一次分析不会跑爆。 */
export const DEFAULT_BUDGET = {
  maxFiles: 20000,
  maxFileBytes: 262144,
  maxTotalBytes: 64 * 1024 * 1024,
  maxDurationMs: 10 * 60 * 1000,
  maxChunks: 20000,
}

/**
 * 跑完整分析流水线。
 *
 * @param root 项目根（绝对路径）。
 * @param options.profile 复用既有扫描画像（省一次遍历）。
 * @param options.scanOptions 传给 `scanProject` 的选项。
 * @param options.cache 既有缓存实例；传 `false` 关闭缓存。
 * @param options.force 忽略缓存，强制重新解析。
 * @param options.concurrency 解析并发（默认 8）。
 * @param options.budget 覆盖默认预算。
 * @param options.onProgress `({phase, done, total, message}) => void`。
 * @param options.signal AbortSignal。
 * @param options.now 注入时间（测试确定性）。
 * @returns Analysis `{ ir, profile, graph, flows, budget, cache, cacheKeys, warnings }`。
 */
export async function analyzeProject(root, options = {}) {
  const started = Date.now()
  const budgetLimits = { ...DEFAULT_BUDGET, ...(options.budget ?? {}) }
  const concurrency = Number.isFinite(options.concurrency) ? Math.max(1, Math.trunc(options.concurrency)) : 8
  const report = (phase, done, total, message) => {
    try {
      options.onProgress?.({ phase, done, total, message })
    } catch {
      // 进度回调是观察者，不能影响分析
    }
  }
  const aborted = () => options.signal?.aborted === true

  report('scan', 0, 1, '扫描项目结构')
  const profile = options.profile ?? (await scanProject(root, {
    ...(options.scanOptions ?? {}),
    maxFiles: budgetLimits.maxFiles,
    maxFileBytes: budgetLimits.maxFileBytes,
    maxTotalBytes: budgetLimits.maxTotalBytes,
    maxDurationMs: Math.max(1000, budgetLimits.maxDurationMs - (Date.now() - started)),
    now: options.now,
  }))

  const warnings = [...(profile?.warnings ?? [])]
  const sources = Array.isArray(profile?.sources) ? profile.sources : []
  if (sources.length === 0 && (profile?.size?.sourceFiles ?? 0) > 0) {
    warnings.push('扫描画像缺少文件清单（sources），本轮没有可解析的源文件。')
  }

  const cache = options.cache === false
    ? await createCache(root, { enabled: false })
    : options.cache ?? (await createCache(root, { parserVersion: PARSER_VERSION }))

  const stats = {
    candidates: sources.length,
    analyzed: 0,
    skippedSensitive: 0,
    skippedBinary: 0,
    skippedLarge: 0,
    skippedBudget: 0,
    bytesRead: 0,
    cacheHits: 0,
    cacheMisses: 0,
    parseErrors: 0,
  }

  /* ---------------- 候选筛选 ---------------- */
  const candidates = []
  let totalBytes = 0
  for (const source of sources) {
    if (source === undefined || source === null || typeof source.path !== 'string') continue
    if (source.sensitive === true) {
      stats.skippedSensitive += 1
      continue
    }
    if (source.binary === true) {
      stats.skippedBinary += 1
      continue
    }
    const bytes = Number(source.bytes) || 0
    if (bytes > budgetLimits.maxFileBytes) {
      stats.skippedLarge += 1
      continue
    }
    if (candidates.length >= budgetLimits.maxFiles) {
      stats.skippedBudget += 1
      continue
    }
    if (totalBytes + bytes > budgetLimits.maxTotalBytes) {
      stats.skippedBudget += 1
      continue
    }
    totalBytes += bytes
    candidates.push(source)
  }
  if (stats.skippedBudget > 0) {
    warnings.push(`预算限制：${stats.skippedBudget} 个文件未纳入分析（maxFiles=${budgetLimits.maxFiles}，maxTotalBytes=${budgetLimits.maxTotalBytes}）。`)
  }
  if (stats.skippedLarge > 0) warnings.push(`${stats.skippedLarge} 个文件超过单文件上限（${budgetLimits.maxFileBytes} 字节）被跳过。`)

  /* ---------------- 读取 + 解析（带缓存） ---------------- */
  let processed = 0
  const fileInputs = await mapLimit(
    candidates,
    concurrency,
    async (source) => {
      processed += 1
      if (processed % 200 === 0) report('parse', processed, candidates.length, `解析 ${processed}/${candidates.length}`)
      if (aborted()) return undefined
      if (Date.now() - started > budgetLimits.maxDurationMs) {
        stats.skippedBudget += 1
        return undefined
      }

      const relative = source.path
      const language = source.language ?? detectLanguage(relative)
      const content = await readTextFile(absPath(root, relative), undefined)
      if (content === undefined) {
        return { id: relative, language, loc: Number(source.loc) || 0, bytes: Number(source.bytes) || 0, hash: null, parse: 'skipped', parsed: emptyParsed(language), warnings: ['文件不可读，已跳过'] }
      }
      stats.bytesRead += Buffer.byteLength(content, 'utf8')
      const hash = hashContent(content)
      const loc = Number(source.loc) || countLines(content)

      const cached = options.force === true ? undefined : await cache.get(relative, hash, language)
      let parsed
      let parseMode = isDeepLanguage(language) ? 'deep' : 'light'
      const fileWarnings = []
      if (cached !== undefined) {
        parsed = cached
        stats.cacheHits += 1
      } else {
        stats.cacheMisses += 1
        try {
          parsed = parseFile({ relPath: relative, content, language, fileId: relative })
        } catch (error) {
          stats.parseErrors += 1
          fileWarnings.push(`解析失败，已降级为无符号文件：${clip(error instanceof Error ? error.message : String(error), 200)}`)
          parsed = emptyParsed(language)
          parseMode = 'skipped'
        }
        await cache.put(relative, hash, language, parsed)
      }
      for (const note of parsed?.notes ?? []) fileWarnings.push(String(note))
      stats.analyzed += 1

      return {
        id: relative,
        language,
        kind: source.kind ?? fileKindOf(relative, language),
        loc,
        bytes: Number(source.bytes) || Buffer.byteLength(content, 'utf8'),
        hash,
        parse: parseMode,
        parsed,
        warnings: uniq(fileWarnings).slice(0, 10),
      }
    },
    (error, source) => {
      stats.parseErrors += 1
      warnings.push(`处理 ${source?.path ?? '未知文件'} 时出错：${clip(error instanceof Error ? error.message : String(error), 200)}`)
    },
  )

  const files = fileInputs.filter((entry) => entry !== undefined)
  report('ir', files.length, candidates.length, '装配统一 IR')

  /* ---------------- IR / 图谱 / 流程 ---------------- */
  const ir = buildIR({
    root,
    name: profile?.name ?? undefined,
    profile,
    files,
    generatedAt: options.now === undefined ? undefined : new Date(options.now).toISOString(),
    budget: {
      filesAnalyzed: stats.analyzed,
      filesSkipped: stats.skippedSensitive + stats.skippedBinary + stats.skippedLarge + stats.skippedBudget,
      bytesRead: stats.bytesRead,
      durationMs: Date.now() - started,
      llmCalls: 0,
    },
    warnings,
    truncated: profile?.truncated === true || stats.skippedBudget > 0,
  })

  report('graph', 0, 1, '构建依赖图谱与关键流程')
  const graph = buildGraphs(ir, options.graphOptions ?? {})
  ir.graph = graph
  const flows = detectFlows(ir, options.flowOptions ?? {})

  const cacheKeys = files
    .filter((file) => file.hash !== null)
    .map((file) => cacheKey({ hash: file.hash, language: file.language, parserVersion: cache.parserVersion }))

  ir.budget.durationMs = Date.now() - started
  ir.budget.llmCalls = 0

  report('done', 1, 1, '分析完成')

  return {
    ir,
    profile,
    graph,
    flows,
    cache,
    cacheKeys,
    warnings: ir.warnings,
    stats: { ...stats, durationMs: Date.now() - started },
    budget: budgetLimits,
  }
}

/** 空解析结果：降级路径与数据类文件共用。 */
export function emptyParsed(language) {
  return { language, symbols: [], imports: [], calls: [], routes: [], exports: [], todos: [], notes: [] }
}
