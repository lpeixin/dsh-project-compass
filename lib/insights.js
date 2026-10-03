/**
 * 洞察层：把 IR/图谱/画像变成"人话"，并在这里落实 FR6 的**事实约束**。
 *
 * 分两半，界限分明：
 *   - **确定性半边**（`buildReadingOrder` / `collectRisks`）：纯计算，永远可用，
 *     每条结论都能指回 `path:line`；不依赖 LLM、不联网；
 *   - **LLM 半边**（`generateNarratives`）：LLM 只被允许"用给定事实写措辞"，
 *     输出必须是带引用的结构化断言，且**逐条过验证器**，验证不过的直接丢。
 *
 * 这样安排的结果是：LLM 关掉时报告依然完整（只是少一点润色），
 * LLM 打开时也不会凭空多出任何无法追溯的内容。
 *
 * @module dsh-project-compass/insights
 */

import { clip, sortBy, toPosix, uniq } from './util.js'
import { extractJson, LLM_ERROR } from './llm.js'

/** 风险严重度排序权重。 */
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 }

/**
 * 生成"该按什么顺序读代码"——这是入门报告最实用的一节。
 * 依据：文档 → 清单 → 入口 → 路由 → 枢纽模块 → 测试 → 部署配置。
 *
 * @param ir 统一 IR。
 * @param graph 图谱。
 * @param flows 关键流程。
 * @returns `[{ step, target, path, line, why, evidence }]`
 */
export function buildReadingOrder(ir, graph, flows) {
  if (ir === undefined || ir === null || typeof ir !== 'object') return []
  const files = ir?.files ?? []
  const profile = ir?.profileSummary ?? {}
  const steps = []
  const push = (target, why, path, line, evidence) => {
    if (path === undefined || path === null) return
    steps.push({ step: steps.length + 1, target, why, path: toPosix(path), line: line ?? 1, evidence: evidence ?? [`${toPosix(path)}:${line ?? 1}`] })
  }

  const readme = files.find((file) => /^(README|readme)(\.[a-z]+)?$/i.test(file.id.split('/').pop() ?? ''))
  if (readme !== undefined) push('项目说明', '先建立业务语境：这个项目是做什么的', readme.id, 1)

  const manifest = (profile.ecosystems ?? [])[0]
  if (manifest?.manifest) push('依赖与脚本清单', '搞清技术栈与可执行命令', manifest.manifest, 1)

  for (const entry of (profile.entrypoints ?? []).slice(0, 3)) {
    const path = toPosix(typeof entry === 'string' ? entry : entry?.path ?? '')
    if (path.length === 0) continue
    const file = files.find((candidate) => candidate.id === path)
    const symbol = (file?.symbols ?? [])
      .map((id) => (ir.symbols ?? []).find((candidate) => candidate.id === id))
      .filter((candidate) => candidate !== undefined)
      .sort((a, b) => (b.fanOut ?? 0) - (a.fanOut ?? 0))[0]
    push('程序入口', '程序从这里启动，读完它就知道全局装配方式', path, symbol?.line ?? 1)
  }

  const routeFile = (ir.routes ?? [])[0]
  if (routeFile !== undefined) push('路由定义', '对外契约都在这里，是理解业务的捷径', routeFile.fileId, routeFile.line)

  const hubModules = sortBy(
    (ir.modules ?? []).filter((module) => module.kind === 'source' || module.kind === 'mixed'),
    (module) => -(module.dependedOnBy?.length ?? 0),
  ).slice(0, 3)
  for (const module of hubModules) {
    if ((module.dependedOnBy?.length ?? 0) === 0) continue
    const file = files.find((candidate) => candidate.id === (module.files ?? [])[0])
    push(`核心模块 ${module.id}`, `被 ${module.dependedOnBy.length} 个模块依赖，是理解数据流的关键`, file?.id ?? module.id, 1)
  }

  const testFile = files.find((file) => file.kind === 'test')
  if (testFile !== undefined) push('测试用例', '测试即行为说明，比注释可靠', testFile.id, 1)

  const ci = (profile.ci ?? [])[0]
  if (ci?.path) push('持续集成', '了解合入门槛与发布流程', ci.path, 1)

  const container = (profile.containers ?? [])[0]
  if (container) push('容器与部署', '了解运行时形态与环境依赖', container, 1)

  const flow = (flows ?? [])[0]
  if (flow !== undefined) push(`关键流程：${flow.name}`, '把静态结构串成一条真实调用链', flow.entry.fileId, flow.entry.line, flow.evidence)

  return steps.map((step, index) => ({ ...step, step: index + 1 }))
}

/**
 * 汇总风险：图谱风险模块 + 扫描缺口 + 敏感文件 + TODO + 依赖环 + 未解析调用。
 * @param options.maxRisks 上限（默认 40）。
 * @returns `[{ id, severity, title, detail, evidence, source, verified }]`
 */
export function collectRisks(ir, profile, graph, flows, options = {}) {
  const maxRisks = Number.isFinite(options.maxRisks) ? Math.max(1, Math.trunc(options.maxRisks)) : 40
  const risks = []
  const signals = profile?.signals ?? ir?.profileSummary?.signals ?? {}
  const gaps = profile?.gaps ?? ir?.profileSummary?.gaps ?? []
  const sensitive = profile?.sensitive ?? ir?.profileSummary?.sensitive ?? []

  for (const entry of graph?.metrics?.riskModules ?? []) {
    risks.push({
      id: `module-risk:${entry.id}`,
      severity: entry.score >= 6 ? 'high' : entry.score >= 3 ? 'medium' : 'low',
      title: `模块 ${entry.id} 风险分 ${entry.score}/10`,
      detail: entry.reasons.join('；'),
      evidence: [`${entry.id}`],
      source: 'graph',
      verified: true,
    })
  }

  for (const cycle of (graph?.file?.cycles ?? []).slice(0, 10)) {
    risks.push({
      id: `cycle:${cycle[0]}`,
      severity: 'medium',
      title: `文件级循环依赖（${cycle.length} 个文件）`,
      detail: cycle.join(' → '),
      evidence: cycle.slice(0, 6),
      source: 'graph',
      verified: true,
    })
  }

  for (const gap of gaps) {
    risks.push({
      id: `gap:${gap.id ?? gap.title}`,
      severity: gap.priority === 'P0' ? 'critical' : gap.priority === 'P1' ? 'high' : gap.priority === 'P2' ? 'medium' : 'low',
      title: gap.title ?? String(gap.id ?? '工程缺口'),
      detail: gap.detail ?? '',
      evidence: gap.evidence ?? [],
      source: 'scan',
      verified: true,
    })
  }

  if (sensitive.length > 0) {
    risks.push({
      id: 'sensitive-files',
      severity: 'critical',
      title: `仓库内存在 ${sensitive.length} 个敏感文件`,
      detail: `这些文件可能包含凭据，本次分析未读取其内容：${sensitive.slice(0, 8).map((entry) => entry.path).join('、')}${sensitive.length > 8 ? ' 等' : ''}`,
      evidence: sensitive.slice(0, 8).map((entry) => entry.path),
      source: 'scan',
      verified: true,
    })
  }

  for (const suspect of (signals.secretSuspects ?? []).slice(0, 10)) {
    risks.push({
      id: `secret:${suspect.path}:${suspect.line}`,
      severity: 'high',
      title: '疑似硬编码凭据',
      detail: `${suspect.path}:${suspect.line} 处的 ${suspect.kind ?? '赋值'} 形似密钥（为避免二次泄漏，未记录取值）`,
      evidence: [`${suspect.path}:${suspect.line}`],
      source: 'scan',
      verified: true,
    })
  }

  const todos = signals.todos ?? []
  if (todos.length > 0) {
    const byKind = new Map()
    for (const todo of todos) byKind.set(todo.kind ?? 'todo', (byKind.get(todo.kind ?? 'todo') ?? 0) + 1)
    risks.push({
      id: 'todos',
      severity: todos.length >= 50 ? 'medium' : 'low',
      title: `代码中留有 ${todos.length} 条待办标记`,
      detail: [...byKind.entries()].map(([kind, count]) => `${kind}: ${count}`).join('，'),
      evidence: todos.slice(0, 8).map((todo) => `${todo.path}:${todo.line}`),
      source: 'scan',
      verified: true,
    })
  }

  const unresolved = ir?.stats?.unresolvedCalls ?? 0
  const callTotal = ir?.stats?.calls ?? 0
  if (callTotal >= 20 && unresolved / callTotal > 0.7) {
    risks.push({
      id: 'unresolved-calls',
      severity: 'medium',
      title: `静态可解析的调用比例偏低（${unresolved}/${callTotal} 未解析）`,
      detail: '常见于大量动态调用、反射或依赖注入的场景，调用链与依赖图可能不完整。',
      evidence: [],
      source: 'ir',
      verified: true,
    })
  }

  const lowConfidenceFlows = (flows ?? []).filter((flow) => flow.confidence === 'low')
  if ((flows ?? []).length > 0 && lowConfidenceFlows.length / flows.length > 0.6) {
    risks.push({
      id: 'weak-flows',
      severity: 'low',
      title: `${lowConfidenceFlows.length}/${flows.length} 条关键流程置信度偏低`,
      detail: '入口到实现的调用链存在断点，阅读时需要人工补齐。',
      evidence: lowConfidenceFlows.slice(0, 5).map((flow) => `${flow.entry.fileId}:${flow.entry.line}`),
      source: 'ir',
      verified: true,
    })
  }

  return risks
    .sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (a.id < b.id ? -1 : 1))
    .slice(0, maxRisks)
}

/* ------------------------------------------------------------------ *
 * 事实简报（喂给 LLM 的唯一素材）
 * ------------------------------------------------------------------ */

/**
 * 把 IR 压缩成一份"只能引用这些事实"的简报。
 * 体量受 `maxChars` 约束——这是控制 token 成本与幻觉面的主要手段。
 *
 * @returns 简报文本。
 */
export function buildFactBrief(ir, graph, flows, options = {}) {
  // 下限设得很小（200）而不是 2000：调用方给了 maxChars 就应当被尊重，
  // 否则"我只要一小段简报"会被静默放大十倍，token 预算形同虚设。
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(200, Math.trunc(options.maxChars)) : 14000
  if (ir === undefined || ir === null || typeof ir !== 'object') return '# 项目事实简报（唯一可用素材）\n（无可用 IR）'
  const profile = ir?.profileSummary ?? {}
  const lines = []

  lines.push(`# 项目事实简报（唯一可用素材）`)
  lines.push(`项目名：${ir?.name ?? '未知'}`)
  lines.push(`项目类型：${(profile.kinds ?? []).join('、') || '未识别'}`)
  lines.push(`技术栈：${(profile.ecosystems ?? []).map((entry) => `${entry.kind}(${entry.manifest})`).join('、') || '未识别'}`)
  lines.push(`规模：${ir?.stats?.files ?? 0} 文件 / ${ir?.stats?.loc ?? 0} 行 / ${ir?.stats?.symbols ?? 0} 符号 / ${ir?.stats?.routes ?? 0} 路由`)

  lines.push('', '## 入口点（path:line）')
  for (const entry of (profile.entrypoints ?? []).slice(0, 10)) {
    const path = toPosix(typeof entry === 'string' ? entry : entry?.path ?? '')
    const kind = typeof entry === 'string' ? 'entry' : entry?.kind ?? 'entry'
    if (path.length > 0) lines.push(`- ${path}:1 (${kind})`)
  }

  lines.push('', '## 模块（id | kind | 文件数 | 依赖数 | 被依赖数）')
  for (const module of (ir?.modules ?? []).slice(0, 30)) {
    lines.push(`- ${module.id} | ${module.kind} | ${module.files?.length ?? 0} | ${module.dependsOn?.length ?? 0} | ${module.dependedOnBy?.length ?? 0}`)
  }

  lines.push('', '## 代表性符号（id@line | kind | 导出 | 扇入）')
  const notable = sortBy(ir?.symbols ?? [], (symbol) => -(symbol.fanIn ?? 0)).slice(0, 40)
  for (const symbol of notable) {
    lines.push(`- ${symbol.fileId}#${symbol.name}@${symbol.line} | ${symbol.kind} | ${symbol.exported ? 'exported' : 'internal'} | fanIn=${symbol.fanIn ?? 0}`)
  }

  lines.push('', '## 路由（method path | 文件:行 | 框架）')
  for (const route of (ir?.routes ?? []).slice(0, 30)) {
    lines.push(`- ${route.method} ${route.path} | ${route.fileId}:${route.line} | ${route.framework}`)
  }

  lines.push('', '## 关键流程（名称 | 置信度 | 步骤证据）')
  for (const flow of (flows ?? []).slice(0, 10)) {
    lines.push(`- ${flow.name} | ${flow.confidence} | ${(flow.evidence ?? []).slice(0, 6).join(' ')}`)
  }

  lines.push('', '## 高风险模块')
  for (const entry of (graph?.metrics?.riskModules ?? []).slice(0, 10)) {
    lines.push(`- ${entry.id} | 分数 ${entry.score} | ${entry.reasons.join('；')}`)
  }

  lines.push('', '## 已知缺口')
  for (const gap of (profile.gaps ?? []).slice(0, 15)) {
    lines.push(`- [${gap.priority}] ${gap.title} | 证据：${(gap.evidence ?? []).slice(0, 3).join(' ')}`)
  }

  const text = lines.join('\n')
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 40)}\n（简报已截断）`
}

/** LLM 被要求返回的结构（同时也是校验的输入形状）。 */
export const NARRATIVE_JSON_SHAPE = `{
  "projectSummary": { "text": "一段话说明项目做什么", "citations": [{ "path": "相对路径", "line": 12, "symbol": "可选符号名" }] },
  "architecture":  [{ "text": "架构要点", "citations": [{ "path": "相对路径", "line": 1 }] }],
  "modules":       [{ "module": "模块id", "text": "该模块职责", "citations": [{ "path": "相对路径", "line": 1 }] }],
  "risks":         [{ "text": "风险说明", "citations": [{ "path": "相对路径", "line": 1 }] }],
  "readingOrder":  [{ "target": "先读什么", "why": "为什么", "citations": [{ "path": "相对路径", "line": 1 }] }]
}`

/**
 * 调 LLM 生成叙事，并**逐条验证**。
 *
 * 任何一步失败都返回 `used: false` 的降级结果——调用方据此产出纯确定性报告。
 *
 * @param llm `lib/llm.js` 的客户端。
 * @param validator `lib/validate.js` 的验证器。
 * @returns `{ used, reason, provider, model, narratives, validation, elapsedMs }`
 */
export async function generateNarratives(input) {
  const { ir, graph, flows, llm, validator, options = {} } = input
  const started = Date.now()
  const skipped = (reason) => ({
    used: false,
    reason,
    provider: null,
    model: null,
    narratives: emptyNarratives(),
    validation: { claims: 0, kept: 0, dropped: 0 },
    elapsedMs: Date.now() - started,
  })

  if (llm === undefined || llm === null) return skipped('未提供 LLM 客户端')
  if (validator === undefined || validator === null) return skipped('未提供验证器（没有验证器就不允许生成叙事）')
  const status = typeof llm.describe === 'function' ? llm.describe() : { available: false, reason: '未知' }
  if (status.available !== true) return skipped(status.reason ?? 'LLM 不可用')

  const brief = buildFactBrief(ir, graph, flows, options)
  const system = [
    '你是资深软件工程师，正在为刚接手项目的新同事写入门说明。',
    '硬性规则：',
    '1. 只能使用用户给出的"项目事实简报"中的信息，禁止补充任何简报之外的猜测；',
    '2. 每一条断言都必须带 citations，citations 里的 path 必须是简报中出现过的路径，line 必须是该路径中真实存在的行号；',
    '3. 如果信息不足以回答，就少写几条，禁止编造；',
    '4. 只输出 JSON，不要任何解释性文字或 Markdown 代码围栏。',
  ].join('\n')
  const prompt = [
    brief,
    '',
    '请严格按以下 JSON 结构输出（字段可少不可多，数组可为空）：',
    NARRATIVE_JSON_SHAPE,
  ].join('\n')

  let response
  try {
    response = await llm.complete({ system, prompt, maxTokens: options.maxTokens, signal: options.signal })
  } catch (error) {
    const code = error?.code ?? LLM_ERROR.FAILED
    return skipped(`模型调用失败（${code}）：${clip(error instanceof Error ? error.message : String(error), 200)}`)
  }

  const parsed = extractJson(response.text)
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return skipped('模型输出不是可解析的 JSON，已丢弃本次叙事')
  }

  const narratives = emptyNarratives()
  const validation = { claims: 0, kept: 0, dropped: 0, citationDropRate: 0 }

  const merge = (result) => {
    validation.claims += result.report.claims
    validation.kept += result.report.kept
    validation.dropped += result.report.dropped
  }

  if (parsed.projectSummary !== undefined && parsed.projectSummary !== null) {
    const result = validator.checkClaims([normalizeClaim(parsed.projectSummary)])
    merge(result)
    if (result.kept.length > 0) narratives.projectSummary = result.kept[0]
  }
  for (const field of ['architecture', 'risks']) {
    const raw = Array.isArray(parsed[field]) ? parsed[field] : []
    if (raw.length === 0) continue
    const result = validator.checkClaims(raw.slice(0, 12).map(normalizeClaim))
    merge(result)
    narratives[field] = result.kept
  }
  if (Array.isArray(parsed.modules) && parsed.modules.length > 0) {
    // 逐条校验，让 module 名与通过校验的断言严格对齐。
    // （整体批量校验后按下标回填是错的：被丢弃的断言会让后续下标全部错位。）
    const keptModules = []
    for (const raw of parsed.modules.slice(0, 20)) {
      const result = validator.checkClaims([normalizeClaim(raw)])
      merge(result)
      if (result.kept.length > 0) keptModules.push({ module: clip(String(raw?.module ?? ''), 120), ...result.kept[0] })
    }
    narratives.modules = keptModules
  }
  if (Array.isArray(parsed.readingOrder) && parsed.readingOrder.length > 0) {
    const kept = []
    for (const entry of parsed.readingOrder.slice(0, 12)) {
      const citations = Array.isArray(entry?.citations) ? entry.citations : []
      const valid = citations.filter((citation) => validator.checkCitation(citation).ok)
      validation.claims += 1
      if (valid.length === 0) {
        validation.dropped += 1
        continue
      }
      validation.kept += 1
      kept.push({
        target: clip(String(entry?.target ?? ''), 120),
        why: clip(String(entry?.why ?? ''), 300),
        citations: valid.map((citation) => ({
          path: toPosix(citation.path),
          line: Number.isFinite(citation.line) ? Math.trunc(citation.line) : undefined,
          symbol: citation.symbol ?? undefined,
          text: `${toPosix(citation.path)}${Number.isFinite(citation.line) ? `:${Math.trunc(citation.line)}` : ''}`,
        })),
      })
    }
    narratives.readingOrder = kept
  }

  validation.citationDropRate = validation.claims === 0 ? 0 : validation.dropped / validation.claims

  return {
    used: true,
    reason: null,
    provider: response.provider,
    model: response.model,
    narratives,
    validation,
    elapsedMs: Date.now() - started,
  }
}

/** 空叙事结构（LLM 关闭时的占位，报告层据此走确定性路径）。 */
export function emptyNarratives() {
  return { projectSummary: null, architecture: [], modules: [], risks: [], readingOrder: [] }
}

/** 把模型返回的一条断言规整成验证器认识的形状。 */
function normalizeClaim(raw) {
  if (typeof raw === 'string') return { text: raw, citations: [] }
  return {
    text: String(raw?.text ?? ''),
    citations: Array.isArray(raw?.citations) ? raw.citations : [],
    confidence: raw?.confidence,
  }
}

/**
 * 组装报告层需要的 `insights`。
 * LLM 关闭/失败时同样返回完整结构（叙事为空），报告因此不必区分两条路径。
 */
export async function buildInsights(input) {
  const { ir, profile, graph, flows, llm, validator, options = {} } = input
  const readingOrder = buildReadingOrder(ir, graph, flows)
  const risks = collectRisks(ir, profile, graph, flows, options)
  const narratives = options.withLlm === true
    ? await generateNarratives({ ir, graph, flows, llm, validator, options })
    : { used: false, reason: '未开启 LLM（withLlm=false）', provider: null, model: null, narratives: emptyNarratives(), validation: { claims: 0, kept: 0, dropped: 0 }, elapsedMs: 0 }
  return {
    readingOrder: narratives.narratives?.readingOrder?.length > 0 ? narratives.narratives.readingOrder : readingOrder,
    readingOrderDeterministic: readingOrder,
    risks,
    narratives: narratives.narratives,
    llm: { used: narratives.used, reason: narratives.reason, provider: narratives.provider, model: narratives.model, elapsedMs: narratives.elapsedMs },
    validation: narratives.validation,
  }
}
