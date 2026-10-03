/**
 * 关键流程识别（FR 中"核心业务逻辑如何流转"的答案来源）。
 *
 * 做法：以**入口**为种子，沿 IR 里**已解析的调用边**做有界 BFS，产出一条带顺序、
 * 带行号、带置信度的调用链。未解析的边不会被"脑补"成步骤，而是计入 `notes`，
 * 因此读者能一眼看出"这条链在后面断了"。
 *
 * 入口有三类来源：
 *   1. HTTP/事件路由（`ir.routes`）——最贴近"业务怎么进来"；
 *   2. 可执行入口（`profile.entrypoints` 的 main/bin/cli + 测试入口）；
 *   3. 公开 API 面（导出且被内部调用的高扇入符号）。
 *
 * @module dsh-project-compass/flows
 */

import { mermaidSafe, toPosix, uniq } from './util.js'

/** 单条流程最多保留的步骤数（避免大仓产生几百行的时序图）。 */
const DEFAULT_MAX_STEPS = 24

/** 同类流程的数量上限。 */
const DEFAULT_LIMITS = { http: 12, cli: 6, event: 6, library: 8, data: 4 }

/**
 * 识别关键流程。
 * @param ir 统一 IR。
 * @param options.maxSteps 单条流程步骤上限。
 * @param options.limits 各类流程数量上限。
 * @param options.maxDepth 调用链深度上限（默认 5）。
 * @returns Flow[]（形状见 docs/INTERNAL-CONTRACTS.md §5）。
 */
export function detectFlows(ir, options = {}) {
  const maxSteps = Number.isFinite(options.maxSteps) ? Math.max(3, Math.trunc(options.maxSteps)) : DEFAULT_MAX_STEPS
  const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(1, Math.trunc(options.maxDepth)) : 5
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }

  const files = ir?.files ?? []
  const symbols = ir?.symbols ?? []
  const calls = ir?.calls ?? []
  const routes = ir?.routes ?? []
  const fileById = new Map(files.map((file) => [file.id, file]))
  const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]))

  /** 出边索引：fromSymbolId → 已解析调用。 */
  const outEdges = new Map()
  let unresolvedFromSymbols = 0
  for (const call of calls) {
    if (call.fromSymbolId === null) continue
    if (call.toSymbolId === null) {
      unresolvedFromSymbols += 1
      continue
    }
    const bucket = outEdges.get(call.fromSymbolId)
    if (bucket === undefined) outEdges.set(call.fromSymbolId, [call])
    else bucket.push(call)
  }
  for (const [, list] of outEdges) {
    list.sort((a, b) => (a.line - b.line) || (a.calleeName < b.calleeName ? -1 : 1))
  }

  const flows = []

  /* ---------------- 1. 路由驱动的流程 ---------------- */
  const routesByKind = { http: [], event: [], cli: [] }
  for (const route of routes) {
    const bucket = routesByKind[route.kind] ?? routesByKind.http
    bucket.push(route)
  }
  for (const route of routesByKind.http) {
    if (flows.filter((flow) => flow.kind === 'http').length >= limits.http) break
    flows.push(buildRouteFlow(route, { symbolById, fileById, outEdges, maxSteps, maxDepth }))
  }
  for (const route of routesByKind.event) {
    if (flows.filter((flow) => flow.kind === 'event').length >= limits.event) break
    const flow = buildRouteFlow(route, { symbolById, fileById, outEdges, maxSteps, maxDepth })
    flow.kind = 'event'
    flows.push(flow)
  }

  /* ---------------- 2. 可执行入口驱动的流程 ---------------- */
  const entrypoints = ir?.profileSummary?.entrypoints ?? []
  const mainEntries = entrypoints
    .map((entry) => (typeof entry === 'string' ? { path: entry, kind: 'main' } : entry))
    .map((entry) => ({ path: toPosix(entry?.path ?? ''), kind: entry?.kind ?? 'main', evidence: entry?.evidence ?? null }))
    .filter((entry) => entry.path.length > 0)

  let cliCount = 0
  for (const entry of mainEntries) {
    if (cliCount >= limits.cli) break
    if (entry.kind === 'test-entry') continue
    const file = fileById.get(entry.path)
    if (file === undefined) continue
    const seeds = (file.symbols ?? [])
      .map((id) => symbolById.get(id))
      .filter((symbol) => symbol !== undefined)
      .filter((symbol) => /^(main|cli|run|start|bootstrap|app|createApp|__main__)$/i.test(symbol.name))
      .slice(0, 4)
    // 兜底仅在真正的可执行入口（bin/cli）上启用：随便挑一个高扇出符号当"入口"
    // 会产出误导性的调用链，那比没有流程更糟。
    const executable = entry.kind === 'cli' || entry.kind === 'bin'
    const fallback = seeds.length === 0 && executable
      ? (file.symbols ?? [])
          .map((id) => symbolById.get(id))
          .filter((symbol) => symbol !== undefined)
          .sort((a, b) => (b.fanOut ?? 0) - (a.fanOut ?? 0) || (a.id < b.id ? -1 : 1))
          .slice(0, 1)
      : []
    const roots = seeds.length > 0 ? seeds : fallback
    if (roots.length === 0) continue
    const flow = buildSymbolFlow(roots[0], {
      kind: entry.kind === 'http-server' ? 'http' : 'cli',
      name: `${entry.kind === 'cli' || entry.kind === 'bin' ? 'CLI 入口' : '程序入口'}：${entry.path}`,
      symbolById,
      fileById,
      outEdges,
      maxSteps,
      maxDepth,
      extraEvidence: entry.evidence ? [String(entry.evidence)] : [],
    })
    flows.push(flow)
    cliCount += 1
  }

  /* ---------------- 3. 公开 API 面（库型项目的主要"流程"） ---------------- */
  const exportedRanked = symbols
    .filter((symbol) => symbol.exported && ((symbol.fanIn ?? 0) > 0 || (symbol.fanOut ?? 0) > 0))
    .sort((a, b) => ((b.fanIn + b.fanOut) - (a.fanIn + a.fanOut)) || (a.id < b.id ? -1 : 1))
    .slice(0, limits.library)
  for (const symbol of exportedRanked) {
    const edges = outEdges.get(symbol.id) ?? []
    if (edges.length === 0) continue
    flows.push(
      buildSymbolFlow(symbol, {
        kind: 'library',
        name: `公开 API：${symbol.name}`,
        symbolById,
        fileById,
        outEdges,
        maxSteps,
        maxDepth,
      }),
    )
  }

  /* ---------------- 4. 数据流（配置文件 → 读取它的代码） ---------------- */
  flows.push(...detectDataFlows(ir, { symbolById, fileById, outEdges, maxSteps, limits }))

  return flows
    .map((flow) => ({ ...flow, evidence: uniq(flow.evidence).slice(0, 40) }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : 1))
    .filter((flow, index, list) => list.findIndex((candidate) => candidate.id === flow.id) === index)
    .slice(0, limits.http + limits.cli + limits.event + limits.library + limits.data)
}

/** 路由 → 流程：入口是路由本身，步骤从处理器符号向下走。 */
function buildRouteFlow(route, context) {
  const { symbolById, fileById, outEdges, maxSteps, maxDepth } = context
  const handler = route.handlerSymbolId === null ? undefined : symbolById.get(route.handlerSymbolId)
  const notes = []
  let confidence = 'low'

  const steps = [
    {
      order: 0,
      fileId: route.fileId,
      line: route.line,
      symbolId: handler?.id ?? null,
      symbolName: handler?.name ?? route.handlerName ?? null,
      kind: 'entry',
      via: `${route.method} ${route.path}`,
    },
  ]

  if (handler === undefined) {
    notes.push(
      route.handlerName
        ? `路由处理器 ${route.handlerName} 未在项目内解析到符号，后续调用链无法展开。`
        : '路由处理器为内联函数且未解析到符号，后续调用链无法展开。',
    )
  } else {
    const walked = walkCalls(handler.id, { outEdges, symbolById, fileById, maxSteps: maxSteps - 1, maxDepth })
    steps.push(...walked.steps)
    notes.push(...walked.notes)
    confidence = walked.resolvedSteps >= 3 ? 'high' : walked.resolvedSteps >= 1 ? 'medium' : 'low'
  }

  const framework = route.framework && route.framework !== 'unknown' ? route.framework : '未知框架'
  return {
    id: `http:${route.method}:${route.path}:${route.fileId}:${route.line}`,
    name: `${route.method} ${route.path}`,
    kind: route.kind === 'event' ? 'event' : 'http',
    entry: {
      fileId: route.fileId,
      line: route.line,
      symbolId: handler?.id ?? null,
      symbolName: handler?.name ?? null,
      label: `${route.method} ${route.path}（${framework}）`,
    },
    steps: steps.map((step, index) => ({ ...step, order: index })),
    evidence: steps.map((step) => `${step.fileId}:${step.line}`),
    confidence,
    notes,
  }
}

/** 符号 → 流程：入口是一个函数，向下走调用链。 */
function buildSymbolFlow(symbol, options) {
  const { symbolById, fileById, outEdges, maxSteps, maxDepth, kind, name, extraEvidence } = options
  const walked = walkCalls(symbol.id, { outEdges, symbolById, fileById, maxSteps: maxSteps - 1, maxDepth })
  const steps = [
    {
      order: 0,
      fileId: symbol.fileId,
      line: symbol.line,
      symbolId: symbol.id,
      symbolName: symbol.name,
      kind: 'entry',
      via: '入口符号',
    },
    ...walked.steps,
  ]
  return {
    id: `${kind}:${symbol.id}`,
    name,
    kind,
    entry: { fileId: symbol.fileId, line: symbol.line, symbolId: symbol.id, symbolName: symbol.name, label: name },
    steps: steps.map((step, index) => ({ ...step, order: index })),
    evidence: uniq([...steps.map((step) => `${step.fileId}:${step.line}`), ...(extraEvidence ?? [])]),
    confidence: walked.resolvedSteps >= 3 ? 'high' : walked.resolvedSteps >= 1 ? 'medium' : 'low',
    notes: walked.notes,
  }
}

/**
 * 有界 BFS：从起始符号沿已解析调用边展开。
 * 同一符号只入链一次（避免环导致重复）；深度或步数触顶时记 note。
 */
function walkCalls(startSymbolId, context) {
  const { outEdges, symbolById, fileById, maxSteps, maxDepth } = context
  const steps = []
  const notes = []
  const visited = new Set([startSymbolId])
  const queue = [{ symbolId: startSymbolId, depth: 1, via: null }]
  let resolvedSteps = 0
  let truncated = false

  while (queue.length > 0) {
    const current = queue.shift()
    if (current.depth > maxDepth) {
      truncated = true
      continue
    }
    for (const call of outEdges.get(current.symbolId) ?? []) {
      if (steps.length >= maxSteps) {
        truncated = true
        break
      }
      const target = call.toSymbolId === null ? undefined : symbolById.get(call.toSymbolId)
      if (target === undefined) continue
      if (visited.has(target.id)) continue
      visited.add(target.id)
      resolvedSteps += 1
      steps.push({
        order: steps.length + 1,
        fileId: target.fileId,
        line: target.line,
        symbolId: target.id,
        symbolName: target.name,
        kind: kindOfSymbol(target, fileById),
        via: `由 ${symbolById.get(current.symbolId)?.name ?? '?'} 调用（调用点 ${call.fileId}:${call.line}）`,
      })
      queue.push({ symbolId: target.id, depth: current.depth + 1, via: call.id })
    }
    if (steps.length >= maxSteps) break
  }

  if (truncated) notes.push(`调用链在 ${maxSteps} 步 / 深度 ${maxDepth} 处截断，后续未展开。`)
  if (steps.length === 0) notes.push('该入口没有解析到向下的调用边（可能是薄封装、或调用目标未被静态解析）。')
  return { steps, notes, resolvedSteps }
}

/** 步骤归类：副作用 / 数据访问 / 普通调用。 */
function kindOfSymbol(symbol, fileById) {
  const file = fileById.get(symbol.fileId)
  const name = String(symbol.name ?? '')
  if (/^(save|insert|update|delete|create|remove|write|persist|upsert|patch|put|post)/i.test(name)) return 'side-effect'
  if (/^(find|get|query|select|fetch|load|read|list|search|lookup)/i.test(name)) return 'data'
  if (file !== undefined && file.kind === 'config') return 'data'
  return 'call'
}

/**
 * 数据流：配置文件（`.env.example`、`config/*`、`settings.*`）被哪些代码读取。
 * 依据是 import 边指向 config 类文件——这是静态可证的弱信号，因此置信度封顶 medium。
 */
function detectDataFlows(ir, context) {
  const { symbolById, outEdges, maxSteps, limits } = context
  const files = ir?.files ?? []
  const imports = ir?.imports ?? []
  const configFiles = new Set(files.filter((file) => file.kind === 'config').map((file) => file.id))
  const consumers = new Map()
  for (const record of imports) {
    if (record.target === null || !configFiles.has(record.target)) continue
    const bucket = consumers.get(record.target)
    if (bucket === undefined) consumers.set(record.target, [record.fileId])
    else bucket.push(record.fileId)
  }
  const flows = []
  const ranked = [...consumers.entries()].sort((a, b) => (b[1].length - a[1].length) || (a[0] < b[0] ? -1 : 1))
  for (const [configFile, fileIds] of ranked) {
    if (flows.length >= limits.data) break
    const steps = []
    for (const fileId of uniq(fileIds).sort().slice(0, maxSteps - 1)) {
      const file = files.find((candidate) => candidate.id === fileId)
      const symbolId = (file?.symbols ?? [])[0] ?? null
      const symbol = symbolId === null ? undefined : symbolById.get(symbolId)
      const importRecord = imports.find((record) => record.fileId === fileId && record.target === configFile)
      steps.push({
        order: steps.length + 1,
        fileId,
        line: importRecord?.line ?? 1,
        symbolId: symbol?.id ?? null,
        symbolName: symbol?.name ?? null,
        kind: 'data',
        via: `读取配置 ${configFile}`,
      })
    }
    if (steps.length === 0) continue
    flows.push({
      id: `data:${configFile}`,
      name: `配置读取：${configFile}`,
      kind: 'data',
      entry: { fileId: configFile, line: 1, symbolId: null, symbolName: null, label: `${configFile}（配置）` },
      steps: [
        { order: 0, fileId: configFile, line: 1, symbolId: null, symbolName: null, kind: 'entry', via: '配置来源' },
        ...steps.map((step, index) => ({ ...step, order: index + 1 })),
      ],
      evidence: [configFile, ...steps.map((step) => `${step.fileId}:${step.line}`)],
      confidence: 'low',
      notes: ['配置项与代码的对应关系来自静态 import，运行时注入的环境变量可能另有来源。'],
    })
  }
  // outEdges 在此路径用不到，保留参数是为了与其它流程构造器签名一致。
  void outEdges
  return flows
}

/**
 * 单条流程的 Mermaid 流程图（`flowchart LR`）。
 * 需要时序图时用 `lib/mermaid.js` 的 `sequenceForFlow`。
 * @param flow 流程。
 * @param options.maxSteps 渲染上限（默认 12）。
 */
export function flowDiagram(flow, options = {}) {
  const maxSteps = Number.isFinite(options.maxSteps) ? Math.max(2, Math.trunc(options.maxSteps)) : 12
  const steps = (flow?.steps ?? []).slice(0, maxSteps)
  const omitted = Math.max(0, (flow?.steps ?? []).length - steps.length)
  const lines = ['flowchart LR']
  if (steps.length === 0) {
    lines.push('  empty["该流程没有可渲染的步骤"]')
    return lines.join('\n')
  }
  steps.forEach((step, index) => {
    const label = `${step.symbolName ?? step.fileId}`
    const detail = `${step.fileId}:${step.line}`
    lines.push(`  s${index}["${mermaidSafe(`${label}\\n${detail}`, 70)}"]`)
  })
  for (let index = 1; index < steps.length; index += 1) lines.push(`  s${index - 1} --> s${index}`)
  if (omitted > 0) lines.push(`  omitted["（已省略 ${omitted} 步）"]`)
  return lines.join('\n')
}

/** 流程摘要：报告与工具返回都用它，避免把整条链塞进 JSON。 */
export function flowSummary(flow) {
  return {
    id: flow.id,
    name: flow.name,
    kind: flow.kind,
    confidence: flow.confidence,
    entry: flow.entry,
    stepCount: (flow.steps ?? []).length,
    evidence: flow.evidence ?? [],
    notes: flow.notes ?? [],
  }
}
