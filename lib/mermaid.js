/**
 * Mermaid 图表渲染（纯函数：不读盘、不调 LLM、不抛错）。
 *
 * 渲染约定：
 *   1. 节点 id 一律映射为 `n0`、`n1`……，中文与特殊字符只出现在带双引号的标签里，
 *      因此方括号、引号、竖线、中文都不会破坏语法；
 *   2. 边统一写成 `-->|weight|`（跨层用虚线 `-.->|weight|`）；
 *   3. 节点数超过 `options.maxNodes`（默认 40）时，按 `fanIn + fanOut` 排序保留
 *      连接度最高的节点，并**显式**输出一行"（已省略 X 个节点）"注记，绝不静默截断；
 *   4. 数据缺失时返回合法空图（`flowchart TD` + `empty["无数据"]`），而不是抛错。
 *
 * 返回的是 **Mermaid 源码本身**，不带 ``` 围栏，围栏由调用方（lib/report.js）决定。
 *
 * @module dsh-project-compass/mermaid
 */

import { mermaidSafe } from './util.js'

/** 流程图节点上限默认值（契约 §8 `options.maxNodes`）。 */
export const DEFAULT_MAX_NODES = 40

/** 时序图参与者上限默认值（参与者过多时图不可读，超出会注明）。 */
export const DEFAULT_MAX_PARTICIPANTS = 12

/** 架构分层顺序：模块 kind → 中文层名（未列出的 kind 归入"其它"）。 */
const LAYERS = [
  ['source', '源码'],
  ['test', '测试'],
  ['config', '配置'],
  ['infra', '基础设施'],
  ['docs', '文档'],
  ['asset', '资源'],
  ['generated', '生成物'],
  ['mixed', '混合'],
  ['other', '其它'],
]

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** 标签安全文本：去掉会破坏 Mermaid 语法的字符，并中和实体编码前缀 `#`。 */
function safeText(value, max = 60) {
  return mermaidSafe(String(value ?? '').replace(/[#;]/g, ' '), max)
}

/** 带双引号的标签（中文标签必须加引号）。 */
function quoted(value, max = 60) {
  return `"${safeText(value, max)}"`
}

/** Mermaid 标识符安全化（用于 subgraph id 这类必须 ASCII 的位置）。 */
function safeId(value) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9_]/g, '_')
  return text.length > 0 ? text : 'other'
}

/** 读取 options 中的上限，非法值回落到默认值。 */
function limitOf(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

/* ------------------------------------------------------------------ *
 * 图数据规整
 * ------------------------------------------------------------------ */

/** 兼容 GraphBundle 与"直接传入子图"两种调用方式。 */
function bundleOf(graph, bucket) {
  const source = isObject(graph) ? graph : {}
  if (isObject(source[bucket])) return source
  const nested = isObject(source.graph) ? source.graph : null
  if (nested && isObject(nested[bucket])) return nested
  return source
}

/** 取出某个桶（module/file/symbol）的子图。 */
function pickSubGraph(graph, bucket) {
  const source = isObject(graph) ? graph : {}
  const candidate = isObject(source[bucket]) ? source[bucket] : null
  if (candidate && (Array.isArray(candidate.nodes) || Array.isArray(candidate.edges))) return candidate
  if (Array.isArray(source.nodes) || Array.isArray(source.edges)) return source
  return { nodes: [], edges: [], cycles: [] }
}

/** 取出 GraphBundle.metrics。 */
function metricsOf(graph) {
  const source = isObject(graph) ? graph : {}
  return isObject(source.metrics) ? source.metrics : {}
}

function normalizeNodes(sub) {
  return asArray(sub.nodes).map((node, index) => {
    const source = isObject(node) ? node : {}
    const id = String(source.id ?? index)
    return {
      id,
      label: source.label ?? source.name ?? id,
      kind: source.kind,
      loc: Number.isFinite(source.loc) ? source.loc : undefined,
      files: Number.isFinite(source.files) ? source.files : Array.isArray(source.files) ? source.files.length : undefined,
      symbolCount: Number.isFinite(source.symbolCount) ? source.symbolCount : undefined,
    }
  })
}

function normalizeEdges(sub) {
  return asArray(sub.edges)
    .map((edge) => {
      const source = isObject(edge) ? edge : {}
      const weight = Number.isFinite(source.weight) ? Math.max(1, Math.trunc(source.weight)) : 1
      return { from: String(source.from ?? ''), to: String(source.to ?? ''), weight }
    })
    .filter((edge) => edge.from.length > 0 && edge.to.length > 0 && edge.from !== edge.to)
}

/** 由边统计 fanIn / fanOut，作为 metrics 缺失时的兜底。 */
function connectivity(edges) {
  const fanIn = new Map()
  const fanOut = new Map()
  for (const edge of edges) {
    fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1)
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1)
  }
  return { fanIn, fanOut }
}

function pickMetric(record, id, fallbackMap) {
  if (isObject(record) && Number.isFinite(record[id])) return record[id]
  if (record instanceof Map && Number.isFinite(record.get(id))) return record.get(id)
  const value = fallbackMap.get(id)
  return Number.isFinite(value) ? value : 0
}

/**
 * 依据 fanIn+fanOut 选点：未超限时全保留（维持输入顺序）；超限时取连接度最高的 max 个。
 * @returns {{ kept: object[], omitted: number }}
 */
function selectNodes(nodes, edges, metrics, maxNodes) {
  const total = nodes.length
  if (total <= maxNodes) return { kept: nodes.slice(), omitted: 0 }
  const fallback = connectivity(edges)
  const ranked = nodes.map((node, index) => {
    const fanIn = pickMetric(metrics.fanIn, node.id, fallback.fanIn)
    const fanOut = pickMetric(metrics.fanOut, node.id, fallback.fanOut)
    return { index, score: fanIn + fanOut }
  })
  ranked.sort((a, b) => b.score - a.score || a.index - b.index)
  const chosen = new Set(ranked.slice(0, maxNodes).map((item) => item.index))
  return { kept: nodes.filter((_, index) => chosen.has(index)), omitted: total - chosen.size }
}

/** 节点标签：名称 + 规模提示，全部走双引号包裹。 */
function nodeLabel(node) {
  const parts = [String(node.label ?? node.id)]
  if (Number.isFinite(node.loc)) parts.push(`${node.loc} 行`)
  if (Number.isFinite(node.files)) parts.push(`${node.files} 文件`)
  if (Number.isFinite(node.symbolCount) && node.symbolCount > 0) parts.push(`${node.symbolCount} 符号`)
  return quoted(parts.join(' · '), 64)
}

/* ------------------------------------------------------------------ *
 * 流程图（模块图 / 文件图 / 分层架构图 共用内核）
 * ------------------------------------------------------------------ */

function renderFlowchart(config) {
  const { nodes, edges, metrics, options, title, layers } = config
  const kindOf = typeof config.kindOf === 'function' ? config.kindOf : () => 'other'
  const maxNodes = limitOf(options?.maxNodes, DEFAULT_MAX_NODES)
  const lines = ['flowchart TD']

  if (nodes.length === 0) {
    lines.push('  empty["无数据"]')
    lines.push(`  %% 数据不足：${safeText(title, 40)} 没有可用节点，请先运行 analyze 生成 IR 与依赖图`)
    return lines.join('\n')
  }

  const { kept, omitted } = selectNodes(nodes, edges, metrics, maxNodes)
  const keptIds = new Set(kept.map((node) => node.id))
  const idMap = new Map()
  kept.forEach((node, index) => idMap.set(node.id, `n${index}`))
  lines.push(`  %% ${safeText(title, 40)}：节点 ${nodes.length} 个 / 边 ${edges.length} 条，本次绘制 ${kept.length} 个节点`)

  const layerOf = (id) => String(kindOf(id) ?? 'other')
  const useLayers = Array.isArray(layers) && layers.length > 0

  if (useLayers) {
    const grouped = new Set()
    for (const [kind, label] of layers) {
      const members = kept.filter((node) => layerOf(node.id) === kind)
      if (members.length === 0) continue
      grouped.add(kind)
      lines.push(`  subgraph sg_${safeId(kind)}[${quoted(`${label} ${kind}`, 40)}]`)
      lines.push('    direction TB')
      for (const node of members) lines.push(`    ${idMap.get(node.id)}[${nodeLabel(node)}]`)
      lines.push('  end')
    }
    const rest = kept.filter((node) => !grouped.has(layerOf(node.id)))
    if (rest.length > 0) {
      lines.push(`  subgraph sg_other[${quoted('其它 other', 40)}]`)
      lines.push('    direction TB')
      for (const node of rest) lines.push(`    ${idMap.get(node.id)}[${nodeLabel(node)}]`)
      lines.push('  end')
    }
  } else {
    for (const node of kept) lines.push(`  ${idMap.get(node.id)}[${nodeLabel(node)}]`)
  }

  let crossEdges = 0
  for (const edge of edges) {
    if (!keptIds.has(edge.from) || !keptIds.has(edge.to)) continue
    const from = idMap.get(edge.from)
    const to = idMap.get(edge.to)
    const cross = useLayers && layerOf(edge.from) !== layerOf(edge.to)
    if (cross) crossEdges += 1
    lines.push(`  ${from} ${cross ? '-.->' : '-->'}|${edge.weight}| ${to}`)
  }

  if (useLayers) {
    lines.push(`  %% 图例：实线为同层依赖，虚线为跨层依赖，共 ${crossEdges} 条跨层依赖`)
  }
  if (omitted > 0) {
    lines.push(`  %% （已省略 ${omitted} 个节点）按 fanIn+fanOut 排序仅保留连接度最高的 ${maxNodes} 个节点，被省略节点相关的边未绘制`)
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 对外的三类流程图
 * ------------------------------------------------------------------ */

/**
 * 模块依赖图（节点为模块/目录）。
 * @param graph GraphBundle，或 `{module:{nodes,edges}}`，或直接是子图。
 * @param options `{ maxNodes = 40, groupByKind = false }`。
 */
export function moduleGraphDiagram(graph, options = {}) {
  const opts = isObject(options) ? options : {}
  const bundle = bundleOf(graph, 'module')
  const sub = pickSubGraph(bundle, 'module')
  const nodes = normalizeNodes(sub)
  const edges = normalizeEdges(sub)
  const kindMap = new Map(nodes.map((node) => [node.id, node.kind]))
  return renderFlowchart({
    nodes,
    edges,
    metrics: metricsOf(bundle),
    options: opts,
    title: '模块依赖图',
    layers: opts.groupByKind === true ? LAYERS : null,
    kindOf: (id) => kindMap.get(id) ?? 'other',
  })
}

/**
 * 文件依赖图（节点为文件）。
 * @param graph GraphBundle，或 `{file:{nodes,edges}}`，或直接是子图。
 * @param options `{ maxNodes = 40 }`。
 */
export function fileGraphDiagram(graph, options = {}) {
  const opts = isObject(options) ? options : {}
  const bundle = bundleOf(graph, 'file')
  const sub = pickSubGraph(bundle, 'file')
  const nodes = normalizeNodes(sub)
  const edges = normalizeEdges(sub)
  const kindMap = new Map(nodes.map((node) => [node.id, node.kind]))
  return renderFlowchart({
    nodes,
    edges,
    metrics: metricsOf(bundle),
    options: opts,
    title: '文件依赖图',
    layers: null,
    kindOf: (id) => kindMap.get(id) ?? 'other',
  })
}

/**
 * 分层架构图：按模块 kind（source/test/config/infra/docs…）用 subgraph 分组，
 * 跨层依赖画虚线，同层依赖画实线。
 * @param model `{ ir, graph }`（也可只传 `{ modules, graph }`）。
 * @param options `{ maxNodes = 40 }`。
 */
export function architectureDiagram(model, options = {}) {
  const opts = isObject(options) ? options : {}
  const source = isObject(model) ? model : {}
  const ir = isObject(source.ir) ? source.ir : {}
  const modules = asArray(ir.modules).length > 0 ? asArray(ir.modules) : asArray(source.modules)
  const bundle = bundleOf(source.graph, 'module')
  const sub = pickSubGraph(bundle, 'module')

  let edges = normalizeEdges(sub)
  if (modules.length > 0 && edges.length === 0) {
    // 退化路径：图边缺失时用 Module.dependsOn 兜底
    edges = []
    for (const module of modules) {
      const from = String(module?.id ?? '')
      if (!from) continue
      for (const target of asArray(module?.dependsOn)) {
        const to = String(target ?? '')
        if (to && to !== from) edges.push({ from, to, weight: 1 })
      }
    }
  }

  const nodes = modules.length > 0
    ? modules.map((module) => ({
        id: String(module?.id ?? ''),
        label: module?.name ?? module?.id ?? '未命名模块',
        kind: module?.kind,
        loc: Number.isFinite(module?.loc) ? module.loc : undefined,
        files: asArray(module?.files).length,
        symbolCount: Number.isFinite(module?.symbolCount) ? module.symbolCount : undefined,
      })).filter((node) => node.id.length > 0)
    : normalizeNodes(sub)

  const kindMap = new Map(nodes.map((node) => [node.id, node.kind]))
  return renderFlowchart({
    nodes,
    edges,
    metrics: metricsOf(bundle),
    options: opts,
    title: '分层架构图',
    layers: LAYERS,
    kindOf: (id) => kindMap.get(id) ?? 'other',
  })
}

/* ------------------------------------------------------------------ *
 * 时序图（流程）
 * ------------------------------------------------------------------ */

/** 步骤归属的参与者：优先文件，其次模块。 */
function participantKey(step) {
  const source = isObject(step) ? step : {}
  return String(source.fileId ?? source.moduleId ?? 'unknown')
}

/** 参与者别名：纯 ASCII 路径保持裸写（渲染更干净），含中文/特殊字符时加双引号。 */
function participantAlias(text) {
  const safe = safeText(text, 48)
  return /^[A-Za-z0-9_./\\-]+$/.test(safe) ? safe : quoted(safe, 48)
}

/** 消息文本：符号 / 通过点 / 类型 + 位置，去掉了会破坏语法的字符。 */
function messageText(step) {
  const parts = []
  const name = asTextLocal(step.symbolName) || asTextLocal(step.via) || asTextLocal(step.kind) || '步骤'
  parts.push(name)
  const fileId = asTextLocal(step.fileId) || asTextLocal(step.moduleId)
  if (fileId) {
    const line = Number.isFinite(step.line) ? `:${step.line}` : ''
    parts.push(`${fileId}${line}`)
  }
  if (asTextLocal(step.kind) && asTextLocal(step.kind) !== name) parts.push(asTextLocal(step.kind))
  return safeText(parts.join(' · '), 80)
}

function asTextLocal(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function sequenceCore(flow, options = {}) {
  const source = isObject(flow) ? flow : {}
  const steps = asArray(source.steps)
  const opts = isObject(options) ? options : {}
  const maxParticipants = limitOf(opts.maxParticipants, DEFAULT_MAX_PARTICIPANTS)
  const lines = ['sequenceDiagram']
  const title = asTextLocal(source.name) || asTextLocal(source.id) || '未命名流程'

  if (steps.length === 0) {
    lines.push('  participant empty as "无数据"')
    lines.push(`  Note over empty: 数据不足：流程「${safeText(title, 40)}」没有可用步骤`)
    return lines.join('\n')
  }

  const keys = []
  for (const step of steps) {
    const key = participantKey(step)
    if (!keys.includes(key)) keys.push(key)
  }
  const keptKeys = keys.slice(0, maxParticipants)
  const omittedParticipants = keys.length - keptKeys.length
  const idOf = new Map(keptKeys.map((key, index) => [key, `n${index}`]))

  for (const key of keptKeys) lines.push(`  participant ${idOf.get(key)} as ${participantAlias(key)}`)
  lines.push('  autonumber')

  let previous = null
  let drawn = 0
  let skipped = 0
  for (const step of steps) {
    const current = participantKey(step)
    if (!idOf.has(current)) {
      skipped += 1
      continue
    }
    const fromKey = previous && idOf.has(previous) ? previous : current
    const arrow = asTextLocal(step.kind) === 'response' ? '-->>' : '->>'
    lines.push(`  ${idOf.get(fromKey)}${arrow}${idOf.get(current)}: ${messageText(step)}`)
    previous = current
    drawn += 1
  }

  if (opts.notes !== false) {
    const first = 'n0'
    const last = `n${Math.max(0, keptKeys.length - 1)}`
    // 只有一个参与者时用单参与者 Note，避免 `Note over A,A` 这类退化写法
    const noteTarget = keptKeys.length > 1 ? `${first},${last}` : first
    const confidence = asTextLocal(source.confidence) || 'unknown'
    const notes = asArray(source.notes).map((item) => asTextLocal(item)).filter((item) => item.length > 0)
    const noteText = [`置信度 ${confidence}`, `步骤 ${drawn}/${steps.length}`, ...notes.slice(0, 2)].join('；')
    lines.push(`  Note over ${noteTarget}: ${safeText(noteText, 90)}`)
    if (omittedParticipants > 0) {
      lines.push(`  Note over ${first}: （已省略 ${omittedParticipants} 个参与者，共 ${skipped} 步未绘制）`)
    } else if (skipped > 0) {
      lines.push(`  Note over ${first}: 有 ${skipped} 步因缺失归属文件未绘制`)
    }
  }

  return lines.join('\n')
}

/**
 * 由 Flow 生成 Mermaid 时序图（契约 §5 / §8：参与者为文件或模块，步骤按 flow.steps 顺序，行号写在消息里）。
 * @param flow Flow 对象。
 */
export function sequenceForFlow(flow) {
  return sequenceCore(flow, { notes: false })
}

/**
 * 流程时序图（带置信度注记），同样以 `sequenceDiagram` 开头。
 * @param flow Flow 对象。
 * @param options `{ maxParticipants = 12, notes = true }`。
 */
export function flowDiagram(flow, options = {}) {
  const opts = isObject(options) ? options : {}
  return sequenceCore(flow, { notes: opts.notes !== false, maxParticipants: opts.maxParticipants })
}
