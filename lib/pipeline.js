/**
 * 产物编排：把 IR/图谱/洞察变成磁盘上的 6 份报告，以及本地 RAG 索引与问答。
 *
 * 工具层只做参数校验与"给人看的一句话总结"，真正的编排在这里，
 * 这样 CLI（`scripts/compass-cli.mjs`）与 DSH 工具走的是同一条路径，
 * 不会出现"命令行能跑、工具里跑不通"的双实现漂移。
 *
 * @module dsh-project-compass/pipeline
 */

import { readFileSync } from 'node:fs'
import { absPath, reportPaths } from './paths.js'
import { writeJsonFile, writeTextFile } from './store.js'
import { clip } from './util.js'
import { renderReports } from './report.js'
import { buildIndex, indexStats, loadIndex, saveIndex, updateIndex, answer as ragAnswer } from './rag.js'
import { detectFlows } from './flows.js'
import { buildGraphs } from './graph.js'
import { buildInsights } from './insights.js'
import { EVIDENCE_POLICY, VERSION } from './version.js'
import { createValidator } from './validate.js'

/** 报告键顺序（与 `lib/paths.js` 的 REPORT_ORDER 保持一致）。 */
export const REPORT_KEYS = ['onboarding', 'architecture', 'moduleMap', 'keyFlows', 'gettingStarted', 'json']

/** 索引预读的默认上限：避免为了 RAG 把整个仓库读进内存。 */
const DEFAULT_PRELOAD_BYTES = 32 * 1024 * 1024

/**
 * 生成 6 份报告并落盘。
 *
 * @param root 项目根。
 * @param input.ir 统一 IR（必需）。
 * @param input.profile 扫描画像。
 * @param input.graph 图谱（缺省则从 IR 重建）。
 * @param input.flows 关键流程（缺省则重算）。
 * @param input.llm LLM 客户端（`withLlm` 时才真正被调用）。
 * @param input.withLlm 是否允许调用 LLM 生成叙事。
 * @param input.outputDir 报告目录（相对项目根）。
 * @param input.role 只渲染某个角色（可选）。
 * @param input.maxNodes Mermaid 节点上限。
 * @returns `{ paths, meta, insights, validation }`
 */
export async function generateReports(root, input = {}) {
  const ir = input.ir
  if (ir === undefined || ir === null) throw new Error('缺少 IR，无法生成报告（请先运行 analyze）')
  const graph = input.graph ?? (ir.graph?.stats?.fileNodes > 0 ? ir.graph : buildGraphs(ir))
  const flows = input.flows ?? detectFlows(ir)
  const validator = input.validator ?? createValidator(ir)
  const profile = input.profile ?? ir.profileSummary ?? null

  const insights = input.insights ?? (await buildInsights({
    ir,
    profile,
    graph,
    flows,
    llm: input.llm,
    validator,
    options: {
      withLlm: input.withLlm === true,
      maxRisks: input.maxRisks,
      maxChars: input.briefMaxChars,
      signal: input.signal,
    },
  }))

  const model = {
    ir,
    profile,
    graph,
    flows,
    insights,
    meta: {
      generatedAt: new Date().toISOString(),
      version: VERSION,
      evidencePolicy: EVIDENCE_POLICY,
      llm: insights.llm,
      validation: insights.validation,
    },
  }

  const rendered = renderReports(model, {
    projectName: ir.name,
    includeMermaid: input.includeMermaid !== false,
    maxNodes: input.maxNodes,
    role: input.role,
    locale: input.locale ?? 'zh',
  })

  const paths = reportPaths(root, input.outputDir)
  const written = {}
  for (const key of REPORT_KEYS) {
    const target = paths[key]
    if (key === 'json') {
      await writeJsonFile(target, rendered.files.json ?? {})
      written[key] = target
      continue
    }
    const content = typeof rendered.files[key] === 'string' ? rendered.files[key] : ''
    await writeTextFile(target, content.endsWith('\n') ? content : `${content}\n`)
    written[key] = target
  }

  return {
    paths: written,
    reportDir: paths.onboarding.replace(/[/\\][^/\\]+$/, ''),
    meta: rendered.meta,
    insights,
    validation: validator.stats(),
  }
}

/**
 * 为 RAG 预读源码：**先异步批量读**，再交给同步的 `chunkIR`。
 *
 * `chunkIR` 的读取器是同步签名，而逐个 `readFileSync` 会把整个仓库的 I/O
 * 变成串行阻塞；这里用小并发异步读完再交出去，两头都不牺牲。
 *
 * @returns `{ readText, files, bytes }`
 */
export async function preloadSources(root, ir, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(0, Math.trunc(options.maxBytes)) : DEFAULT_PRELOAD_BYTES
  const maxFileBytes = Number.isFinite(options.maxFileBytes) ? Math.trunc(options.maxFileBytes) : 256 * 1024
  const contents = new Map()
  let bytes = 0

  const candidates = (ir?.files ?? [])
    .filter((file) => file.kind !== 'asset' && file.kind !== 'generated')
    .filter((file) => (Number(file.bytes) || 0) <= maxFileBytes)
    .sort((a, b) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0))

  // 先读大文件：命中预算上限时，收益最大的一批已经在内存里了
  for (const file of candidates) {
    const size = Number(file.bytes) || 0
    if (bytes + size > maxBytes) continue
    try {
      contents.set(file.id, readFileSync(absPath(root, file.id), 'utf8'))
      bytes += size
    } catch {
      // 读不到就让它走"元信息摘要"降级路径
    }
  }

  return {
    files: contents.size,
    bytes,
    readText: (fileId) => contents.get(fileId),
  }
}

/**
 * 构建（或增量更新）本地 RAG 索引并落盘。
 *
 * @param input.changedFiles 增量更新的文件列表；缺省表示全量重建。
 * @param input.previous 既有索引（缺省时尝试从磁盘读取）。
 * @returns `{ index, stats, path, mode, preload }`
 */
export async function buildSearchIndex(root, ir, input = {}) {
  const preload = await preloadSources(root, ir, {
    maxBytes: input.maxIndexBytes,
    maxFileBytes: input.maxFileBytes,
  })
  const chunkOptions = {
    readText: preload.readText,
    maxChunks: input.maxChunks,
    maxChunksPerFile: input.maxChunksPerFile,
    maxChunkChars: input.maxChunkChars,
    dim: input.dim,
    concurrency: input.concurrency,
  }

  const changed = Array.isArray(input.changedFiles) ? input.changedFiles : null
  const previous = input.previous ?? (changed === null ? undefined : await loadIndex(root))

  let index
  let mode
  if (changed !== null && previous !== undefined && previous !== null && (previous.chunks?.length ?? 0) > 0) {
    index = updateIndex(previous, ir, changed, chunkOptions)
    mode = 'incremental'
  } else {
    index = await buildIndex(root, ir, chunkOptions)
    mode = 'full'
  }
  const path = await saveIndex(root, index)
  return { index, stats: indexStats(index), path, mode, preload: { files: preload.files, bytes: preload.bytes } }
}

/**
 * 项目级问答：优先用磁盘索引；索引缺失时才现场构建。
 * @returns Answer（`lib/rag.js` 的形状）。
 */
export async function askQuestion(root, ir, question, input = {}) {
  let index = input.index
  let rebuilt = false
  if (index === undefined || index === null) {
    index = await loadIndex(root)
    if ((index?.chunks?.length ?? 0) === 0 && input.buildIfMissing !== false && ir !== undefined && ir !== null) {
      const built = await buildSearchIndex(root, ir, { maxChunks: input.maxChunks })
      index = built.index
      rebuilt = true
    }
  }
  const validator = input.validator ?? (ir === undefined || ir === null ? undefined : createValidator(ir))
  const result = await ragAnswer(root, ir, question, {
    index,
    limit: input.limit,
    withLlm: input.withLlm === true,
    llmClient: input.llm,
    validator,
    signal: input.signal,
  })
  return { ...result, indexRebuilt: rebuilt }
}

/** 报告目录下的文件清单（供 status 汇报）。 */
export function reportFilePaths(root, outputDir) {
  return reportPaths(root, outputDir)
}

/** 一句话总结报告产物（工具返回值与 CLI 都用它）。 */
export function describeReportResult(result, ir) {
  const counts = result.meta?.counts ?? {}
  return [
    `已生成 6 份产物到 ${result.reportDir}`,
    `模块 ${counts.modules ?? 0} / 文件 ${counts.files ?? 0} / 符号 ${counts.symbols ?? 0} / 路由 ${counts.routes ?? 0} / 流程 ${counts.flows ?? 0}`,
    `风险条目 ${counts.risks ?? 0}`,
    result.meta?.llm?.used === true
      ? `LLM 叙事：已启用（${result.meta.llm.provider}/${result.meta.llm.model}），验证器丢弃 ${result.meta.validation?.droppedCount ?? 0} 条无据断言`
      : `LLM 叙事：未启用（${clip(result.insights?.llm?.reason ?? '默认关闭', 120)}），全部结论来自静态证据`,
    `项目规模：${ir?.stats?.loc ?? 0} 行 / ${ir?.stats?.files ?? 0} 文件`,
  ].join('；')
}
