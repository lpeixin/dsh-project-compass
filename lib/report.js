/**
 * 报告渲染层（FR8 五份 Markdown + FR11 多角色阅读路线 + IR 摘要 JSON）。
 *
 * 硬性约束：
 *   - **纯函数**：不读盘、不调 LLM、不抛错；数据缺失时输出"数据不足 + 原因"；
 *   - 零外部依赖：只 import `node:*` 之外的仓库内相对模块（本文件只用 util / paths / mermaid）；
 *   - 每条结论后附静态证据（`path:line` 或 `path#symbol`）；无证据的推断显式标注"未验证"；
 *   - 表格中的路径用反引号代码格式，不用 Markdown 链接（避免在目标项目里产生坏链接）。
 *
 * @module dsh-project-compass/report
 */

import {
  cite,
  formatBytes,
  groupBy,
  jsonSafe,
  mermaidSafe,
  nowIso,
  sortBy,
  sum,
  uniq,
} from './util.js'
import { REPORT_ORDER } from './paths.js'
import {
  architectureDiagram,
  fileGraphDiagram,
  flowDiagram,
  moduleGraphDiagram,
} from './mermaid.js'

/** 工具名（写入每份报告元信息块与 JSON 视图）。 */
const TOOL_NAME = 'dsh-project-compass'
/** 工具版本兜底值（meta.version 缺失时使用）。 */
const DEFAULT_VERSION = '0.1.0'
/** JSON 视图 schema 版本。 */
const SCHEMA_VERSION = 1
/** 流程图节点上限默认值。 */
const DEFAULT_MAX_NODES = 40
/** 证据口径说明（写入元信息块与 JSON evidence 段）。 */
const EVIDENCE_POLICY = '文件级事实标注真实静态证据（`path:line` / `path#symbol`，整文件级引用统一记为 `path:1`）；**聚合类数字**（规模、计数、环数、语言分布等）只标注数据来源（`project-compass.json` / `.project-compass/scan.json`），不借用源文件当证据。无证据的推断显式标注"未验证"。'

/**
 * 聚合类事实的数据来源（绝不借用某个源文件当证据）。
 * 键与报告里用到的数据域一一对应。
 */
const DATA_SOURCES = {
  ir: '来自 IR 统计（project-compass.json:stats）',
  modules: '来自 IR 模块记录（project-compass.json:modules）',
  graph: '来自依赖图谱（project-compass.json:graph.stats）',
  routes: '来自 IR 路由记录（project-compass.json:routes）',
  flows: '来自流程分析（project-compass.json:flows）',
  scan: '来自扫描画像（.project-compass/scan.json）',
  analysis: '由本次静态分析聚合得出',
}

/** 取聚合类事实的数据来源说明。 */
function sourceNote(kind) {
  return DATA_SOURCES[kind] ?? DATA_SOURCES.analysis
}

/** 五个角色的固定目录（FR11）。 */
const ROLES = [
  { id: 'backend', label: '后端', focus: 'HTTP/CLI 入口、路由与处理函数、服务与数据访问层' },
  { id: 'frontend', label: '前端', focus: '页面与组件、样式与构建配置、前端入口' },
  { id: 'test', label: '测试', focus: '测试框架、用例与夹具、覆盖率与端到端配置' },
  { id: 'devops', label: '运维/部署', focus: '容器镜像、CI/CD、基础设施即代码与运行命令' },
  { id: 'data', label: '数据', focus: '数据模型、迁移脚本、SQL 与持久化依赖' },
]

/* ------------------------------------------------------------------ *
 * 取值与格式化工具（全部容错，绝不抛错）
 * ------------------------------------------------------------------ */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asObject(value) {
  return isObject(value) ? value : {}
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asText(value, fallback = '') {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function num(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback
}

function firstFinite(...values) {
  for (const value of values) if (Number.isFinite(value)) return value
  return 0
}

/** 反引号代码格式（表格里的路径一律用这个，不用链接）。 */
function code(value) {
  return `\`${String(value ?? '').replace(/`/g, "'")}\``
}

/** Markdown 表格单元格：转义竖线与换行。 */
function cell(value) {
  const text = value === undefined || value === null || value === '' ? '—' : String(value)
  return text.replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim()
}

function table(headers, rows) {
  const head = `| ${asArray(headers).map(cell).join(' | ')} |`
  const sep = `| ${asArray(headers).map(() => '---').join(' | ')} |`
  const body = asArray(rows).map((row) => `| ${asArray(row).map(cell).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

/** 单条证据渲染：`path:line` / `path#symbol` / 无证据标记。 */
function ev(path, line, symbol) {
  const target = asText(path)
  if (!target) return '（无证据）'
  return code(cite(target, { line: Number.isFinite(line) ? line : undefined, symbol: asText(symbol) || undefined }).text)
}

/** 整文件级引用：统一记为文件起始，口径见 EVIDENCE_POLICY。 */
function evFile(path) {
  return ev(path, 1)
}

/** 证据串里的位置（`path:line`），解析不出行号时返回 1（文件起始）。 */
function parseEvidence(value) {
  if (isObject(value)) {
    return {
      path: looksLikePathSegment(value.path) ? asText(value.path) : '',
      line: Number.isFinite(value.line) ? Math.trunc(value.line) : undefined,
      text: asText(value.text),
    }
  }
  const text = asText(value)
  const match = text.match(/^([^\s:]+):(\d+)$/)
  if (match && looksLikePathSegment(match[1])) return { path: match[1], line: Number(match[2]), text }
  // 复合证据串（`a.js:1；package.json:scripts.test:1`）里提取第一个可引用的 `path:line`；
  // 散文式证据（`HTTP 服务创建调用 (行 5)`）则不给引用——宁可不给，也绝不把散文伪造成 `path:line`
  for (const candidate of text.matchAll(/([^\s:;|,()（）；，]+):(\d+)/g)) {
    if (looksLikePathSegment(candidate[1])) return { path: candidate[1], line: Number(candidate[2]), text }
  }
  if (looksLikePathSegment(text)) return { path: text, line: undefined, text }
  return { path: '', line: undefined, text }
}

/** 证据串是否像一个真实路径片段（拒绝空白、CJK、标点堆叠与复合串）。 */
function looksLikePathSegment(value) {
  const text = asText(value)
  if (text.length === 0) return false
  if (/[\s;|,()（）；，、]/.test(text)) return false
  if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(text)) return false
  return true
}

/** 入口行号：只有证据里给出了同一路径的 `path:line` 才采信，否则按文件起始。 */
function entryLine(entry) {
  const target = asText(entry?.path)
  const parsed = parseEvidence(entry?.evidence)
  if (parsed.line !== undefined && parsed.path === target) return parsed.line
  return 1
}

/** 运行态入口 kind（优先于配置/测试类入口展示）。 */
const RUNTIME_ENTRY_KINDS = new Set(['http-server', 'cli', 'main', 'bin', 'worker', 'server'])

/** 入口排序：运行态入口在前，配置/测试入口在后（不丢数据）。 */
function orderedEntrypoints(ctx) {
  const runtime = []
  const rest = []
  for (const entry of ctx.entrypoints) {
    if (RUNTIME_ENTRY_KINDS.has(String(entry?.kind))) runtime.push(entry)
    else rest.push(entry)
  }
  return [...runtime, ...rest]
}

/** 报告元信息块（生成时间 / 项目 / 工具版本 / 证据口径 / LLM / 验证器丢弃条数）。 */
function metaBlock(ctx) {
  const llmLine = ctx.llm.used
    ? `**LLM 参与**：是（provider=${asText(ctx.llm.provider, '未知')}，model=${asText(ctx.llm.model, '未知')}${Number.isFinite(ctx.llm.calls) ? `，调用 ${ctx.llm.calls} 次` : ''}）`
    : '**LLM 参与**：否 —— 本报告全部结论来自静态证据，未调用 LLM'
  const lines = [
    `> **生成时间**：${ctx.generatedAt} ｜ **项目**：${code(ctx.projectName)} ｜ **工具版本**：${TOOL_NAME}@${ctx.version}`,
    `> **证据口径**：${EVIDENCE_POLICY}`,
    `> ${llmLine}`,
    `> **验证器**：丢弃 ${ctx.droppedCount} 条无静态证据支撑的声明。`,
  ]
  const sourceCount = `IR：模块 ${ctx.modules.length} / 文件 ${ctx.files.length} / 符号 ${ctx.symbols.length} / 路由 ${ctx.routes.length}；流程 ${ctx.flows.length} 条`
  lines.push(`> **数据来源**：${sourceCount}；扫描告警 ${ctx.warnings.length} 条。`)
  return lines.join('\n')
}

/** Mermaid 代码块（`includeMermaid=false` 时降级为说明）。 */
function mermaidBlock(source, opts) {
  if (opts.includeMermaid === false) {
    return '> 已禁用 Mermaid 渲染（`options.includeMermaid = false`），此处省略图表源码。'
  }
  return ['```mermaid', String(source ?? ''), '```'].join('\n')
}

/** 统一的"数据不足"段落。 */
function dataGap(reason, suggestions = []) {
  const lines = [`**数据不足**：${reason}`]
  if (suggestions.length > 0) {
    lines.push('')
    lines.push('替代做法：')
    lines.push(...suggestions.map((item, index) => `${index + 1}. ${item}`))
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 输入准备
 * ------------------------------------------------------------------ */

function llmInfo(raw) {
  if (raw === true) return { used: true, provider: '', model: '', calls: null, reason: '' }
  if (isObject(raw)) {
    return {
      used: raw.used === true,
      provider: asText(raw.provider),
      model: asText(raw.model),
      calls: Number.isFinite(raw.calls) ? raw.calls : null,
      reason: asText(raw.reason),
    }
  }
  return { used: false, provider: '', model: '', calls: null, reason: '' }
}

function droppedCountOf(validation) {
  if (Number.isFinite(validation?.droppedCount)) return validation.droppedCount
  if (Array.isArray(validation?.dropped)) return validation.dropped.length
  if (Number.isFinite(validation?.dropped)) return validation.dropped
  return 0
}

function normalizeOptions(options) {
  const source = asObject(options)
  return {
    projectName: asText(source.projectName),
    version: asText(source.version),
    generatedAt: asText(source.generatedAt),
    includeMermaid: source.includeMermaid !== false,
    maxNodes: Number.isFinite(source.maxNodes) && source.maxNodes > 0 ? Math.trunc(source.maxNodes) : DEFAULT_MAX_NODES,
    topModules: Number.isFinite(source.topModules) && source.topModules > 0 ? Math.trunc(source.topModules) : 10,
    maxFiles: Number.isFinite(source.maxFiles) && source.maxFiles > 0 ? Math.trunc(source.maxFiles) : 2000,
    maxSymbols: Number.isFinite(source.maxSymbols) && source.maxSymbols > 0 ? Math.trunc(source.maxSymbols) : 2000,
    maxRoutes: Number.isFinite(source.maxRoutes) && source.maxRoutes > 0 ? Math.trunc(source.maxRoutes) : 500,
    role: source.role === undefined ? null : source.role,
    locale: asText(source.locale, 'zh'),
  }
}

function languageRowsFromIr(value) {
  if (Array.isArray(value)) return value.filter(isObject)
  if (isObject(value)) {
    return Object.entries(value).map(([name, info]) => (isObject(info) ? { name, ...info } : { name, files: Number(info) || 0 }))
  }
  return []
}

function cyclesOf(graph) {
  const source = asObject(graph)
  const moduleCycles = asArray(asObject(source.module).cycles)
  if (moduleCycles.length > 0) return moduleCycles
  return asArray(asObject(source.file).cycles)
}

/** 汇总所有渲染需要的数据（全部字段容错，缺失即空）。 */
function prepare(model, options) {
  const safeModel = asObject(model)
  const ir = asObject(safeModel.ir)
  const profile = asObject(safeModel.profile)
  const graph = asObject(safeModel.graph)
  const metrics = asObject(graph.metrics)
  const insights = asObject(safeModel.insights)
  const meta = asObject(safeModel.meta)

  const modules = asArray(ir.modules).filter(isObject)
  const files = asArray(ir.files).filter(isObject)
  const symbols = asArray(ir.symbols).filter(isObject)
  const routes = asArray(ir.routes).filter(isObject)

  const moduleById = new Map()
  for (const module of modules) moduleById.set(String(module.id ?? ''), module)
  const fileById = new Map()
  for (const file of files) fileById.set(String(file.id ?? ''), file)

  // 模块级入度/出度：契约 §5 的 metrics.fanIn/fanOut 在实现里是**文件级**的，
  // 因此模块度必须由 graph.module.edges 现算；图缺失时再尝试 metrics（按模块 id 命中）。
  const moduleEdges = asArray(asObject(graph.module).edges).filter(isObject)
  const moduleFanIn = {}
  const moduleFanOut = {}
  for (const edge of moduleEdges) {
    const from = String(edge.from ?? '')
    const to = String(edge.to ?? '')
    if (!from || !to || from === to) continue
    moduleFanOut[from] = (moduleFanOut[from] ?? 0) + 1
    moduleFanIn[to] = (moduleFanIn[to] ?? 0) + 1
  }
  if (moduleEdges.length === 0) {
    const metricIn = asObject(metrics.fanIn)
    const metricOut = asObject(metrics.fanOut)
    for (const module of modules) {
      const id = String(module.id ?? '')
      if (!id) continue
      if (Number.isFinite(metricIn[id])) moduleFanIn[id] = metricIn[id]
      if (Number.isFinite(metricOut[id])) moduleFanOut[id] = metricOut[id]
    }
  }

  const irStats = asObject(ir.stats)
  const profileSize = asObject(profile.size)
  const tests = asObject(profile.tests)
  const deps = asObject(profile.deps)
  const languages = asArray(profile.languages).length > 0 ? asArray(profile.languages).filter(isObject) : languageRowsFromIr(irStats.languages)

  const ctx = {
    model: safeModel,
    ir,
    profile,
    graph,
    metrics,
    insights,
    meta,
    modules,
    files,
    symbols,
    routes,
    moduleById,
    fileById,
    moduleFanIn,
    moduleFanOut,
    fileFanIn: asObject(metrics.fanIn),
    fileFanOut: asObject(metrics.fanOut),
    flows: asArray(safeModel.flows).filter(isObject),
    hubs: asArray(metrics.hubs).filter(isObject),
    riskModules: asArray(metrics.riskModules).filter(isObject),
    orphans: asArray(metrics.orphans),
    cycles: cyclesOf(graph).filter(Array.isArray),
    moduleEdges,
    fileEdges: asArray(asObject(graph.file).edges).filter(isObject),
    graphStats: asObject(graph.stats),
    entrypoints: asArray(profile.entrypoints).filter(isObject),
    commands: asArray(profile.commands).filter(isObject),
    configs: asArray(profile.configs).filter(isObject),
    docs: asArray(profile.docs),
    ci: asArray(profile.ci).filter(isObject),
    containers: asArray(profile.containers),
    iac: asArray(profile.iac),
    ecosystems: asArray(profile.ecosystems).filter(isObject),
    kinds: asArray(profile.kinds),
    tests,
    deps,
    signals: asObject(profile.signals),
    gaps: asArray(profile.gaps).filter(isObject),
    warnings: uniq([...asArray(profile.warnings), ...asArray(ir.warnings)].map((item) => String(item))),
    size: profileSize,
    irStats,
    languages,
    truncated: ir.truncated === true || profile.truncated === true,
    budget: asObject(ir.budget),
  }

  ctx.projectName = asText(options?.projectName) || asText(ir.name) || asText(profile.name) || '未命名项目'
  ctx.version = asText(options?.version) || asText(meta.version) || DEFAULT_VERSION
  ctx.generatedAt = asText(options?.generatedAt) || asText(meta.generatedAt) || nowIso()
  ctx.llm = llmInfo(meta.llm)
  ctx.droppedCount = droppedCountOf(asObject(meta.validation))
  ctx.hasIr = modules.length > 0 || files.length > 0 || symbols.length > 0
  return ctx
}

/* ------------------------------------------------------------------ *
 * 统计小工具
 * ------------------------------------------------------------------ */

function fileCount(ctx) {
  return firstFinite(num(ctx.irStats.files, NaN), num(ctx.size.files, NaN), ctx.files.length)
}

function sourceFileCount(ctx) {
  return firstFinite(num(ctx.irStats.sourceFiles, NaN), num(ctx.size.sourceFiles, NaN), ctx.files.length)
}

function locCount(ctx) {
  return firstFinite(num(ctx.irStats.loc, NaN), sum(ctx.files.map((file) => num(file.loc))))
}

function symbolCount(ctx) {
  return firstFinite(num(ctx.irStats.symbols, NaN), ctx.symbols.length)
}

function topLanguageName(ctx) {
  if (ctx.languages.length === 0) return ctx.hasIr ? '未知语言（IR 未提供语言统计）' : '未知'
  const best = ctx.languages.slice().sort((a, b) => num(b.loc) - num(a.loc) || num(b.files) - num(a.files) || String(a.name).localeCompare(String(b.name)))[0]
  return asText(best?.name, '未知')
}

function languageText(ctx) {
  if (ctx.languages.length === 0) return '未知'
  return ctx.languages.slice(0, 6).map((item) => `${asText(item.name, '未知')}(${num(item.files)} 文件/${num(item.loc)} 行)`).join('、')
}

/** 核心模块排序：连接度优先，其次 LOC 与符号数。 */
function topModules(ctx, limit) {
  const ranked = ctx.modules.map((module) => {
    const id = String(module.id ?? '')
    const degree = num(ctx.moduleFanIn[id]) + num(ctx.moduleFanOut[id])
    const score = degree * 100000 + num(module.loc) + num(module.symbolCount) * 10
    return { module, id, score }
  })
  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return ranked.slice(0, limit).map((item) => item.module)
}

function filesOfModule(ctx, moduleId) {
  const id = String(moduleId ?? '')
  return ctx.files.filter((file) => String(file.moduleId ?? '') === id)
}

function symbolsOfModule(ctx, moduleId) {
  const id = String(moduleId ?? '')
  return ctx.symbols.filter((symbol) => String(symbol.moduleId ?? '') === id)
}

function firstFileOfModule(ctx, module) {
  const id = String(module?.id ?? '')
  const declared = asArray(module?.files).map((item) => String(item))
  if (declared.length > 0) return declared[0]
  const found = filesOfModule(ctx, id)[0]
  return found ? String(found.id) : ''
}

/** 模块级证据：该模块的首个文件（文件起始）。 */
function moduleEvidence(ctx, module) {
  const file = firstFileOfModule(ctx, module)
  return file ? evFile(file) : ev(asText(module?.dir) || asText(module?.id, '.'), 1)
}

function cycleIds(ctx) {
  const ids = new Set()
  for (const cycle of ctx.cycles) for (const id of asArray(cycle)) ids.add(String(id))
  return ids
}

function riskOfModule(ctx, module) {
  const declared = asText(module?.risk)
  if (declared) return declared
  const hit = ctx.riskModules.find((item) => String(item.id) === String(module?.id))
  if (hit) return num(hit.score) > 0 ? `high(score ${num(hit.score)})` : 'high'
  return 'low'
}

/**
 * 供 Mermaid 使用的模块图数据：优先用 graph.module（含真实边权），
 * graph 缺失时用 IR 的 Module.dependsOn 合成，避免"有模块却画出空图"。
 */
function moduleGraphFor(ctx) {
  const bundle = asObject(ctx.graph)
  if (asArray(asObject(bundle.module).nodes).length > 0) return bundle
  if (ctx.modules.length === 0) return bundle
  const nodes = ctx.modules
    .map((module) => ({
      id: String(module?.id ?? ''),
      label: module?.name ?? module?.id ?? '未命名模块',
      kind: module?.kind,
      loc: num(module?.loc),
      files: asArray(module?.files).length,
      symbolCount: num(module?.symbolCount),
    }))
    .filter((node) => node.id.length > 0)
  const edges = []
  for (const module of ctx.modules) {
    const from = String(module?.id ?? '')
    if (!from) continue
    for (const target of asArray(module?.dependsOn)) {
      const to = String(target)
      if (to && to !== from) edges.push({ from, to, weight: 1 })
    }
  }
  return { module: { nodes, edges }, metrics: { fanIn: ctx.moduleFanIn, fanOut: ctx.moduleFanOut } }
}

/* ------------------------------------------------------------------ *
 * FR11：多角色阅读路线
 * ------------------------------------------------------------------ */

/** 角色目录（固定 5 个，顺序稳定）。 */
export function roleCatalogue() {
  return ROLES.map((role) => ({ id: role.id, label: role.label, focus: role.focus }))
}

function requestedRoles(role) {
  const ids = ROLES.map((item) => item.id)
  if (Array.isArray(role)) {
    const picked = role.map((item) => String(item)).filter((item) => ids.includes(item))
    return picked.length > 0 ? uniq(picked) : ids
  }
  if (typeof role === 'string' && ids.includes(role)) return [role]
  return ids
}

function makeRoute(role, focus) {
  return { role: role.id, label: role.label, focus: focus || role.focus, order: [], checklist: [] }
}

function pushStep(route, target, path, line, why) {
  if (route.order.length >= 12) return
  route.order.push({
    step: route.order.length + 1,
    target: String(target),
    path: asText(path) || null,
    line: Number.isFinite(line) ? Math.trunc(line) : null,
    why: String(why),
  })
}

/** 没有任何证据时的"明说缺失 + 替代建议"步骤（不编造路线）。 */
function pushMissing(route, what, alternative) {
  route.order.push({
    step: 1,
    target: `该项目无明显${what}证据`,
    path: null,
    line: null,
    why: alternative,
  })
}

/** insights.roles 只用于覆盖 focus 文案，不用于伪造路线。 */
function roleFocus(insights, role) {
  const roles = insights?.roles
  if (Array.isArray(roles)) {
    const hit = roles.find((item) => String(item?.id ?? item?.role) === role.id)
    if (hit && typeof hit.focus === 'string' && hit.focus.length > 0) return hit.focus
  }
  if (isObject(roles)) {
    const value = roles[role.id]
    if (typeof value === 'string' && value.length > 0) return value
    if (isObject(value) && typeof value.focus === 'string' && value.focus.length > 0) return value.focus
  }
  return role.focus
}

function backendRoute(role, ctx) {
  const route = makeRoute(role, roleFocus(ctx.insights, role))
  const entries = ctx.entrypoints.filter((item) => RUNTIME_ENTRY_KINDS.has(String(item.kind)))
  const sourceModules = ctx.modules.filter((module) => String(module.kind) === 'source')

  const seenEntry = new Set()
  for (const entry of entries.slice(0, 3)) {
    const key = `${asText(entry.path)}:${entryLine(entry)}`
    if (seenEntry.has(key)) continue
    seenEntry.add(key)
    pushStep(route, `阅读入口（${asText(entry.kind, 'entry')}）`, entry.path, entryLine(entry), `profile.entrypoints 识别为 ${asText(entry.kind, 'entry')}，证据 ${asText(entry.evidence, '未提供')}`)
  }

  const byModule = groupBy(ctx.routes, (item) => String(item.moduleId ?? '未归属'))
  const routeModules = [...byModule.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  for (const [moduleId, list] of routeModules.slice(0, 2)) {
    const first = list[0]
    pushStep(route, `路由集中模块 ${moduleId}（${list.length} 条路由）`, first.fileId, first.line, `IR 中该模块含 ${list.length} 条路由，如 ${asText(first.method, 'GET')} ${asText(first.path, '/')}`)
  }
  for (const item of ctx.routes.slice(0, 4)) {
    pushStep(route, `路由 ${asText(item.method, 'GET')} ${asText(item.path, '/')}`, item.fileId, item.line, `框架 ${asText(item.framework, '未知')}，处理器 ${asText(item.handlerName, '未识别')}`)
  }

  const serviceLike = ctx.symbols
    .filter((symbol) => /handler|controller|service|repository|usecase|resolver|middleware/i.test(String(symbol.name)))
    .map((symbol) => ({ symbol, score: num(symbol.fanIn) + num(symbol.fanOut) }))
    .sort((a, b) => b.score - a.score || String(a.symbol.name).localeCompare(String(b.symbol.name)))
  for (const item of serviceLike.slice(0, 4)) {
    pushStep(route, `服务/处理层符号 ${item.symbol.name}`, item.symbol.fileId, item.symbol.line, `kind=${asText(item.symbol.kind, 'unknown')}，fanIn=${num(item.symbol.fanIn)}，fanOut=${num(item.symbol.fanOut)}`)
  }

  for (const module of topModules(ctx, 2)) {
    if (!sourceModules.includes(module)) continue
    if (route.order.length >= 10) break
    pushStep(route, `通读核心模块 ${asText(module.id, '.')}`, firstFileOfModule(ctx, module), 1, `模块 LOC ${num(module.loc)}、符号 ${num(module.symbolCount)}，属入口可达的核心模块`)
  }

  if (route.order.length === 0) {
    pushMissing(route, '后端', '（未发现 HTTP 路由、CLI 入口或服务层符号）替代建议：从 profile.entrypoints 与 fanIn 最高的符号入手；若这是纯前端、库或数据项目，请改看 frontend/data 路线。')
  }

  route.checklist = [
    `确认全部 HTTP 路由与中间件（IR 记录 ${ctx.routes.length} 条）`,
    entries[0] ? `核对入口启动方式与配置读取（${code(cite(asText(entries[0].path), { line: entryLine(entries[0]) }).text)}）` : '入口未识别：检查 profile.entrypoints 为何为空',
    '检查服务层与数据访问层的边界是否清晰',
    ctx.cycles.length > 0 ? `排查 ${ctx.cycles.length} 处循环依赖（见 ARCHITECTURE.md）` : '确认模块依赖方向单一、无环',
    '补充关键路径的集成测试',
  ]
  return route
}

function frontendRoute(role, ctx) {
  const route = makeRoute(role, roleFocus(ctx.insights, role))
  const frontendLanguages = new Set(['tsx', 'jsx', 'vue', 'svelte', 'html', 'css', 'scss', 'less', 'astro'])
  const frontendFiles = ctx.files.filter((file) => {
    const language = String(file.language ?? '').toLowerCase()
    const id = String(file.id ?? '')
    return frontendLanguages.has(language) || /(^|\/)(pages|components|views|ui|screens|layouts)\//i.test(id) || /\.(tsx|jsx|vue|svelte|astro)$/i.test(id)
  })
  const components = ctx.symbols.filter((symbol) => String(symbol.kind) === 'component')
  const buildConfigs = ctx.configs.filter((config) => /vite|webpack|rollup|parcel|next\.config|nuxt|tailwind|svelte\.config|angular\.json/i.test(String(config.path)))
  const htmlEntries = ctx.entrypoints.filter((entry) => /\.html?$/i.test(String(entry.path)))

  for (const config of buildConfigs.slice(0, 2)) {
    pushStep(route, `前端构建配置 ${asText(config.path)}`, config.path, 1, `profile.configs 识别为 ${asText(config.kind, 'config')}`)
  }
  const byDir = groupBy(frontendFiles, (file) => String(file.id ?? '').split('/').slice(0, -1).join('/') || '.')
  const dirs = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  for (const [dir, list] of dirs.slice(0, 3)) {
    pushStep(route, `前端目录 ${dir}（${list.length} 个文件）`, list[0].id, 1, `语言分布：${uniq(list.map((file) => asText(file.language, 'unknown'))).join('、')}`)
  }
  for (const item of components.slice(0, 3)) {
    pushStep(route, `组件 ${item.name}`, item.fileId, item.line, `kind=component，fanIn=${num(item.fanIn)}`)
  }
  for (const entry of htmlEntries.slice(0, 1)) {
    pushStep(route, `页面入口 ${asText(entry.path)}`, entry.path, entryLine(entry), `profile.entrypoints 识别为 ${asText(entry.kind, 'entry')}`)
  }

  if (route.order.length === 0) {
    pushMissing(route, '前端', '（未发现组件、页面、样式或前端构建配置）替代建议：本项目可能是后端服务、库或数据项目；先看 backend 路线，再用语言分布确认是否存在模板与静态资源模块。')
  }

  route.checklist = [
    frontendFiles.length > 0 ? `确认前端文件范围（${frontendFiles.length} 个：${uniq(frontendFiles.map((file) => asText(file.language, 'unknown'))).slice(0, 5).join('、')}）` : '确认项目是否真的没有前端代码',
    buildConfigs.length > 0 ? `核对构建配置 ${buildConfigs.map((item) => asText(item.path)).join('、')}` : '未发现构建配置：确认前端是否由后端模板直接渲染',
    components.length > 0 ? `梳理组件层级（IR 记录 ${components.length} 个组件符号）` : '未发现组件符号：确认是否有模板/静态页面',
    '检查静态资源与样式是否被忽略规则排除',
  ]
  return route
}

function testRoute(role, ctx) {
  const route = makeRoute(role, roleFocus(ctx.insights, role))
  const frameworks = asArray(ctx.tests.frameworks).filter(isObject)
  const testFiles = asArray(ctx.tests.testFiles).map((item) => String(item))
  const testModules = ctx.modules.filter((module) => String(module.kind) === 'test')
  const discovered = ctx.files.filter((file) => /(^|\/)(tests?|__tests__|spec)\//i.test(String(file.id)) || /\.(test|spec)\.[a-z]+$/i.test(String(file.id)))
  const testCommands = ctx.commands.filter((command) => ['test', 'coverage', 'e2e'].includes(String(command.preset)))
  const coverageConfig = asArray(ctx.tests.coverageConfig).map((item) => String(item))

  for (const framework of frameworks.slice(0, 3)) {
    const location = parseEvidence(framework.evidence)
    pushStep(route, `测试框架 ${asText(framework.label, asText(framework.id, 'unknown'))}`, location.path, firstFinite(location.line, 1), `证据：${asText(location.text, 'profile.tests.frameworks')}`)
  }
  for (const file of testFiles.slice(0, 3)) {
    pushStep(route, `测试用例 ${file}`, file, 1, '来自 profile.tests.testFiles')
  }
  for (const file of discovered.slice(0, 3)) {
    pushStep(route, `测试文件 ${asText(file.id)}`, file.id, 1, `命中测试路径/命名约定，LOC ${num(file.loc)}`)
  }
  for (const module of testModules.slice(0, 2)) {
    pushStep(route, `测试模块 ${asText(module.id)}`, firstFileOfModule(ctx, module), 1, `模块 kind=test，文件 ${num(module.files?.length)} 个`)
  }
  for (const path of coverageConfig.slice(0, 2)) {
    pushStep(route, `覆盖率配置 ${path}`, path, 1, '来自 profile.tests.coverageConfig')
  }
  for (const command of testCommands.slice(0, 2)) {
    pushStep(route, `运行 ${asText(command.preset, 'test')}：${asArray(command.argv).join(' ')}`, command.source, 1, `命令来源 ${asText(command.source, '未知')}`)
  }

  if (route.order.length === 0) {
    pushMissing(route, '测试', '（未发现测试框架、用例或覆盖率配置）替代建议：先从 profile.commands 里找 test 预设；若确实没有测试，把"补一个最小冒烟测试"列为第一贡献项，并参考 backend/frontend 路线的入口文件。')
  }

  route.checklist = [
    frameworks.length > 0 ? `确认测试框架与运行器版本（${frameworks.map((item) => asText(item.label, asText(item.id, 'unknown'))).join('、')}）` : '确认是否完全缺少测试框架',
    `统计测试用例规模（profile.tests.testFileCount=${num(ctx.tests.testFileCount)}，IR 命中 ${discovered.length} 个文件）`,
    coverageConfig.length > 0 ? `核对覆盖率阈值配置 ${coverageConfig.join('、')}` : '未发现覆盖率配置：确认是否有隐形门槛',
    testCommands.length > 0 ? '在本地复跑测试命令并记录耗时' : '未发现测试命令：确认清单脚本是否缺失',
    '为关键流程补端到端用例（见 KEY_FLOWS.md）',
  ]
  return route
}

function devopsRoute(role, ctx) {
  const route = makeRoute(role, roleFocus(ctx.insights, role))
  const containers = ctx.containers.map((item) => String(item))
  const iac = ctx.iac.map((item) => String(item))
  const ci = ctx.ci.map((item) => ({ path: String(item.path ?? ''), id: String(item.id ?? '') })).filter((item) => item.path.length > 0)
  const infraModules = ctx.modules.filter((module) => String(module.kind) === 'infra')
  const deployConfigs = ctx.configs.filter((config) => /docker|compose|k8s|kubernetes|helm|terraform|ansible|workflows|gitlab-ci|jenkins|Procfile|systemd/i.test(String(config.path)))
  const runCommands = ctx.commands.filter((command) => ['build', 'start', 'dev', 'install'].includes(String(command.preset)))

  for (const path of containers.slice(0, 3)) {
    pushStep(route, `容器定义 ${path}`, path, 1, '来自 profile.containers')
  }
  for (const item of ci.slice(0, 3)) {
    pushStep(route, `CI 流水线 ${item.path}`, item.path, 1, `来自 profile.ci（id=${asText(item.id, '未知')}）`)
  }
  for (const path of iac.slice(0, 2)) {
    pushStep(route, `基础设施即代码 ${path}`, path, 1, '来自 profile.iac')
  }
  for (const config of deployConfigs.slice(0, 3)) {
    pushStep(route, `部署配置 ${asText(config.path)}`, config.path, 1, `profile.configs 识别为 ${asText(config.kind, 'config')}`)
  }
  for (const module of infraModules.slice(0, 2)) {
    pushStep(route, `基础设施模块 ${asText(module.id)}`, firstFileOfModule(ctx, module), 1, '模块 kind=infra')
  }
  for (const command of runCommands.slice(0, 3)) {
    pushStep(route, `运行 ${asText(command.preset, 'build')}：${asArray(command.argv).join(' ')}`, command.source, 1, `命令来源 ${asText(command.source, '未知')}`)
  }

  if (route.order.length === 0) {
    pushMissing(route, '运维/部署', '（未发现容器、CI 或 IaC 配置）替代建议：从清单脚本（build/start）与 profile.configs 入手确认运行形态；若项目尚未容器化，把"补 Dockerfile 与 CI"列为第一贡献项。')
  }

  route.checklist = [
    containers.length > 0 ? `核对容器镜像构建与运行参数（${containers.join('、')}）` : '未发现容器定义：确认部署方式（裸机 / 平台托管）',
    ci.length > 0 ? `确认 CI 触发条件与产物（${ci.map((item) => item.path).join('、')}）` : '未发现 CI 配置：确认是否依赖人工发布',
    '核对镜像/运行时所需环境变量（见 GETTING_STARTED.md，报告不输出疑似密钥值）',
    '确认生产启动命令与健康检查端点',
    iac.length > 0 ? `检查 IaC 变更流程（${iac.join('、')}）` : '未发现 IaC：确认基础设施变更是否有评审流程',
  ]
  return route
}

function dataRoute(role, ctx) {
  const route = makeRoute(role, roleFocus(ctx.insights, role))
  const sqlFiles = ctx.files.filter((file) => String(file.language).toLowerCase() === 'sql' || /\.sql$/i.test(String(file.id)))
  const migrationFiles = ctx.files.filter((file) => /migrat|schema|seed|entity|model|dao|repository|prisma|orm/i.test(String(file.id)))
  const dataModules = ctx.modules.filter((module) => /(^|[\/._-])(db|database|data|store|persist|persistence|model|models|entity|entities|schema|migration|migrations|repository|repositories|repo)([\/._-]|$)/i.test(String(module?.id ?? '')))
  const dataPackage = /^(pg|postgres|postgresql|mysql|mysql2|sqlite3?|mongodb|mongoose|redis|ioredis|prisma|@prisma\/client|typeorm|sequelize|knex|drizzle-orm|kafka|kafkajs|amqplib|elasticsearch|clickhouse|better-sqlite3)/i
  const dataDepCandidates = [
    ...asArray(ctx.deps.notable),
    ...asArray(ctx.deps.direct).map((name) => ({ name, kind: 'direct' })),
    ...asArray(ctx.deps.dev).map((name) => ({ name, kind: 'dev' })),
  ]
  const seenDep = new Set()
  const dataDeps = dataDepCandidates.filter((item) => {
    const name = String(item?.name ?? '')
    if (!dataPackage.test(name) || seenDep.has(name)) return false
    seenDep.add(name)
    return true
  })
  const dataConfigs = ctx.configs.filter((config) => /prisma|database|datasource|orm|migration|flyway|liquibase/i.test(String(config.path)))
  const entitySymbols = ctx.symbols.filter((symbol) => /entity|model|schema|repository|dao|migration/i.test(String(symbol.name)))

  for (const file of sqlFiles.slice(0, 3)) {
    pushStep(route, `SQL 文件 ${asText(file.id)}`, file.id, 1, `语言 sql，LOC ${num(file.loc)}`)
  }
  for (const file of migrationFiles.slice(0, 3)) {
    pushStep(route, `迁移/模型文件 ${asText(file.id)}`, file.id, 1, '路径命中 migration/schema/model/entity 约定')
  }
  for (const module of dataModules.slice(0, 3)) {
    pushStep(route, `数据访问模块 ${asText(module.id)}`, firstFileOfModule(ctx, module), 1, `模块路径命中数据访问命名约定，含文件 ${asArray(module.files).length} 个、LOC ${num(module.loc)}`)
  }
  for (const item of dataDeps.slice(0, 3)) {
    pushStep(route, `持久化依赖 ${asText(item.name)}`, asText(ctx.ecosystems[0]?.manifest, 'package.json'), 1, `版本 ${asText(item.version, '未标注')}，类型 ${asText(item.kind, '未标注')}`)
  }
  for (const config of dataConfigs.slice(0, 2)) {
    pushStep(route, `数据源配置 ${asText(config.path)}`, config.path, 1, `profile.configs 识别为 ${asText(config.kind, 'config')}（报告不读取配置内容）`)
  }
  for (const symbol of entitySymbols.slice(0, 3)) {
    pushStep(route, `模型符号 ${asText(symbol.name)}`, symbol.fileId, symbol.line, `kind=${asText(symbol.kind, 'unknown')}，fanIn=${num(symbol.fanIn)}`)
  }

  if (route.order.length === 0) {
    pushMissing(route, '数据', '（未发现模型、迁移、ORM 或 SQL 证据）替代建议：若数据来自外部 API，请沿 backend 路线的服务层与外部 import 追查；同时确认 profile.configs 中是否存在数据库配置（报告只列位置，不输出疑似密钥值）。')
  }

  route.checklist = [
    sqlFiles.length + migrationFiles.length > 0 ? `梳理数据模型与迁移顺序（SQL ${sqlFiles.length} 个 / 模型迁移 ${migrationFiles.length} 个）` : '未发现模型或迁移文件：确认数据是否外部托管',
    dataDeps.length > 0 ? `核对持久化依赖与版本（${dataDeps.map((item) => asText(item.name)).join('、')}）` : '未发现持久化依赖：确认数据访问方式',
    '确认迁移在部署流程中的执行时机与回滚方案',
    '检查敏感配置是否只走环境变量（报告不输出值）',
  ]
  return route
}

/**
 * 生成角色阅读路线（FR11）。路线全部由 IR / profile / graph 证据推导；
 * 找不到证据的角色会明说"该项目无明显 X 证据"并给替代建议，不编造路径。
 * @param model 见契约 §8。
 * @param options `{ role: null|string|string[] }`。
 * @returns RoleRoute[]
 */
export function renderRoleRoutes(model, options = {}) {
  const opts = normalizeOptions(options)
  const ctx = prepare(model, opts)
  const wanted = requestedRoles(opts.role)
  const builders = {
    backend: backendRoute,
    frontend: frontendRoute,
    test: testRoute,
    devops: devopsRoute,
    data: dataRoute,
  }
  const out = []
  for (const role of ROLES) {
    if (!wanted.includes(role.id)) continue
    try {
      out.push(builders[role.id](role, ctx))
    } catch (error) {
      // 渲染层不得抛错：单角色失败时降级为"数据不足"
      out.push({
        role: role.id,
        label: role.label,
        focus: role.focus,
        order: [{ step: 1, target: `该项目无明显${role.label}证据`, path: null, line: null, why: `推导该角色路线时数据不足：${error?.message ?? '未知原因'}` }],
        checklist: ['检查 IR / profile 数据是否完整后重试'],
      })
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * insights 辅助
 * ------------------------------------------------------------------ */

/** 叙述分组的中文标题（键与 lib/insights.js 的 emptyNarratives 对齐）。 */
const NARRATIVE_GROUPS = {
  projectSummary: '项目概述',
  architecture: '架构叙述',
  modules: '模块叙述',
  risks: '风险叙述',
  readingOrder: '阅读顺序',
}

/**
 * 把引用数组归一化成 `path:line` / `path#symbol` 字符串。
 * 兼容 `{path,line,symbol}`、`{path,line}`、纯字符串三种形态。
 */
function citationStrings(value) {
  const out = []
  for (const item of asArray(value)) {
    if (typeof item === 'string') {
      if (item.length > 0) out.push(item)
      continue
    }
    if (!isObject(item)) continue
    const path = asText(item.path) || asText(item.fileId)
    if (!path) {
      // 少数情况会直接给 `text`，形如 `a/b.js:12`
      if (asText(item.text)) out.push(asText(item.text))
      continue
    }
    const line = Number.isFinite(item.line) ? `:${Math.trunc(item.line)}` : ''
    const symbol = asText(item.symbol) ? `#${item.symbol}` : ''
    out.push(`${path}${line}${symbol}`)
  }
  return out
}

/**
 * 归一化 insights.readingOrder。兼容三种形态：
 *   1. 字符串 `path:line`；
 *   2. `{path,line,why}`（确定性阅读顺序）；
 *   3. `{target,why,citations:[{path,line}]}`（LLM 生成、已验证的阅读顺序）。
 */
function readingOrderEntries(ctx) {
  const raw = ctx.insights.readingOrder
  const list = Array.isArray(raw) ? raw : isObject(raw) ? Object.values(raw) : []
  const out = []
  for (const item of list) {
    if (typeof item === 'string') {
      const parsed = parseEvidence(item)
      if (parsed.path) out.push({ target: `按推荐顺序阅读 ${parsed.path}`, path: parsed.path, line: firstFinite(parsed.line, 1), why: '来自 insights.readingOrder' })
      continue
    }
    if (!isObject(item)) continue
    const citations = [...asArray(item.citations), ...asArray(item.evidence)]
    const first = citations.find((entry) => (isObject(entry) ? asText(entry.path) || asText(entry.fileId) : typeof entry === 'string' && entry.length > 0))
    let path = asText(item.path) || asText(item.fileId)
    let line = Number.isFinite(item.line) ? item.line : undefined
    if (!path && first !== undefined) {
      if (isObject(first)) {
        path = asText(first.path) || asText(first.fileId)
        if (Number.isFinite(first.line)) line = first.line
      } else {
        const parsed = parseEvidence(String(first))
        path = parsed.path
        line = parsed.line
      }
    }
    if (!path) continue
    out.push({
      target: asText(item.target) || asText(item.title) || `按推荐顺序阅读 ${path}`,
      path,
      line: firstFinite(line, 1),
      why: asText(item.why, asText(item.reason, '来自 insights.readingOrder')),
    })
  }
  return out
}

/**
 * 归一化 insights.narratives（LLM 叙述，可能是对象分组、数组或字符串）。
 * 断言字段兼容 `text`，引用字段兼容 `citations` 与 `evidence`。
 */
function narrativeEntries(ctx) {
  const raw = ctx.insights.narratives
  const out = []
  const pushClaim = (group, item) => {
    if (typeof item === 'string') {
      if (item.trim().length > 0) out.push({ title: NARRATIVE_GROUPS[group] ?? '', text: item.trim(), evidence: [] })
      return
    }
    if (!isObject(item)) return
    const text = asText(item.text) || asText(item.summary) || asText(item.detail) || asText(item.claim) || asText(item.statement)
    if (!text) return
    const moduleName = asText(item.module)
    const title = asText(item.title) || asText(item.name) || (moduleName ? `${moduleName} 模块叙述` : NARRATIVE_GROUPS[group] ?? '')
    out.push({ title, text, evidence: uniq([...citationStrings(item.citations), ...citationStrings(item.evidence)]) })
  }
  if (isObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'readingOrder') continue
      if (Array.isArray(value)) for (const item of value) pushClaim(key, item)
      else pushClaim(key, value)
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) pushClaim('', item)
  } else {
    pushClaim('', raw)
  }
  return out
}

/** 归一化 insights.risks：兼容字符串、`{title,detail,evidence}`、以及带 severity 的形状。 */
function riskEntries(ctx) {
  const raw = ctx.insights.risks
  const list = Array.isArray(raw) ? raw : isObject(raw) ? Object.values(raw) : typeof raw === 'string' ? [raw] : []
  const out = []
  for (const item of list) {
    if (typeof item === 'string') {
      if (item.trim().length > 0) out.push({ title: item.trim(), detail: '', evidence: [], severity: '', verified: false, source: 'insights.risks' })
      continue
    }
    if (!isObject(item)) continue
    const title = asText(item.title) || asText(item.name) || asText(item.text) || asText(item.summary)
    if (!title) continue
    out.push({
      title,
      detail: asText(item.detail) || asText(item.why),
      evidence: uniq([...citationStrings(item.evidence), ...citationStrings(item.citations)]),
      severity: asText(item.severity),
      verified: item.verified === true,
      source: asText(item.source, 'insights.risks'),
    })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Markdown 渲染
 * ------------------------------------------------------------------ */

function renderOnboarding(model, ctx, opts) {
  const out = []
  out.push(`# ONBOARDING · ${ctx.projectName} 上手报告`)
  out.push('')
  out.push(metaBlock(ctx))
  out.push('')
  out.push('> 目标：让新成员在 10 分钟内建立对项目的正确心智模型，并把每一条结论追溯到静态证据。')
  out.push('')

  out.push('## 1. 项目一句话定位')
  out.push('')
  out.push(positioning(ctx))
  out.push('')

  out.push('## 2. 技术栈与规模')
  out.push('')
  out.push(techStackTable(ctx))
  out.push('')

  out.push('## 3. 10 分钟上手路径')
  out.push('')
  out.push(onboardingPath(ctx))
  out.push('')

  out.push('## 4. 架构总览')
  out.push('')
  out.push(mermaidBlock(moduleGraphDiagram(moduleGraphFor(ctx), { maxNodes: opts.maxNodes }), opts))
  out.push('')
  out.push(`> 节点是模块（目录），边是模块依赖，${code('|weight|')} 表示依赖条数；本次共 ${ctx.modules.length} 个模块、${ctx.moduleEdges.length} 条模块依赖边。分层视图见 ${code('ARCHITECTURE.md')}。`)
  out.push('')

  out.push(`## 5. 核心模块 Top ${opts.topModules}`)
  out.push('')
  out.push(coreModuleTable(ctx, opts))
  out.push('')

  out.push('## 6. 按角色阅读路线')
  out.push('')
  out.push(roleRouteTable(model, opts))
  out.push('')

  out.push('## 7. 风险与 TODO 摘要')
  out.push('')
  out.push(riskSummary(ctx))
  out.push('')

  out.push('## 8. 下一步命令')
  out.push('')
  out.push(nextCommands(ctx))
  out.push('')
  return out.join('\n')
}

function positioning(ctx) {
  if (!ctx.hasIr && ctx.kinds.length === 0 && ctx.languages.length === 0) {
    return dataGap(
      '没有可用的 IR 与 profile（原因：项目为空，或分析尚未运行）。',
      [
        `先运行分析生成 ${code('.project-compass/ir.json')} 与 ${code('.project-compass/scan.json')}`,
        '确认忽略规则没有把源码目录整体排除（查看 profile.ignore.rules）',
        '确认项目根目录存在代码文件而非仅有文档',
      ],
    )
  }
  const kinds = ctx.kinds.length > 0 ? ctx.kinds.join('、') : '未识别（profile.kinds 为空）'
  const ecosystems = ctx.ecosystems.length > 0
    ? ctx.ecosystems.map((item) => `${asText(item.kind, '未知生态')}(${asText(item.name, asText(item.manifest, '清单未知'))})`).join('、')
    : '未识别'
  const counts = `模块 ${ctx.modules.length} 个 / 文件 ${fileCount(ctx)} 个 / 源码文件 ${sourceFileCount(ctx)} 个 / 代码 ${locCount(ctx)} 行 / 符号 ${symbolCount(ctx)} 个 / 路由 ${ctx.routes.length} 条 / 流程 ${ctx.flows.length} 条`
  const refs = []
  const primaryEntry = orderedEntrypoints(ctx)[0]
  if (primaryEntry) refs.push(`入口 ${ev(primaryEntry.path, entryLine(primaryEntry))}`)
  if (ctx.ecosystems[0]?.manifest) refs.push(`清单 ${ev(ctx.ecosystems[0].manifest, 1)}`)
  if (ctx.files[0]) refs.push(`文件样本 ${ev(ctx.files[0].id, 1)}`)
  if (ctx.modules[0]) refs.push(`模块样本 ${moduleEvidence(ctx, ctx.modules[0])}`)
  const refText = refs.length > 0 ? refs.join('、') : '（数据不足：未发现入口、清单或文件记录）'
  return [
    `这是一个以 **${topLanguageName(ctx)}** 为主的 **${kinds}** 项目，生态：${ecosystems}。`,
    '',
    `规模：${counts}${ctx.truncated ? '（本次分析被预算截断，规模可能被低估）' : ''}。`,
    '',
    `证据：${refText}。`,
  ].join('\n')
}

function techStackTable(ctx) {
  // 本表全部是聚合类事实：证据列一律写"数据来源"，不借用任何源文件
  const rows = []
  rows.push(['主要语言', languageText(ctx), ctx.languages.length > 0 ? sourceNote('scan') : '（数据不足：profile 与 IR 都没有语言统计）'])
  rows.push(['项目类型（kinds）', ctx.kinds.length > 0 ? ctx.kinds.join('、') : '数据不足', ctx.kinds.length > 0 ? sourceNote('scan') : '（未验证：profile.kinds 为空）'])
  const manifest = asText(ctx.ecosystems[0]?.manifest)
  rows.push([
    '生态与清单',
    ctx.ecosystems.length > 0 ? ctx.ecosystems.map((item) => `${asText(item.kind, 'unknown')}@${asText(item.version, '版本未标注')}（${asText(item.manifest, '清单未知')}）`).join('、') : '数据不足',
    ctx.ecosystems.length > 0 ? `${sourceNote('scan')}；清单文件 ${manifest ? evFile(manifest) : '未识别'}` : '（未验证）',
  ])
  rows.push(['文件规模', `文件 ${fileCount(ctx)} 个，其中源码 ${sourceFileCount(ctx)} 个${Number.isFinite(ctx.size.bytes) ? `，总字节 ${formatBytes(ctx.size.bytes)}` : ''}`, sourceNote('scan')])
  rows.push(['代码规模', `${locCount(ctx)} 行，符号 ${symbolCount(ctx)} 个`, sourceNote('ir')])
  rows.push(['模块与依赖', `模块 ${ctx.modules.length} 个，模块依赖边 ${ctx.moduleEdges.length} 条，循环依赖 ${ctx.cycles.length} 处`, sourceNote('graph')])
  rows.push(['路由与入口', `路由 ${ctx.routes.length} 条，入口 ${ctx.entrypoints.length} 个`, sourceNote('ir')])
  rows.push(['测试', testSummary(ctx), sourceNote('scan')])
  rows.push(['依赖', dependencySummary(ctx), sourceNote('scan')])
  return table(['维度', '值', '数据来源'], rows)
}

function testSummary(ctx) {
  const frameworks = asArray(ctx.tests.frameworks).map((item) => asText(item.label, asText(item.id, 'unknown')))
  const testFileCount = firstFinite(num(ctx.tests.testFileCount, NaN), asArray(ctx.tests.testFiles).length)
  if (frameworks.length === 0 && testFileCount === 0) return '数据不足（未发现测试框架与测试文件）'
  return `框架 ${frameworks.length > 0 ? frameworks.join('、') : '未识别'}，测试文件 ${testFileCount} 个`
}

function testEvidence(ctx) {
  const framework = asArray(ctx.tests.frameworks)[0]
  if (framework) {
    const parsed = parseEvidence(framework.evidence)
    if (parsed.path) return ev(parsed.path, firstFinite(parsed.line, 1))
  }
  const file = asArray(ctx.tests.testFiles)[0]
  if (file) return evFile(String(file))
  return '（数据不足：profile.tests 为空）'
}

function dependencySummary(ctx) {
  const direct = asArray(ctx.deps.direct).length
  const dev = asArray(ctx.deps.dev).length
  const notable = asArray(ctx.deps.notable).map((item) => asText(item.name)).filter(Boolean)
  if (direct === 0 && dev === 0 && notable.length === 0) return '数据不足（未发现依赖清单）'
  return `直接依赖 ${direct} 个 / 开发依赖 ${dev} 个${notable.length > 0 ? `；重点：${notable.slice(0, 6).join('、')}` : ''}`
}

function onboardingPath(ctx) {
  const steps = collectOnboardingSteps(ctx)
  if (steps.length === 0) {
    return dataGap(
      '未能推断出入门路径（原因：IR 中没有入口、路由、符号或核心模块证据）。',
      [
        '确认扫描是否被忽略规则排除（查看 profile.ignore.rules）',
        '手动阅读根目录 README 与依赖清单',
        `运行 ${code('compass analyze <项目>')} 重新生成 IR 后重试`,
      ],
    )
  }
  // 可读形式：第 N 步 → 读哪里 → 为什么读（目标放括号里，避免"按推荐顺序阅读 X"这类重复措辞）
  return steps
    .map((item, index) => `- **第 ${index + 1} 步：读 ${code(item.ref)}**${item.target ? `（${item.target}）` : ''} —— 为什么读：${item.why}`)
    .join('\n')
}

function collectOnboardingSteps(ctx) {
  const out = []
  const seen = new Set()
  const add = (target, path, line, why) => {
    const targetPath = asText(path)
    if (!targetPath || out.length >= 10) return
    const finalLine = Number.isFinite(line) ? Math.trunc(line) : 1
    const key = `${targetPath}:${finalLine}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ target: String(target), ref: cite(targetPath, { line: finalLine }).text, why: String(why) })
  }

  for (const item of readingOrderEntries(ctx)) add(item.target, item.path, item.line, item.why)
  for (const entry of orderedEntrypoints(ctx).slice(0, 3)) {
    const line = entryLine(entry)
    const ref = cite(asText(entry.path), { line }).text
    const evidenceText = asText(entry.evidence)
    const why = evidenceText && evidenceText !== ref
      ? `由 profile.entrypoints 识别，证据 ${evidenceText}`
      : `由 profile.entrypoints 识别为 ${asText(entry.kind, 'entry')} 入口`
    add(`阅读入口文件（${asText(entry.kind, 'entry')}）`, entry.path, line, why)
  }
  for (const module of topModules(ctx, 3)) {
    add(`通读核心模块 ${asText(module.id, '.')}`, firstFileOfModule(ctx, module), 1, `模块 LOC ${num(module.loc)}、符号 ${num(module.symbolCount)}、风险 ${riskOfModule(ctx, module)}`)
  }
  for (const route of ctx.routes.slice(0, 3)) {
    add(`查看路由 ${asText(route.method, 'GET')} ${asText(route.path, '/')}`, route.fileId, route.line, `框架 ${asText(route.framework, '未知')}`)
  }
  for (const file of asArray(ctx.tests.testFiles).slice(0, 2)) {
    add(`阅读测试用例 ${String(file)}`, String(file), 1, '来自 profile.tests.testFiles，用测试理解预期行为')
  }
  if (asArray(ctx.tests.frameworks).length === 0 && asArray(ctx.tests.testFiles).length === 0) {
    const discovered = ctx.files.find((file) => /\.(test|spec)\.[a-z]+$/i.test(String(file.id)))
    if (discovered) add(`阅读测试文件 ${asText(discovered.id)}`, discovered.id, 1, '路径命中测试命名约定（profile.tests 未识别到框架）')
  }
  for (const doc of ctx.docs.slice(0, 2)) add(`阅读文档 ${String(doc)}`, String(doc), 1, '来自 profile.docs')
  for (const command of ctx.commands.filter((item) => ['install', 'test', 'dev'].includes(String(item.preset))).slice(0, 2)) {
    add(`运行 ${asText(command.preset, 'install')}：${asArray(command.argv).join(' ')}`, command.source, 1, `命令来源 ${asText(command.source, '未知')}`)
  }
  if (out.length === 0 && ctx.hubs.length > 0) {
    const hub = ctx.hubs[0]
    add(`从枢纽符号/模块入手 ${asText(hub.id)}`, asText(hub.id), 1, `fanIn=${num(hub.fanIn)}，fanOut=${num(hub.fanOut)}`)
  }
  return out
}

function coreModuleTable(ctx, opts) {
  if (ctx.modules.length === 0) {
    return dataGap('IR 中没有模块记录（原因：分析未运行或项目为空）。', ['先运行 analyze 生成 IR', '检查忽略规则是否排除了全部源码'])
  }
  const cycles = cycleIds(ctx)
  const rows = topModules(ctx, opts.topModules).map((module, index) => {
    const id = String(module.id ?? '')
    return [
      index + 1,
      code(id),
      asText(module.kind, 'unknown'),
      num(module.loc),
      asArray(module.files).length,
      num(module.symbolCount),
      num(ctx.moduleFanIn[id]),
      num(ctx.moduleFanOut[id]),
      cycles.has(id) ? '是（在环上）' : '否',
      riskOfModule(ctx, module),
      sourceNote('modules'),
    ]
  })
  return table(['#', '模块', '类型', 'LOC', '文件', '符号', '入度', '出度', '在环上', '风险', '数据来源'], rows)
}

function roleRouteTable(model, opts) {
  const routes = renderRoleRoutes(model, opts)
  const rows = routes.map((route) => {
    const ordered = route.order
      .slice(0, 4)
      .map((item) => `${item.step}. ${item.target}${item.path ? `（${code(item.line ? `${item.path}:${item.line}` : item.path)}）` : ''}`)
      .join('<br>')
    const checklist = route.checklist.map((item) => `- ${item}`).join('<br>')
    return [route.label, route.focus, ordered || '（无可用证据步骤）', checklist || '—']
  })
  return table(['角色', '关注点', '推荐阅读路线', '检查清单'], rows)
}

function riskSummary(ctx) {
  const items = []
  for (const gap of ctx.gaps) {
    const evidence = asArray(gap.evidence).map((entry) => {
      const parsed = parseEvidence(entry)
      return parsed.path ? code(parsed.text || citationText(parsed)) : String(entry)
    })
    items.push(`- **[${asText(gap.priority, 'P?')}] ${asText(gap.title, gap.id)}**：${asText(gap.detail, '（无细节）')}${evidence.length > 0 ? ` 证据：${evidence.join('、')}` : '（未验证：未提供静态证据）'}`)
  }
  for (const risk of riskEntries(ctx)) {
    const severity = risk.severity ? `[${risk.severity}] ` : ''
    const evidence = risk.evidence.length > 0
      ? ` 证据：${risk.evidence.map((entry) => code(entry)).join('、')}`
      : risk.verified
        ? '（由静态信号推导，无逐条引用）'
        : '（未验证：来自 insights.risks，未提供静态证据）'
    items.push(`- ${severity}**${risk.title}**${risk.detail ? `：${risk.detail}` : ''}${evidence}`)
  }
  for (const module of ctx.riskModules.slice(0, 8)) {
    const reasons = asArray(module.reasons).map((item) => String(item)).join('；')
    items.push(`- **高风险模块 ${code(asText(module.id, 'unknown'))}（score ${num(module.score)}）**：${reasons || '未提供原因'}（${sourceNote('graph')}）`)
  }
  const todoCount = firstFinite(num(ctx.signals.todoCount, NaN), asArray(ctx.signals.todos).length)
  const todos = asArray(ctx.signals.todos)
  if (todoCount > 0) {
    const samples = todos.slice(0, 5).map((todo) => `${code(`${asText(todo.path, '?')}:${num(todo.line)}`)} ${asText(todo.text, '')}（${asText(todo.kind, 'todo')}）`)
    items.push(`- **TODO/FIXME 共 ${todoCount} 处**（${sourceNote('scan')}）：${samples.length > 0 ? `示例 ${samples.join('；')}` : '（未提供具体条目）'}`)
  }
  for (const warning of ctx.warnings.slice(0, 5)) items.push(`- **分析告警**：${warning}`)
  if (ctx.cycles.length > 0) {
    const first = ctx.cycles[0]
    items.push(`- **循环依赖 ${ctx.cycles.length} 处**（${sourceNote('graph')}）：首个环包含 ${asArray(first).map((id) => code(id)).join(' → ')}`)
  }
  if (ctx.orphans.length > 0) {
    items.push(`- **孤立文件 ${ctx.orphans.length} 个**（${sourceNote('graph')}）：${ctx.orphans.slice(0, 6).map((id) => code(id)).join('、')}`)
  }
  if (items.length === 0) {
    return '未发现显著风险信号：静态扫描没有命中 TODO/FIXME、高风险模块或循环依赖。注意这是"未发现"而非"不存在"，建议人工复核敏感路径与部署配置。'
  }
  return items.join('\n')
}

function citationText(parsed) {
  return cite(parsed.path, { line: parsed.line }).text
}

function nextCommands(ctx) {
  const lines = ['本报告只做静态分析；下面命令按"先复现、再深入"的顺序排列：', '']
  const commandRows = ctx.commands
    .filter((command) => ['install', 'build', 'test', 'dev', 'start', 'lint', 'typecheck'].includes(String(command.preset)))
    .map((command) => [asText(command.preset, 'unknown'), code(asArray(command.argv).join(' ') || '（命令为空）'), code(asText(command.source, '未知'))])
  if (commandRows.length > 0) {
    lines.push(table(['预设', '命令', '来源'], commandRows))
    lines.push('')
  } else {
    lines.push(dataGap('profile.commands 为空，无法给出安装/构建/测试命令。', ['查看项目清单文件的 scripts 段', '确认扫描是否读取了清单文件']))
    lines.push('')
  }
  lines.push('按需继续：')
  lines.push('- 查看分层架构与循环依赖：`ARCHITECTURE.md`')
  lines.push('- 查看模块职责与关键符号：`MODULE_MAP.md`')
  lines.push('- 查看关键流程时序：`KEY_FLOWS.md`')
  lines.push('- 环境与配置准备：`GETTING_STARTED.md`')
  return lines.join('\n')
}

function renderArchitecture(model, ctx, opts) {
  const out = []
  const cycles = cycleIds(ctx)
  out.push(`# ARCHITECTURE · ${ctx.projectName} 架构说明`)
  out.push('')
  out.push(metaBlock(ctx))
  out.push('')

  out.push('## 1. 分层架构总览')
  out.push('')
  out.push(mermaidBlock(architectureDiagram(model, { maxNodes: opts.maxNodes }), opts))
  out.push('')
  out.push(layerTable(ctx))
  out.push('')

  out.push('## 2. 模块依赖表')
  out.push('')
  out.push(moduleDependencyTable(ctx, cycles))
  out.push('')

  out.push('## 3. 关键设计决策与约束')
  out.push('')
  out.push(designDecisions(ctx))
  out.push('')

  out.push('## 4. 循环依赖与高风险模块')
  out.push('')
  out.push(cycleSection(ctx))
  out.push('')

  out.push('## 5. 外部依赖与运行时形态')
  out.push('')
  out.push(runtimeSection(ctx))
  out.push('')

  if (ctx.fileEdges.length > 0) {
    out.push('## 6. 文件级依赖（前 40 个连接度最高的文件）')
    out.push('')
    out.push(mermaidBlock(fileGraphDiagram(ctx.graph, { maxNodes: opts.maxNodes }), opts))
    out.push('')
  }
  return out.join('\n')
}

function layerTable(ctx) {
  // 已知 kind 按固定顺序，未知 kind 排在最后（按字典序），不丢数据
  const order = ['source', 'test', 'config', 'infra', 'docs', 'asset', 'generated', 'mixed', 'other']
  const rank = (kind) => {
    const index = order.indexOf(kind)
    return index >= 0 ? index : order.length
  }
  const byKind = groupBy(ctx.modules, (module) => String(module?.kind ?? 'other'))
  const rows = []
  const entries = [...byKind.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || String(a[0]).localeCompare(String(b[0])))
  for (const [kind, list] of entries) {
    const loc = sum(list.map((module) => num(module.loc)))
    const symbols = sum(list.map((module) => num(module.symbolCount)))
    const files = sum(list.map((module) => asArray(module.files).length))
    rows.push([`${kind}`, list.length, files, loc, symbols, sourceNote('modules')])
  }
  if (rows.length === 0) {
    return dataGap('IR 中没有模块记录，无法分层。', ['先运行 analyze 生成 IR', '检查忽略规则是否排除了全部源码'])
  }
  return table(['层（kind）', '模块数', '文件数', 'LOC', '符号数', '数据来源'], rows)
}

function moduleDependencyTable(ctx, cycles) {
  if (ctx.modules.length === 0) {
    return dataGap('IR 中没有模块记录，无法给出依赖表。', ['先运行 analyze 生成 IR'])
  }
  const rows = sortBy(ctx.modules, (module) => -(num(ctx.moduleFanIn[String(module?.id ?? '')]) + num(ctx.moduleFanOut[String(module?.id ?? '')])))
    .slice(0, 60)
    .map((module) => {
      const id = String(module?.id ?? '')
      const dependsOn = asArray(module?.dependsOn).map((item) => String(item))
      const dependedOnBy = asArray(module?.dependedOnBy).map((item) => String(item))
      return [
        code(id),
        asText(module?.kind, 'unknown'),
        num(ctx.moduleFanIn[id]),
        num(ctx.moduleFanOut[id]),
        cycles.has(id) ? '是' : '否',
        riskOfModule(ctx, module),
        dependsOn.length > 0 ? dependsOn.slice(0, 5).map((item) => code(item)).join('、') : '—',
        dependedOnBy.length > 0 ? dependedOnBy.slice(0, 5).map((item) => code(item)).join('、') : '—',
        `${sourceNote('modules')}；入度/出度 ${sourceNote('graph')}`,
      ]
    })
  const more = ctx.modules.length > 60 ? `\n\n> 表格只列出连接度最高的 60 个模块，其余 ${ctx.modules.length - 60} 个模块见 ${code('project-compass.json')}。` : ''
  return table(['模块', 'kind', '入度', '出度', '在环上', '风险', '依赖', '被依赖', '数据来源'], rows) + more
}

function designDecisions(ctx) {
  const items = []
  const kindCounts = groupBy(ctx.modules, (module) => String(module?.kind ?? 'other'))
  if (ctx.modules.length > 0) {
    const text = [...kindCounts.entries()].map(([kind, list]) => `${kind} ${list.length} 个`).join('、')
    items.push(`- **代码按模块 kind 分层**：${text}。${sourceNote('modules')}（由 Module.kind 统计得出，非人工声明）`)
  }
  if (ctx.entrypoints.length > 0) {
    const entries = orderedEntrypoints(ctx)
    const text = entries.slice(0, 5).map((entry) => `${asText(entry.path)}（${asText(entry.kind, 'entry')}）`).join('、')
    items.push(`- **入口形态**：${text}。入口文件证据：${ev(entries[0].path, entryLine(entries[0]))}`)
  }
  if (ctx.routes.length > 0) {
    const frameworks = uniq(ctx.routes.map((route) => asText(route.framework, '未知')))
    items.push(`- **对外协议**：以 HTTP 路由暴露能力，框架 ${frameworks.join('、')}，共 ${ctx.routes.length} 条路由（${sourceNote('routes')}）。示例路由定义：${ev(ctx.routes[0].fileId, ctx.routes[0].line)}`)
  }
  if (ctx.ecosystems.length > 0) {
    const manifest = asText(ctx.ecosystems[0].manifest)
    items.push(`- **依赖管理**：由清单 ${manifest ? evFile(manifest) : '（未识别）'} 声明（直接依赖 ${asArray(ctx.deps.direct).length} 个、开发依赖 ${asArray(ctx.deps.dev).length} 个，${sourceNote('scan')}）`)
  }
  if (asArray(ctx.tests.frameworks).length > 0 || asArray(ctx.tests.testFiles).length > 0) {
    const framework = asArray(ctx.tests.frameworks)[0]
    const location = parseEvidence(framework?.evidence)
    const evidence = location.path ? ev(location.path, firstFinite(location.line, 1)) : '（未提供框架证据）'
    items.push(`- **测试策略**：${testSummary(ctx)}（${sourceNote('scan')}）。框架证据：${evidence}`)
  }
  if (ctx.containers.length > 0 || ctx.ci.length > 0) {
    const parts = []
    if (ctx.containers.length > 0) parts.push(`容器 ${ctx.containers.length} 个`)
    if (ctx.ci.length > 0) parts.push(`CI 流水线 ${ctx.ci.length} 条`)
    const first = ctx.containers[0] ? ev(ctx.containers[0], 1) : ev(asText(ctx.ci[0]?.path), 1)
    items.push(`- **交付形态**：${parts.join('、')}（${sourceNote('scan')}）。清单证据：${first}`)
  }
  if (ctx.cycles.length === 0 && ctx.moduleEdges.length > 0) {
    items.push(`- **依赖方向**：模块级依赖无环（${ctx.moduleEdges.length} 条边）。${sourceNote('graph')}`)
  }
  for (const narrative of narrativeEntries(ctx).slice(0, 6)) {
    items.push(`- **${narrative.title || '设计叙述'}**：${narrative.text}`)
    if (narrative.evidence.length > 0) items.push(`  - 引用（已通过验证器）：${narrative.evidence.map((entry) => code(entry)).join('、')}`)
    else items.push('  - 证据：未验证（LLM 叙述未提供静态证据，已被验证器丢弃或标注）')
  }
  if (items.length === 0) {
    return dataGap('没有可用于推断设计决策的证据（IR / profile 均为空）。', ['先运行 analyze 生成 IR 与 profile', '补充 README 与架构文档以便归纳'])
  }
  return items.join('\n')
}

function cycleSection(ctx) {
  const out = []
  if (ctx.cycles.length === 0) {
    out.push(`未发现循环依赖（本次分析在模块级依赖图上未检出环）。${sourceNote('graph')}`)
  } else {
    out.push(`检出 ${ctx.cycles.length} 处循环依赖（按模块 id 列出，最多展示 10 处；${sourceNote('graph')}）：`)
    out.push('')
    const rows = ctx.cycles.slice(0, 10).map((cycle, index) => {
      const ids = asArray(cycle).map((id) => String(id))
      return [index + 1, ids.map((id) => code(id)).join(' → '), ids.length, sourceNote('graph')]
    })
    out.push(table(['#', '环路径', '涉及模块数', '数据来源'], rows))
  }
  out.push('')
  if (ctx.riskModules.length === 0) {
    out.push('未发现高风险模块（graph.metrics.riskModules 为空）。')
  } else {
    out.push(`高风险模块（${sourceNote('graph')}）：`)
    out.push('')
    const rows = ctx.riskModules.slice(0, 20).map((module) => {
      const id = String(module.id ?? '')
      return [code(id), num(module.score), asArray(module.reasons).map((item) => String(item)).join('；') || '未提供原因', sourceNote('graph')]
    })
    out.push(table(['模块', 'score', '原因', '数据来源'], rows))
  }
  if (ctx.hubs.length > 0) {
    out.push('')
    out.push(`枢纽节点（被依赖最多，改动影响面最大；${sourceNote('graph')}）：`)
    out.push('')
    const rows = ctx.hubs.slice(0, 10).map((hub) => {
      const id = String(hub.id ?? '')
      return [code(id), num(hub.fanIn), num(hub.fanOut), sourceNote('graph')]
    })
    out.push(table(['节点（文件/模块 id）', '入度', '出度', '数据来源'], rows))
  }
  return out.join('\n')
}

function runtimeSection(ctx) {
  const out = []
  const notable = asArray(ctx.deps.notable)
  const manifest = asText(ctx.ecosystems[0]?.manifest)
  if (notable.length > 0) {
    // 依赖条目是文件级事实：清单文件确实声明了这些包
    const rows = notable.slice(0, 40).map((item) => [code(asText(item.name, 'unknown')), asText(item.version, '未标注'), asText(item.kind, '未标注'), manifest ? evFile(manifest) : '（未验证）'])
    out.push('### 重点外部依赖')
    out.push('')
    out.push(table(['包名', '版本', '类型', '证据（清单文件）'], rows))
    out.push('')
  } else {
    out.push('### 重点外部依赖')
    out.push('')
    out.push(dataGap('profile.deps.notable 为空（原因：未读取到依赖清单，或项目没有第三方依赖）。', ['确认清单文件是否存在且被扫描', '查看 profile.ecosystems 是否为空']))
    out.push('')
  }

  const direct = asArray(ctx.deps.direct).map((item) => String(item))
  out.push('### 依赖与运行时形态')
  out.push('')
  // 拆成两张表：聚合规模只写数据来源；运行时/交付清单是文件级事实，给真实文件证据
  out.push('**依赖与配置规模（聚合）**')
  out.push('')
  out.push(table(['维度', '值', '数据来源'], [
    ['直接依赖', direct.length > 0 ? `${direct.length} 个${direct.length <= 20 ? `：${direct.join('、')}` : ''}` : '数据不足', `${sourceNote('scan')}${manifest ? `；清单文件 ${evFile(manifest)}` : ''}`],
    ['开发依赖', `${asArray(ctx.deps.dev).length} 个`, `${sourceNote('scan')}${manifest ? `；清单文件 ${evFile(manifest)}` : ''}`],
    ['配置与文档', `configs ${ctx.configs.length} 个 / docs ${ctx.docs.length} 篇`, sourceNote('scan')],
  ]))
  out.push('')
  out.push('**运行时与交付清单（文件级）**')
  out.push('')
  out.push(table(['维度', '值', '文件证据'], [
    ['容器', ctx.containers.length > 0 ? ctx.containers.map((item) => code(item)).join('、') : '未发现容器定义', ctx.containers[0] ? ev(ctx.containers[0], 1) : '（数据不足）'],
    ['CI', ctx.ci.length > 0 ? ctx.ci.map((item) => code(asText(item.path, asText(item.id, 'unknown')))).join('、') : '未发现 CI 配置', ctx.ci[0] ? ev(asText(ctx.ci[0].path), 1) : '（数据不足）'],
    ['IaC', ctx.iac.length > 0 ? ctx.iac.map((item) => code(item)).join('、') : '未发现 IaC', ctx.iac[0] ? ev(ctx.iac[0], 1) : '（数据不足）'],
    ['入口', ctx.entrypoints.length > 0 ? orderedEntrypoints(ctx).map((entry) => `${code(asText(entry.path))}(${asText(entry.kind, 'entry')})`).join('、') : '数据不足', orderedEntrypoints(ctx)[0] ? ev(orderedEntrypoints(ctx)[0].path, entryLine(orderedEntrypoints(ctx)[0])) : '（数据不足）'],
  ]))
  return out.join('\n')
}

function renderModuleMap(model, ctx, opts) {
  const out = []
  out.push(`# MODULE_MAP · ${ctx.projectName} 模块地图`)
  out.push('')
  out.push(metaBlock(ctx))
  out.push('')
  out.push('> 模块 = IR 中的目录单元（`Module.id` 为相对目录，根目录记为 `.`）。职责由符号命名、文档与依赖关系**归纳**，非人工声明。')
  out.push('')

  out.push('## 1. 模块依赖总览')
  out.push('')
  out.push(mermaidBlock(moduleGraphDiagram(moduleGraphFor(ctx), { maxNodes: opts.maxNodes, groupByKind: true }), opts))
  out.push('')
  out.push(`> 按模块 kind 分层绘制；模块 ${ctx.modules.length} 个、依赖边 ${ctx.moduleEdges.length} 条（图数据缺失时用 ${code('Module.dependsOn')} 合成）。`)
  out.push('')

  out.push('## 2. 模块清单')
  out.push('')
  out.push(moduleInventoryTable(ctx))
  out.push('')

  out.push('## 3. 模块详情')
  out.push('')
  if (ctx.modules.length === 0) {
    out.push(dataGap('IR 中没有模块记录。', ['先运行 analyze 生成 IR', '检查忽略规则是否排除了全部源码']))
  } else {
    const ordered = sortBy(ctx.modules, (module) => -(num(module?.loc) + num(module?.symbolCount) * 5))
    for (const module of ordered.slice(0, 40)) out.push(moduleSection(ctx, module), '')
    if (ordered.length > 40) out.push(`> 只展开前 40 个模块，其余 ${ordered.length - 40} 个模块的清单见第 2 节与 ${code('project-compass.json')}。`, '')
  }

  out.push('## 4. 未归属文件清单')
  out.push('')
  out.push(unassignedFiles(ctx))
  out.push('')
  return out.join('\n')
}

function moduleInventoryTable(ctx) {
  if (ctx.modules.length === 0) {
    return dataGap('IR 中没有模块记录，无法给出模块清单。', ['先运行 analyze', '确认项目根目录存在源码'])
  }
  const cycles = cycleIds(ctx)
  const rows = sortBy(ctx.modules, (module) => String(module?.id ?? '')).map((module) => {
    const id = String(module?.id ?? '')
    const moduleFiles = filesOfModule(ctx, id)
    const languages = uniq(moduleFiles.map((file) => asText(file.language, 'unknown')))
    const dependsOn = asArray(module.dependsOn).length
    return [
      code(id),
      languages.length > 0 ? languages.join('、') : asText(module.language, '未标注'),
      moduleFiles.length || asArray(module.files).length,
      num(module.loc),
      num(module.symbolCount),
      dependsOn,
      cycles.has(id) ? '在环上' : '—',
      riskOfModule(ctx, module),
      sourceNote('modules'),
    ]
  })
  return table(['模块', '语言', '文件数', 'LOC', '符号数', '依赖数', '环', '风险', '数据来源'], rows)
}

function moduleSection(ctx, module) {
  const id = String(module?.id ?? '')
  const moduleFiles = filesOfModule(ctx, id)
  const moduleSymbols = symbolsOfModule(ctx, id)
  const exported = moduleSymbols.filter((symbol) => symbol.exported === true)
  const routes = ctx.routes.filter((route) => String(route.moduleId ?? '') === id)
  const dependsOn = asArray(module.dependsOn).map((item) => String(item))
  const dependedOnBy = asArray(module.dependedOnBy).map((item) => String(item))
  const docs = ctx.docs.filter((doc) => id !== '.' && String(doc).startsWith(id))

  const out = []
  out.push(`### ${code(id)} — ${asText(module.kind, 'unknown')} 模块（风险 ${riskOfModule(ctx, module)}）`)
  out.push('')
  out.push(`- **职责（由符号与文档证据归纳）**：${modulePurpose(ctx, module, moduleFiles, moduleSymbols, docs)}`)
  out.push(`- **规模**：文件 ${moduleFiles.length || asArray(module.files).length} 个、LOC ${num(module.loc)}、符号 ${num(module.symbolCount)} 个${module.entrypoints?.length ? `、入口文件 ${module.entrypoints.length} 个` : ''}。${sourceNote('modules')}`)
  if (asArray(module.notes).length > 0) out.push(`- **模块备注**：${asArray(module.notes).map((item) => String(item)).join('；')}`)
  out.push('')

  out.push('**关键文件与符号**')
  out.push('')
  if (moduleFiles.length === 0 && moduleSymbols.length === 0) {
    out.push(dataGap('该模块没有解析到文件与符号（可能是配置、文档或资源模块）。', ['检查该目录是否被忽略规则排除']))
  } else {
    const topFiles = sortBy(moduleFiles, (file) => -num(file.loc)).slice(0, 8)
    const fileRows = topFiles.map((file) => {
      const symbols = moduleSymbols.filter((symbol) => String(symbol.fileId) === String(file.id))
      const top = sortBy(symbols, (symbol) => -num(symbol.loc)).slice(0, 4)
      return [
        code(asText(file.id)),
        asText(file.language, 'unknown'),
        num(file.loc),
        symbols.length,
        top.length > 0 ? top.map((symbol) => `${code(asText(symbol.name))}(${num(symbol.line)})`).join('、') : '—',
        asArray(file.todos).length,
        ev(asText(file.id), 1),
      ]
    })
    out.push(table(['文件', '语言', 'LOC', '符号数', '代表符号（行号）', 'TODO', '证据'], fileRows))
  }
  out.push('')

  out.push('**对外接口**')
  out.push('')
  const interfaceItems = []
  if (exported.length > 0) {
    interfaceItems.push(`- 导出符号 ${exported.length} 个：${exported.slice(0, 10).map((symbol) => `${code(asText(symbol.name))}（${code(asText(symbol.fileId))}:${num(symbol.line)}）`).join('、')}${exported.length > 10 ? ` 等 ${exported.length} 个` : ''}`)
  }
  if (routes.length > 0) {
    interfaceItems.push(`- HTTP 路由 ${routes.length} 条：${routes.slice(0, 8).map((route) => `${code(`${asText(route.method, 'GET')} ${asText(route.path, '/')}`)}（${num(route.line)} 行）`).join('、')}`)
  }
  if (interfaceItems.length === 0) interfaceItems.push('- 未发现导出符号或路由（该模块可能只提供内部实现或静态资源）。')
  out.push(interfaceItems.join('\n'))
  out.push('')

  out.push('**依赖与被依赖**')
  out.push('')
  const depRows = [
    ['依赖（dependsOn）', dependsOn.length > 0 ? dependsOn.map((item) => code(item)).join('、') : '无记录', sourceNote('modules')],
    ['被依赖（dependedOnBy）', dependedOnBy.length > 0 ? dependedOnBy.map((item) => code(item)).join('、') : '无记录', sourceNote('modules')],
    ['入度 / 出度', `${num(ctx.moduleFanIn[id])} / ${num(ctx.moduleFanOut[id])}`, sourceNote('graph')],
    ['文档证据', docs.length > 0 ? docs.map((doc) => code(String(doc))).join('、') : '未发现指向该模块的文档', docs[0] ? ev(String(docs[0]), 1) : '（数据不足）'],
  ]
  out.push(table(['关系', '目标', '来源（聚合）/ 证据（文件级）'], depRows))
  return out.join('\n')
}

function modulePurpose(ctx, module, moduleFiles, moduleSymbols, docs) {
  if (moduleSymbols.length === 0 && moduleFiles.length === 0) {
    return '数据不足（该模块没有文件与符号记录，无法归纳职责）。'
  }
  const names = sortBy(moduleSymbols, (symbol) => -(num(symbol.fanIn) + num(symbol.fanOut) + num(symbol.loc))).slice(0, 5).map((symbol) => asText(symbol.name)).filter(Boolean)
  const languages = uniq(moduleFiles.map((file) => asText(file.language, 'unknown')))
  const parts = []
  parts.push(`目录 ${code(String(module.id))}，主要语言 ${languages.length > 0 ? languages.join('、') : '未标注'}`)
  if (names.length > 0) parts.push(`核心符号 ${names.map((name) => code(name)).join('、')}`)
  const sample = moduleFiles[0]
  if (sample) parts.push(`证据：${ev(asText(sample.id), 1)}`)
  if (docs.length > 0) parts.push(`文档：${code(String(docs[0]))}`)
  else parts.push('文档：未发现（未验证是否存在隐含约定）')
  return `${parts.join('；')}。`
}

function unassignedFiles(ctx) {
  const known = new Set(ctx.modules.map((module) => String(module?.id ?? '')))
  const unassigned = ctx.files.filter((file) => !known.has(String(file.moduleId ?? '')))
  if (ctx.files.length === 0) {
    return dataGap('IR 中没有文件记录。', ['先运行 analyze 生成 IR'])
  }
  if (unassigned.length === 0) {
    return `全部 ${ctx.files.length} 个文件都归属到已知模块，没有未归属文件。`
  }
  const rows = unassigned.slice(0, 50).map((file) => [
    code(asText(file.id)),
    asText(file.language, 'unknown'),
    num(file.loc),
    asText(file.moduleId, '（空）'),
    asArray(file.warnings).length > 0 ? asArray(file.warnings).map((item) => String(item)).join('；') : '—',
  ])
  const more = unassigned.length > 50 ? `\n\n> 只列出前 50 个，其余 ${unassigned.length - 50} 个见 ${code('project-compass.json')}。` : ''
  return `${unassigned.length} 个文件未归属到任何已知模块（原因通常是模块 id 与 IR 的 Module.id 不一致，或解析被跳过）：\n\n${table(['文件', '语言', 'LOC', '记录的 moduleId', '告警'], rows)}${more}`
}

function renderKeyFlows(model, ctx, opts) {
  const out = []
  out.push(`# KEY_FLOWS · ${ctx.projectName} 关键流程`)
  out.push('')
  out.push(metaBlock(ctx))
  out.push('')
  out.push('> 流程由入口（路由/CLI/事件）出发，沿调用与导入关系展开；每一步都标注位置与证据，未能解析的步骤显式说明。')
  out.push('')

  if (ctx.flows.length === 0) {
    out.push('## 数据不足：未识别到流程')
    out.push('')
    out.push(dataGap('flows 为空（原因：没有可用的入口，或入口未被解析成调用链）。', ['先运行 analyze 生成 IR 与 flows', '检查 profile.entrypoints 是否为空']))
    out.push('')
    out.push(locateEntryHelp(ctx))
    return out.join('\n')
  }

  out.push('## 流程概览')
  out.push('')
  out.push(flowOverviewTable(ctx))
  out.push('')
  ctx.flows.slice(0, 12).forEach((flow, index) => {
    out.push(flowSection(ctx, flow, index + 1, opts), '')
  })
  if (ctx.flows.length > 12) {
    out.push(`> 只展开前 12 条流程，其余 ${ctx.flows.length - 12} 条见 ${code('project-compass.json')}。`, '')
  }
  out.push(locateEntryHelp(ctx))
  return out.join('\n')
}

function flowOverviewTable(ctx) {
  const rows = ctx.flows.map((flow, index) => {
    const entry = asObject(flow.entry)
    const steps = asArray(flow.steps)
    const unresolved = steps.filter((step) => !asObject(step).symbolId).length
    return [
      index + 1,
      asText(flow.name, asText(flow.id, '未命名流程')),
      asText(flow.kind, 'unknown'),
      entry.fileId ? code(`${asText(entry.fileId)}:${num(entry.line, 1)}`) : '（入口未知）',
      steps.length,
      unresolved,
      asText(flow.confidence, 'unknown'),
      entry.fileId ? `${sourceNote('flows')}；入口文件 ${ev(asText(entry.fileId), num(entry.line, 1))}` : '（入口未知）',
    ]
  })
  return table(['#', '流程', '类型', '入口', '步骤数', '未绑定符号步骤', '置信度', '数据来源 / 入口证据'], rows)
}

function flowSection(ctx, flow, index, opts) {
  const entry = asObject(flow.entry)
  const steps = asArray(flow.steps).map(asObject)
  const out = []
  out.push(`## 流程 ${index}：${asText(flow.name, asText(flow.id, '未命名流程'))}`)
  out.push('')
  out.push(`- **类型**：${asText(flow.kind, 'unknown')} ｜ **置信度**：${asText(flow.confidence, 'unknown')}`)
  out.push(`- **入口**：${entry.fileId ? `${code(`${asText(entry.fileId)}:${num(entry.line, 1)}`)}（符号 ${code(asText(entry.symbolName, '未识别'))}）` : '（数据不足：flow.entry 缺失）'}`)
  if (asArray(flow.evidence).length > 0) {
    out.push(`- **流程证据**：${asArray(flow.evidence).map((item) => code(String(item))).join('、')}`)
  } else {
    out.push('- **流程证据**：未提供（未验证：该流程由启发式推导，未经人工确认）')
  }
  out.push('')
  out.push(mermaidBlock(flowDiagram(flow, { maxParticipants: Math.max(2, Math.min(12, steps.length + 1)) }), opts))
  out.push('')
  out.push('### 步骤表')
  out.push('')
  if (steps.length === 0) {
    out.push(dataGap('该流程没有步骤记录。', ['检查 flows 生成阶段是否因预算截断', '从入口文件手动追踪调用']))
  } else {
    const rows = steps.slice(0, 60).map((step, stepIndex) => [
      num(step.order, stepIndex + 1),
      step.fileId ? code(`${asText(step.fileId)}:${num(step.line, 1)}`) : '（位置缺失）',
      code(asText(step.symbolName, '未绑定符号')),
      stepPurpose(step),
      step.fileId ? ev(asText(step.fileId), num(step.line, 1)) : '（无证据）',
    ])
    out.push(table(['序号', '位置', '符号', '作用', '证据'], rows))
  }
  out.push('')
  out.push('### 置信度与未解析说明')
  out.push('')
  const unresolved = steps.filter((step) => !step.symbolId)
  const bullets = []
  bullets.push(`- 置信度：${asText(flow.confidence, 'unknown')}（${sourceNote('flows')}）${asText(flow.confidence) === 'low' ? '；调用链存在较多未解析跳转，请人工确认' : ''}`)
  bullets.push(`- 步骤：共 ${steps.length} 步，其中 ${steps.length - unresolved.length} 步绑定到 IR 符号，${unresolved.length} 步未绑定符号（跨文件解析失败或为外部调用）；${sourceNote('flows')}。`)
  if (unresolved.length > 0) {
    bullets.push(`- 未绑定符号的步骤：${unresolved.slice(0, 5).map((step) => code(`${asText(step.fileId, '?')}:${num(step.line, 1)} ${asText(step.symbolName, asText(step.via, 'unknown'))}`)).join('、')}${unresolved.length > 5 ? ` 等 ${unresolved.length} 步` : ''}`)
  }
  for (const note of asArray(flow.notes).slice(0, 5)) bullets.push(`- 生成器备注：${String(note)}`)
  out.push(bullets.join('\n'))
  return out.join('\n')
}

function stepPurpose(step) {
  const kind = asText(step.kind, 'call')
  const via = asText(step.via, '')
  const map = {
    entry: '进入流程',
    call: '调用下游',
    data: '读写数据',
    'side-effect': '产生副作用',
    response: '返回结果',
  }
  const base = map[kind] ?? `执行 ${kind}`
  return via ? `${base}（经 ${via}）` : base
}

function locateEntryHelp(ctx) {
  const out = []
  out.push('## 如何自行定位入口')
  out.push('')
  out.push('当自动识别的流程不足时，按下面的顺序手工定位入口（每一步都给出可直接执行的依据）：')
  out.push('')
  const steps = []
  if (ctx.entrypoints.length > 0) {
    steps.push(`从 ${code('profile.entrypoints')} 开始：本项目记录了 ${ctx.entrypoints.length} 个入口，优先看 ${orderedEntrypoints(ctx).slice(0, 3).map((entry) => `${code(asText(entry.path))}（${asText(entry.kind, 'entry')}，证据 ${asText(entry.evidence, '未提供')}）`).join('、')}。`)
  } else {
    steps.push(`本项目的 ${code('profile.entrypoints')} 为空，说明扫描没有识别到启动点：请先确认清单文件的 ${code('main')} / ${code('bin')} / ${code('scripts')} 字段是否存在。`)
  }
  if (ctx.routes.length > 0) {
    const route = ctx.routes[0]
    steps.push(`从路由表入手：IR 记录 ${ctx.routes.length} 条路由，例如 ${code(`${asText(route.method, 'GET')} ${asText(route.path, '/')}`)}（${code(`${asText(route.fileId)}:${num(route.line, 1)}`)}）。`)
  } else {
    steps.push('IR 中没有路由记录：若项目是 CLI/库，入口在 `main` 导出或命令注册处；若是服务，搜索 `listen` / `createServer` / `app.run` 之类调用。')
  }
  if (ctx.hubs.length > 0) {
    steps.push(`从枢纽节点反推：${ctx.hubs.slice(0, 3).map((hub) => code(String(hub.id))).join('、')} 被依赖最多，通常是流程汇聚点（来自 ${code('graph.metrics.hubs')}）。`)
  }
  steps.push(`用检索兜底：${code('compass ask <项目> "请求进来之后经过哪些模块？"')}，回答会带 ${code('path:line')} 引用。`)
  steps.push(`用文本搜索确认：${code('grep -rn "listen\\|createServer\\|def main\\|func main" --include=*.js --include=*.py --include=*.go .')}（注意排除依赖目录）。`)
  out.push(steps.map((item, index) => `${index + 1}. ${item}`).join('\n'))
  return out.join('\n')
}

function renderGettingStarted(model, ctx, opts) {
  const out = []
  out.push(`# GETTING_STARTED · ${ctx.projectName} 环境与运行`)
  out.push('')
  out.push(metaBlock(ctx))
  out.push('')
  out.push('> 命令全部来自静态扫描到的清单脚本（标注来源）；报告不会输出任何疑似密钥的值，只列出位置。')
  out.push('')

  out.push('## 1. 环境要求')
  out.push('')
  out.push(environmentSection(ctx))
  out.push('')

  out.push('## 2. 上手流程')
  out.push('')
  out.push(mermaidBlock(gettingStartedFlowchart(ctx), opts))
  out.push('')
  out.push('> 流程由扫描到的清单脚本推导（缺失的步骤标注"未发现命令"，需要人工补齐）。')
  out.push('')

  out.push('## 3. 安装 / 构建 / 运行 / 测试')
  out.push('')
  out.push(commandSection(ctx))
  out.push('')

  out.push('## 4. 配置项与必需环境变量')
  out.push('')
  out.push(configSection(ctx))
  out.push('')

  out.push('## 5. 常见任务速查表')
  out.push('')
  out.push(cheatSheet(ctx))
  out.push('')

  out.push('## 6. 排障指南')
  out.push('')
  out.push(troubleshooting(ctx))
  out.push('')

  out.push('## 7. 首次贡献清单')
  out.push('')
  out.push(firstContribution(ctx))
  out.push('')
  return out.join('\n')
}

/** 流程图标签：双引号包裹 + 清理会破坏语法的字符。 */
function diagramLabel(text, max = 60) {
  return `"${mermaidSafe(String(text ?? '').replace(/[#;]/g, ' '), max)}"`
}

/** 上手流程示意图（节点 id 沿用 n0/n1 安全映射）。 */
function gettingStartedFlowchart(ctx) {
  const commandOf = (preset) => {
    const hit = ctx.commands.find((command) => String(command.preset) === preset)
    return hit ? asArray(hit.argv).join(' ') : ''
  }
  const steps = [
    ['准备环境', ctx.ecosystems.length > 0 ? asText(ctx.ecosystems[0].kind, 'runtime') : '未发现清单'],
    ['安装依赖', commandOf('install') || '未发现命令'],
    ['配置环境变量', ctx.configs.length > 0 ? `${ctx.configs.length} 个配置文件` : '未发现配置'],
    ['构建', commandOf('build') || '未发现命令'],
    ['运行测试', commandOf('test') || '未发现命令'],
    ['启动服务', commandOf('start') || commandOf('dev') || '未发现命令'],
  ]
  const lines = ['flowchart LR']
  steps.forEach(([title, detail], index) => {
    lines.push(`  n${index}[${diagramLabel(`${title}：${detail}`, 56)}]`)
  })
  for (let index = 1; index < steps.length; index += 1) lines.push(`  n${index - 1} --> n${index}`)
  return lines.join('\n')
}

function environmentSection(ctx) {
  const rows = []
  if (ctx.ecosystems.length > 0) {
    for (const ecosystem of ctx.ecosystems.slice(0, 4)) {
      const kind = asText(ecosystem.kind, 'unknown')
      const versionText = asText(ecosystem.version, '未标注')
      const requirement = kind === 'node'
        ? 'Node.js（版本以清单 engines 字段为准；扫描画像未携带 engines，需人工确认）'
        : `${kind} 运行时（版本以 ${asText(ecosystem.manifest, '清单')} 为准）`
      rows.push([kind, requirement, `清单版本 ${versionText}`, asText(ecosystem.manifest) ? ev(asText(ecosystem.manifest), 1) : '（未验证）'])
    }
  }
  if (ctx.containers.length > 0) {
    rows.push(['container', `可用容器方式运行：${ctx.containers.map((item) => code(item)).join('、')}（镜像内已固化运行时版本）`, '—', ev(ctx.containers[0], 1)])
  }
  if (rows.length === 0) {
    rows.push(['未知', '数据不足：未发现依赖清单与容器定义，无法推断运行时要求', '—', '（数据不足）'])
  }
  if (ctx.entrypoints.length > 0) {
    const entry = orderedEntrypoints(ctx)[0]
    rows.push(['运行形态', `入口 ${code(asText(entry.path))}（${asText(entry.kind, 'entry')}）`, asText(entry.evidence, '未提供'), ev(entry.path, entryLine(entry))])
  }
  if (asArray(ctx.tests.frameworks).length > 0) {
    rows.push(['测试运行时', asArray(ctx.tests.frameworks).map((item) => asText(item.label, asText(item.id, 'unknown'))).join('、'), '—', testEvidence(ctx)])
  }
  return table(['维度', '要求', '备注', '证据'], rows)
}

function commandSection(ctx) {
  if (ctx.commands.length === 0) {
    return dataGap('profile.commands 为空（原因：未读到清单脚本，或项目没有标准脚本）。', ['查看清单文件的 scripts 字段', '确认清单文件未被忽略规则排除'])
  }
  const presetLabels = {
    install: '安装依赖',
    build: '构建',
    typecheck: '类型检查',
    lint: '静态检查',
    format: '格式化',
    test: '单元测试',
    coverage: '覆盖率',
    e2e: '端到端测试',
    start: '启动（生产）',
    dev: '启动（开发）',
  }
  const rows = ctx.commands.map((command) => {
    const preset = asText(command.preset, 'unknown')
    const argv = asArray(command.argv).join(' ')
    return [presetLabels[preset] ?? preset, code(argv || '（命令为空）'), code(asText(command.source, '未知')), ev(asText(command.source, 'package.json'), 1)]
  })
  const discovered = ['install', 'build', 'test', 'dev', 'start'].filter((preset) => !ctx.commands.some((command) => String(command.preset) === preset))
  const lines = [table(['用途', '命令', '来源', '证据'], rows)]
  if (discovered.length > 0) {
    lines.push('')
    lines.push(`> 未发现这些预设命令：${discovered.map((item) => code(item)).join('、')}；如需补充，请先在清单文件的 scripts 中定义，再重新运行分析。`)
  }
  return lines.join('\n')
}

function configSection(ctx) {
  const out = []
  const envConfigs = ctx.configs.filter((config) => /\.env|env\.|config|settings|application\.(ya?ml|properties)|\.toml|\.ini|\.rc$/i.test(String(config.path)))
  const sensitive = asArray(ctx.signals.secretSuspects)

  if (envConfigs.length === 0 && sensitive.length === 0 && ctx.configs.length === 0) {
    out.push(dataGap('未发现配置文件或环境变量样例（原因：配置被忽略规则排除，或项目不使用外部配置）。', [`确认 ${code('.env.example')} 之类样例文件是否被忽略`, '确认 profile.configs 是否为空']))
    return out.join('\n')
  }

  if (ctx.configs.length > 0) {
    out.push('配置来源文件（只列位置，报告不读取内容）：')
    out.push('')
    out.push(table(['文件', '类型', '证据'], ctx.configs.slice(0, 30).map((config) => [code(asText(config.path)), asText(config.kind, 'unknown'), ev(asText(config.path), 1)])))
    out.push('')
  }
  if (sensitive.length > 0) {
    out.push(`**疑似密钥位置 ${sensitive.length} 处**（安全红线：报告只列位置与类型，绝不输出值）：`)
    out.push('')
    out.push(table(['位置', '类型', '证据'], sensitive.slice(0, 30).map((item) => [code(asText(item.path)), asText(item.kind, 'unknown'), ev(asText(item.path), num(item.line, 1))])))
    out.push('')
  }
  out.push('环境变量准备建议（**未验证**，需人工核对配置样例文件）：')
  out.push('')
  out.push([
    `- 复制配置样例（如存在 ${code('.env.example')}）为本地配置，再按需填写；样例文件位置见上表。`,
    '- 必填项以配置样例中的键名为准；本报告不输出任何键值，避免密钥泄漏。',
    '- 生产环境的密钥通过部署平台的密钥管理注入，不要提交到版本库。',
    `- 如需确认某个变量被哪些代码读取，使用 ${code('compass ask <项目> "DATABASE_URL 在哪些文件被读取？"')}。`,
  ].join('\n'))
  return out.join('\n')
}

function cheatSheet(ctx) {
  const rows = []
  const byPreset = new Map(ctx.commands.map((command) => [String(command.preset), command]))
  const defaults = [
    ['安装依赖', 'install'],
    ['启动开发', 'dev'],
    ['构建产物', 'build'],
    ['跑测试', 'test'],
    ['类型检查', 'typecheck'],
    ['静态检查', 'lint'],
  ]
  for (const [task, preset] of defaults) {
    const command = byPreset.get(preset)
    rows.push([
      task,
      command ? code(asArray(command.argv).join(' ')) : '未发现对应脚本',
      command ? code(asText(command.source, '未知')) : '—',
      command ? ev(asText(command.source, 'package.json'), 1) : '（数据不足）',
    ])
  }
  rows.push(['定位入口', code('compass analyze <项目> 后查看 KEY_FLOWS.md'), 'project-compass', ctx.flows.length > 0 ? ev(asText(asObject(ctx.flows[0].entry).fileId), num(asObject(ctx.flows[0].entry).line, 1)) : '（未发现流程）'])
  return table(['任务', '命令', '来源', '证据'], rows)
}

function troubleshooting(ctx) {
  const lines = []
  const testFiles = firstFinite(num(ctx.tests.testFileCount, NaN), asArray(ctx.tests.testFiles).length)
  if (asArray(ctx.tests.frameworks).length === 0 && testFiles === 0) {
    lines.push('- **完全没有测试**：先补一个最小冒烟测试覆盖入口，再参考 KEY_FLOWS.md 的关键路径逐步加集成测试。')
  }
  if (ctx.cycles.length > 0) {
    lines.push(`- **循环依赖 ${ctx.cycles.length} 处**（${sourceNote('graph')}）：优先打破涉及枢纽模块的环（见 ARCHITECTURE.md），否则加载顺序问题会间歇性出现。`)
  }
  if (ctx.riskModules.length > 0) {
    lines.push(`- **高风险模块 ${ctx.riskModules.length} 个**（${sourceNote('graph')}）：改动前先看 MODULE_MAP.md 的入度/出度，评估影响面。`)
  }
  if (ctx.warnings.length > 0) {
    lines.push(`- **分析告警 ${ctx.warnings.length} 条**（${sourceNote('scan')}）：${ctx.warnings.slice(0, 3).map((item) => code(item)).join('、')}${ctx.warnings.length > 3 ? ' 等' : ''}；这些位置的分析结果可能不完整。`)
  }
  if (ctx.truncated) {
    lines.push('- **本次分析被预算截断**：报告只覆盖已分析的文件，结论可能低估规模；可放宽预算后重跑。')
  }
  if (ctx.orphans.length > 0) {
    lines.push(`- **孤立文件 ${ctx.orphans.length} 个**（${sourceNote('graph')}）：可能是死代码或未接入的模块，确认后再删除。`)
  }
  if (ctx.containers.length > 0) {
    lines.push(`- **本地能跑、线上不行**：先对比容器定义（${ctx.containers.map((item) => code(item)).join('、')}）里的运行时版本与工作目录。`)
  }
  if (ctx.ci.length === 0) {
    lines.push('- **没有 CI 配置**：把测试与构建命令写进流水线，避免依赖本地手工验证。')
  }
  if (lines.length === 0) {
    lines.push('未发现明显排障线索（没有告警、循环依赖或高风险模块）。建议先跑通测试命令，再用 `KEY_FLOWS.md` 验证关键路径。')
  }
  return lines.join('\n')
}

function firstContribution(ctx) {
  const items = []
  const testFiles = firstFinite(num(ctx.tests.testFileCount, NaN), asArray(ctx.tests.testFiles).length)
  if (ctx.docs.length > 0) {
    items.push(`- [ ] 阅读现有文档并补齐过时内容：${ctx.docs.slice(0, 3).map((doc) => code(String(doc))).join('、')}（证据：${ev(String(ctx.docs[0]), 1)}）`)
  } else {
    items.push('- [ ] 未发现项目文档：补一份 README（记录启动方式与目录约定）是本项目性价比最高的第一贡献。')
  }
  if (testFiles > 0) {
    items.push(`- [ ] 跑通测试并确认失败项：${testEvidence(ctx)}`)
  } else {
    items.push('- [ ] 为入口补一个冒烟测试（项目当前没有测试文件证据）。')
  }
  if (asArray(ctx.signals.todos).length > 0) {
    const todo = asArray(ctx.signals.todos)[0]
    items.push(`- [ ] 认领一个 TODO：${code(`${asText(todo.path, '?')}:${num(todo.line)}`)} ${asText(todo.text, '')}`)
  }
  if (ctx.gaps.length > 0) {
    const gap = ctx.gaps[0]
    const evidence = asArray(gap.evidence)[0]
    const parsed = parseEvidence(evidence)
    items.push(`- [ ] 处理最高优先级缺口 [${asText(gap.priority, 'P?')}] ${asText(gap.title, gap.id)}${parsed.path ? `（证据：${code(parsed.text || citationText(parsed))}）` : ''}`)
  }
  for (const route of renderRoleRoutes(ctx.model, { role: 'devops' })) {
    if (route.order.length > 0 && !route.order[0].path) {
      items.push('- [ ] 补 Dockerfile 与 CI 流水线（当前无明显运维证据）。')
    }
  }
  if (ctx.entrypoints.length > 0) {
    const entry = orderedEntrypoints(ctx)[0]
    items.push(`- [ ] 从入口通读一遍主流程：${ev(entry.path, entryLine(entry))}，并用 ${code('compass ask')} 验证理解。`)
  } else {
    items.push(`- [ ] 入口未识别：确认清单文件的 ${code('main')} / ${code('bin')} / ${code('scripts')} 字段。`)
  }
  items.push('- [ ] 在本地复跑 build / test，记录与 CI 的差异。')
  return items.join('\n')
}

/* ------------------------------------------------------------------ *
 * JSON 摘要视图
 * ------------------------------------------------------------------ */

function buildJsonView(model, ctx, opts) {
  const notes = []
  const files = ctx.files.slice(0, opts.maxFiles)
  if (ctx.files.length > files.length) notes.push(`files 已截断：保留 ${files.length}/${ctx.files.length}（可用 options.maxFiles 调整）`)

  const symbols = sortBy(ctx.symbols, (symbol) => -(num(symbol.fanIn) + num(symbol.fanOut))).slice(0, opts.maxSymbols)
  if (ctx.symbols.length > symbols.length) notes.push(`symbols 已截断：按 fanIn+fanOut 保留 ${symbols.length}/${ctx.symbols.length}（可用 options.maxSymbols 调整）`)

  const routes = ctx.routes.slice(0, opts.maxRoutes)
  if (ctx.routes.length > routes.length) notes.push(`routes 已截断：保留 ${routes.length}/${ctx.routes.length}`)

  const riskItems = []
  for (const gap of ctx.gaps) {
    riskItems.push({ source: 'profile.gaps', id: asText(gap.id), priority: asText(gap.priority, 'P?'), title: asText(gap.title), detail: asText(gap.detail), evidence: asArray(gap.evidence).map((item) => String(item)) })
  }
  for (const risk of riskEntries(ctx)) {
    riskItems.push({
      source: risk.source,
      severity: risk.severity || undefined,
      priority: risk.evidence.length > 0 ? 'P2' : 'P3',
      title: risk.title,
      detail: risk.detail,
      evidence: risk.evidence,
      verified: risk.verified || risk.evidence.length > 0,
    })
  }
  for (const module of ctx.riskModules) {
    riskItems.push({ source: 'graph.metrics.riskModules', id: asText(module.id), priority: 'P1', title: `高风险模块 ${asText(module.id)}`, detail: asArray(module.reasons).map((item) => String(item)).join('；'), evidence: [] })
  }

  const todos = asArray(ctx.signals.todos)
  const view = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: ctx.generatedAt,
    tool: { name: TOOL_NAME, version: ctx.version },
    project: {
      name: ctx.projectName,
      kinds: ctx.kinds,
      ecosystems: ctx.ecosystems.map((item) => ({ kind: asText(item.kind), manifest: asText(item.manifest), name: asText(item.name), version: asText(item.version) })),
      languages: ctx.languages.map((item) => ({ name: asText(item.name), files: num(item.files), loc: num(item.loc), bytes: num(item.bytes) })),
      size: {
        files: fileCount(ctx),
        sourceFiles: sourceFileCount(ctx),
        dirs: num(ctx.size.dirs),
        bytes: num(ctx.size.bytes),
        loc: locCount(ctx),
        modules: ctx.modules.length,
        symbols: symbolCount(ctx),
        imports: firstFinite(num(ctx.irStats.imports, NaN), asArray(ctx.ir.imports).length),
        calls: firstFinite(num(ctx.irStats.calls, NaN), asArray(ctx.ir.calls).length),
        routes: ctx.routes.length,
        flows: ctx.flows.length,
        tests: {
          files: firstFinite(num(ctx.tests.testFileCount, NaN), asArray(ctx.tests.testFiles).length),
          frameworks: asArray(ctx.tests.frameworks).map((item) => ({ id: asText(item.id), label: asText(item.label), evidence: asText(item.evidence) })),
        },
      },
    },
    modules: ctx.modules.map((module) => {
      const id = String(module?.id ?? '')
      return {
        id,
        name: asText(module?.name, id),
        kind: asText(module?.kind, 'unknown'),
        loc: num(module?.loc),
        files: filesOfModule(ctx, id).length || asArray(module?.files).length,
        dependsOn: asArray(module?.dependsOn).map((item) => String(item)),
        risk: riskOfModule(ctx, module),
      }
    }),
    files: files.map((file) => ({
      id: asText(file.id),
      moduleId: asText(file.moduleId),
      language: asText(file.language, 'unknown'),
      loc: num(file.loc),
      symbolCount: asArray(file.symbols).length,
      routeCount: asArray(file.routes).length,
    })),
    symbols: symbols.map((symbol) => ({
      id: asText(symbol.id),
      name: asText(symbol.name),
      kind: asText(symbol.kind, 'unknown'),
      fileId: asText(symbol.fileId),
      line: num(symbol.line),
      exported: symbol.exported === true,
      fanIn: num(symbol.fanIn, num(ctx.fileFanIn[asText(symbol.fileId)])),
      fanOut: num(symbol.fanOut, num(ctx.fileFanOut[asText(symbol.fileId)])),
    })),
    routes: routes.map((route) => ({
      id: asText(route.id, `${asText(route.method, 'GET')} ${asText(route.path, '/')}`),
      method: asText(route.method, 'GET'),
      path: asText(route.path, '/'),
      framework: asText(route.framework),
      fileId: asText(route.fileId),
      moduleId: asText(route.moduleId),
      line: num(route.line),
      handlerName: asText(route.handlerName) || null,
      kind: asText(route.kind, 'http'),
    })),
    entrypoints: ctx.entrypoints.map((entry) => ({ path: asText(entry.path), kind: asText(entry.kind, 'entry'), evidence: asText(entry.evidence) })),
    commands: ctx.commands.map((command) => ({ preset: asText(command.preset, 'unknown'), argv: asArray(command.argv).map((item) => String(item)), source: asText(command.source) })),
    flows: ctx.flows.map((flow) => ({
      id: asText(flow.id),
      name: asText(flow.name),
      kind: asText(flow.kind, 'unknown'),
      entry: {
        fileId: asText(asObject(flow.entry).fileId),
        line: num(asObject(flow.entry).line),
        symbolId: asText(asObject(flow.entry).symbolId) || null,
        symbolName: asText(asObject(flow.entry).symbolName) || null,
      },
      steps: asArray(flow.steps).map((step, index) => ({
        order: num(asObject(step).order, index + 1),
        fileId: asText(asObject(step).fileId),
        line: num(asObject(step).line),
        symbolId: asText(asObject(step).symbolId) || null,
        symbolName: asText(asObject(step).symbolName) || null,
        kind: asText(asObject(step).kind, 'call'),
        via: asText(asObject(step).via),
      })),
      confidence: asText(flow.confidence, 'unknown'),
    })),
    graph: {
      stats: jsonSafe(ctx.graphStats) ?? {},
      hubs: ctx.hubs.slice(0, 20).map((hub) => ({ id: asText(hub.id), fanIn: num(hub.fanIn), fanOut: num(hub.fanOut) })),
      cycles: ctx.cycles.map((cycle) => asArray(cycle).map((id) => String(id))),
      riskModules: ctx.riskModules.map((module) => ({ id: asText(module.id), score: num(module.score), reasons: asArray(module.reasons).map((item) => String(item)) })),
    },
    risks: {
      count: riskItems.length,
      items: riskItems,
      todos: {
        count: firstFinite(num(ctx.signals.todoCount, NaN), todos.length),
        byKind: Object.fromEntries([...groupBy(todos, (todo) => asText(asObject(todo).kind, 'todo')).entries()].map(([kind, list]) => [kind, list.length])),
        samples: todos.slice(0, 20).map((todo) => ({ path: asText(asObject(todo).path), line: num(asObject(todo).line), kind: asText(asObject(todo).kind, 'todo'), text: asText(asObject(todo).text) })),
      },
      signals: {
        todoCount: firstFinite(num(ctx.signals.todoCount, NaN), todos.length),
        debugStatementCount: num(ctx.signals.debugStatementCount),
        secretSuspects: asArray(ctx.signals.secretSuspects).map((item) => ({ path: asText(asObject(item).path), line: num(asObject(item).line), kind: asText(asObject(item).kind, 'unknown') })),
        largeFiles: asArray(ctx.signals.largeFiles).map((item) => String(item)),
        generatedFiles: asArray(ctx.signals.generatedFiles).map((item) => String(item)),
      },
      warnings: ctx.warnings,
      gaps: ctx.gaps.map((gap) => ({ id: asText(gap.id), priority: asText(gap.priority, 'P?'), title: asText(gap.title), detail: asText(gap.detail), evidence: asArray(gap.evidence).map((item) => String(item)) })),
    },
    roleRoutes: renderRoleRoutes(model, opts),
    evidence: {
      policy: EVIDENCE_POLICY,
      sources: ['ir', 'profile', 'graph', 'flows', 'insights'],
      llm: { used: ctx.llm.used, provider: ctx.llm.provider, model: ctx.llm.model, calls: ctx.llm.calls },
      validation: { droppedCount: ctx.droppedCount },
      budget: jsonSafe(ctx.budget) ?? {},
      warnings: ctx.warnings,
      notes: [
        '本项目 JSON 是 IR 的摘要视图，不是全量 IR；modules[].files 为文件数量而非文件 id 列表。',
        ...notes,
        ctx.llm.used ? 'LLM 参与了叙述生成；未通过验证器的声明已被丢弃。' : '本报告全部结论来自静态证据，未调用 LLM。',
      ],
    },
  }
  return jsonSafe(view)
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

function safeRender(label, ctx, worker, isJson = false) {
  try {
    return worker()
  } catch (error) {
    const reason = error && error.message ? String(error.message) : '未知错误'
    if (isJson) {
      return jsonSafe({
        schemaVersion: SCHEMA_VERSION,
        generatedAt: ctx.generatedAt,
        tool: { name: TOOL_NAME, version: ctx.version },
        project: { name: ctx.projectName },
        evidence: { policy: EVIDENCE_POLICY, notes: [`渲染失败已降级：${reason}`, '数据不足：请检查 IR / profile / graph 数据是否完整。'] },
      })
    }
    return [
      `# ${label}`,
      '',
      metaBlock(ctx),
      '',
      '## 数据不足',
      '',
      `渲染过程中遇到问题，已降级输出（渲染层不抛错）：${reason}`,
      '',
      '请检查 IR / profile / graph 数据是否完整后重试。',
    ].join('\n')
  }
}

/**
 * 渲染全部产物。
 * @param model 见契约 §8：`{ ir, profile, graph, flows, insights, meta }`（各字段均可缺失）。
 * @param options `{ projectName, includeMermaid, maxNodes, role, locale, topModules, maxFiles, maxSymbols }`。
 * @returns `{ files: Record<key, string|object>, meta }`，files 的 6 个键与 `REPORT_ORDER` 一致。
 */
export function renderReports(model, options = {}) {
  const opts = normalizeOptions(options)
  const ctx = prepare(model, opts)
  const files = {
    onboarding: safeRender('ONBOARDING', ctx, () => renderOnboarding(model, ctx, opts)),
    architecture: safeRender('ARCHITECTURE', ctx, () => renderArchitecture(model, ctx, opts)),
    moduleMap: safeRender('MODULE_MAP', ctx, () => renderModuleMap(model, ctx, opts)),
    keyFlows: safeRender('KEY_FLOWS', ctx, () => renderKeyFlows(model, ctx, opts)),
    gettingStarted: safeRender('GETTING_STARTED', ctx, () => renderGettingStarted(model, ctx, opts)),
    json: safeRender('JSON', ctx, () => buildJsonView(model, ctx, opts), true),
  }

  const ordered = {}
  for (const key of REPORT_ORDER) {
    if (key === 'json') ordered.json = isObject(files.json) ? files.json : {}
    else ordered[key] = typeof files[key] === 'string' ? files[key] : ''
  }

  return {
    files: ordered,
    meta: {
      generatedAt: ctx.generatedAt,
      version: ctx.version,
      projectName: ctx.projectName,
      tool: { name: TOOL_NAME, version: ctx.version },
      keys: Object.keys(ordered),
      llm: { used: ctx.llm.used, provider: ctx.llm.provider, model: ctx.llm.model },
      validation: { droppedCount: ctx.droppedCount },
      counts: {
        modules: ctx.modules.length,
        files: ctx.files.length,
        symbols: ctx.symbols.length,
        routes: ctx.routes.length,
        flows: ctx.flows.length,
        risks: ctx.gaps.length + ctx.riskModules.length,
      },
      warnings: ctx.warnings,
      options: { includeMermaid: opts.includeMermaid, maxNodes: opts.maxNodes, role: opts.role, locale: opts.locale },
    },
  }
}
