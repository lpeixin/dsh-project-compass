/**
 * 依赖图谱（FR4）：模块级 / 文件级 / 符号级三张图 + 环检测 + 风险度量。
 *
 * 图的唯一数据来源是 IR 里已经解析好的边（`imports[].target`、`calls[].toSymbolId`），
 * 本模块**不做任何新的解析或猜测**——图上有什么，IR 里就有什么，这是"证据可追溯"的底线。
 *
 * 规模控制：符号图只保留"参与了已解析调用"的符号与边，
 * 否则一个 5 万符号的仓库会产出无法渲染也无法阅读的图。
 *
 * @module dsh-project-compass/graph
 */

import { countBy, toPosix, uniq } from './util.js'

/**
 * 构建三张图与度量。
 * @param ir 统一 IR。
 * @param options.maxSymbolNodes 符号图节点上限（默认 1500）。
 * @param options.maxCycles 环数量上限（默认 50）。
 * @param options.hubLimit 枢纽数量上限（默认 30）。
 * @param options.riskLimit 高风险模块数量上限（默认 20）。
 * @returns GraphBundle（形状见 docs/INTERNAL-CONTRACTS.md §5）。
 */
export function buildGraphs(ir, options = {}) {
  const maxSymbolNodes = Number.isFinite(options.maxSymbolNodes) ? Math.max(1, Math.trunc(options.maxSymbolNodes)) : 1500
  const maxCycles = Number.isFinite(options.maxCycles) ? Math.max(1, Math.trunc(options.maxCycles)) : 50
  const hubLimit = Number.isFinite(options.hubLimit) ? Math.max(1, Math.trunc(options.hubLimit)) : 30
  const riskLimit = Number.isFinite(options.riskLimit) ? Math.max(1, Math.trunc(options.riskLimit)) : 20

  const files = ir?.files ?? []
  const modules = ir?.modules ?? []
  const symbols = ir?.symbols ?? []
  const imports = ir?.imports ?? []
  const calls = ir?.calls ?? []

  /* ---------------- 模块级 ---------------- */
  const moduleNodes = modules.map((module) => ({
    id: module.id,
    label: module.name,
    kind: module.kind,
    loc: module.loc,
    fileCount: module.files?.length ?? 0,
    files: [...(module.files ?? [])].sort(),
    symbolCount: module.symbolCount ?? 0,
  }))
  const moduleEdgeWeights = new Map()
  for (const record of imports) {
    if (record.targetModule === null || record.targetModule === record.moduleId) continue
    const key = `${record.moduleId}\u0000${record.targetModule}`
    moduleEdgeWeights.set(key, (moduleEdgeWeights.get(key) ?? 0) + 1)
  }
  const moduleEdges = [...moduleEdgeWeights.entries()]
    .map(([key, weight]) => {
      const [from, to] = key.split('\u0000')
      return { from, to, weight, external: false }
    })
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1))

  /* ---------------- 文件级 ---------------- */
  const fileNodes = files.map((file) => ({
    id: file.id,
    label: file.id,
    moduleId: file.moduleId,
    kind: file.kind,
    language: file.language,
    loc: file.loc,
    symbolCount: file.symbols?.length ?? 0,
  }))
  const fileEdgeWeights = new Map()
  for (const record of imports) {
    if (record.target === null || record.target === record.fileId) continue
    const key = `${record.fileId}\u0000${record.target}`
    fileEdgeWeights.set(key, (fileEdgeWeights.get(key) ?? 0) + 1)
  }
  const fileEdges = [...fileEdgeWeights.entries()]
    .map(([key, weight]) => {
      const [from, to] = key.split('\u0000')
      return { from, to, weight, external: false }
    })
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1))

  /* ---------------- 符号级（只有已解析调用才入图） ---------------- */
  const resolvedCalls = calls.filter((call) => call.toSymbolId !== null)
  const degree = new Map()
  for (const call of resolvedCalls) {
    degree.set(call.toSymbolId, (degree.get(call.toSymbolId) ?? 0) + 1)
    if (call.fromSymbolId !== null) degree.set(call.fromSymbolId, (degree.get(call.fromSymbolId) ?? 0) + 1)
  }
  const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]))
  const rankedSymbolIds = [...degree.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxSymbolNodes)
    .map(([id]) => id)
  const keptSymbolIds = new Set(rankedSymbolIds)
  const symbolNodes = rankedSymbolIds
    .map((id) => symbolById.get(id))
    .filter((symbol) => symbol !== undefined)
    .map((symbol) => ({
      id: symbol.id,
      label: symbol.name,
      fileId: symbol.fileId,
      moduleId: symbol.moduleId,
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      fanIn: symbol.fanIn ?? 0,
      fanOut: symbol.fanOut ?? 0,
    }))
  const symbolEdgeWeights = new Map()
  for (const call of resolvedCalls) {
    if (call.fromSymbolId === null || call.fromSymbolId === call.toSymbolId) continue
    if (!keptSymbolIds.has(call.fromSymbolId) || !keptSymbolIds.has(call.toSymbolId)) continue
    const key = `${call.fromSymbolId}\u0000${call.toSymbolId}`
    symbolEdgeWeights.set(key, (symbolEdgeWeights.get(key) ?? 0) + 1)
  }
  const symbolEdges = [...symbolEdgeWeights.entries()]
    .map(([key, weight]) => {
      const [from, to] = key.split('\u0000')
      return { from, to, weight, external: false }
    })
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1))

  /* ---------------- 环检测（迭代式 Tarjan，避免深递归爆栈） ---------------- */
  const moduleCycles = detectCycles(moduleNodes.map((node) => node.id), moduleEdges, maxCycles)
  const fileCycles = detectCycles(fileNodes.map((node) => node.id), fileEdges, maxCycles)
  const symbolCycles = detectCycles(symbolNodes.map((node) => node.id), symbolEdges, Math.min(maxCycles, 10))
  const moduleInCycle = new Set(moduleCycles.flat())

  /* ---------------- 度量 ---------------- */
  const fileFanIn = countBy(fileEdges, (edge) => edge.to)
  const fileFanOut = countBy(fileEdges, (edge) => edge.from)
  const moduleFanIn = countBy(moduleEdges, (edge) => edge.to)
  const moduleFanOut = countBy(moduleEdges, (edge) => edge.from)

  const hubs = fileNodes
    .map((node) => ({
      id: node.id,
      fanIn: fileFanIn.get(node.id) ?? 0,
      fanOut: fileFanOut.get(node.id) ?? 0,
      moduleId: node.moduleId,
    }))
    .filter((entry) => entry.fanIn + entry.fanOut > 0)
    .sort((a, b) => (b.fanIn - a.fanIn) || (b.fanOut - a.fanOut) || (a.id < b.id ? -1 : 1))
    .slice(0, hubLimit)

  const entryFiles = uniq(
    (ir?.profileSummary?.entrypoints ?? [])
      .map((entry) => toPosix(typeof entry === 'string' ? entry : entry?.path ?? ''))
      .filter((id) => id.length > 0),
  )
  const entryReach = reachableFrom(entryFiles, fileEdges)

  const orphans = fileNodes
    .filter((node) => {
      if (node.kind === 'config' || node.kind === 'docs' || node.kind === 'asset' || node.kind === 'infra') return false
      if (entryFiles.includes(node.id)) return false
      return (fileFanIn.get(node.id) ?? 0) === 0 && (fileFanOut.get(node.id) ?? 0) === 0
    })
    .map((node) => node.id)
    .sort()

  const unresolvedByFile = countBy(calls.filter((call) => call.resolution === 'unresolved'), (call) => call.fileId)
  const fileById = new Map(files.map((file) => [file.id, file]))

  const riskModules = modules
    .map((module) => {
      const reasons = []
      let score = 0
      const fanIn = moduleFanIn.get(module.id) ?? 0
      if (fanIn >= 10) {
        score += 3
        reasons.push(`被 ${fanIn} 个模块依赖（高扇入）`)
      } else if (fanIn >= 5) {
        score += 2
        reasons.push(`被 ${fanIn} 个模块依赖`)
      }
      if (moduleInCycle.has(module.id)) {
        score += 3
        reasons.push('位于依赖环上')
      }
      const moduleFiles = module.files ?? []
      const unresolved = moduleFiles.reduce((total, id) => total + (unresolvedByFile.get(id) ?? 0), 0)
      const callTotal = moduleFiles.reduce((total, id) => total + (fileById.get(id)?.calls?.length ?? 0), 0)
      if (callTotal > 0 && unresolved / callTotal > 0.6 && unresolved >= 5) {
        score += 2
        reasons.push(`未解析调用占比高（${unresolved}/${callTotal}）`)
      }
      const hasTest = moduleFiles.some((id) => fileById.get(id)?.kind === 'test')
      if (!hasTest && (module.kind === 'source' || module.kind === 'mixed')) {
        score += 1
        reasons.push('该模块没有测试文件')
      }
      if ((module.loc ?? 0) > 2000) {
        score += 1
        reasons.push(`模块规模偏大（${module.loc} 行）`)
      }
      return { id: module.id, score: Math.min(10, score), reasons }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1))
    .slice(0, riskLimit)

  return {
    module: { nodes: moduleNodes, edges: moduleEdges, cycles: moduleCycles },
    file: { nodes: fileNodes, edges: fileEdges, cycles: fileCycles },
    symbol: { nodes: symbolNodes, edges: symbolEdges, cycles: symbolCycles },
    metrics: {
      fanIn: Object.fromEntries([...fileFanIn.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      fanOut: Object.fromEntries([...fileFanOut.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      moduleFanIn: Object.fromEntries([...moduleFanIn.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      moduleFanOut: Object.fromEntries([...moduleFanOut.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
      hubs,
      orphans,
      entryReach,
      riskModules,
    },
    stats: {
      moduleNodes: moduleNodes.length,
      moduleEdges: moduleEdges.length,
      fileNodes: fileNodes.length,
      fileEdges: fileEdges.length,
      symbolNodes: symbolNodes.length,
      symbolEdges: symbolEdges.length,
      crossModuleEdges: moduleEdges.length,
      cycles: moduleCycles.length + fileCycles.length,
      fileCycles: fileCycles.length,
      moduleCycles: moduleCycles.length,
      orphanFiles: orphans.length,
      truncatedSymbols: Math.max(0, degree.size - symbolNodes.length),
    },
  }
}

/**
 * 环检测：迭代式 Tarjan 求强连通分量，返回规模 > 1 的分量（外加自环）。
 * @param nodes 节点 id 列表。
 * @param edges `[{from,to}]`。
 * @param limit 返回的环数量上限。
 * @returns 每个环是节点 id 数组（已排序，便于稳定输出）。
 */
export function detectCycles(nodes, edges, limit = 50) {
  const adjacency = new Map()
  for (const node of nodes) adjacency.set(node, [])
  for (const edge of edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue
    adjacency.get(edge.from).push(edge.to)
  }
  for (const [, list] of adjacency) list.sort()

  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const components = []
  let counter = 0

  for (const root of [...adjacency.keys()].sort()) {
    if (index.has(root)) continue
    // 显式栈模拟递归：frame = {node, childIndex}
    const frames = [{ node: root, childIndex: 0 }]
    index.set(root, counter)
    low.set(root, counter)
    counter += 1
    stack.push(root)
    onStack.add(root)

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      const children = adjacency.get(frame.node) ?? []
      if (frame.childIndex < children.length) {
        const next = children[frame.childIndex]
        frame.childIndex += 1
        if (!index.has(next)) {
          index.set(next, counter)
          low.set(next, counter)
          counter += 1
          stack.push(next)
          onStack.add(next)
          frames.push({ node: next, childIndex: 0 })
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(next)))
        }
        continue
      }
      frames.pop()
      if (frames.length > 0) {
        const parent = frames[frames.length - 1].node
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = []
        for (;;) {
          const popped = stack.pop()
          onStack.delete(popped)
          component.push(popped)
          if (popped === frame.node) break
        }
        if (component.length > 1) components.push(component.sort())
        else {
          const only = component[0]
          if ((adjacency.get(only) ?? []).includes(only)) components.push([only])
        }
      }
    }
  }

  components.sort((a, b) => (b.length - a.length) || (a[0] < b[0] ? -1 : 1))
  return components.slice(0, limit)
}

/** 从一组起点沿有向边可达的文件集合（含起点）。 */
function reachableFrom(starts, edges) {
  const adjacency = new Map()
  for (const edge of edges) {
    const bucket = adjacency.get(edge.from)
    if (bucket === undefined) adjacency.set(edge.from, [edge.to])
    else bucket.push(edge.to)
  }
  const seen = new Map()
  const queue = [...starts]
  for (const start of starts) seen.set(start, true)
  while (queue.length > 0) {
    const current = queue.shift()
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue
      seen.set(next, true)
      queue.push(next)
    }
  }
  return Object.fromEntries([...seen.keys()].sort().map((key) => [key, true]))
}
