/**
 * 洞察层与 LLM 叙事测试。
 *
 * 重点不是"能不能生成文字"，而是**验证器的约束真的生效**：
 *   - LLM 不可用/关闭时，报告必须仍能拿到完整的确定性洞察；
 *   - LLM 编造的引用必须被丢弃（不是打问号，是丢掉）；
 *   - 丢弃发生时，`modules[].module` 与 claim 的对齐不能错位（下标回填的经典坑）。
 *
 * @module test/insights.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIR } from '../lib/ir.js'
import { buildGraphs } from '../lib/graph.js'
import { detectFlows } from '../lib/flows.js'
import { createValidator } from '../lib/validate.js'
import { buildFactBrief, buildInsights, buildReadingOrder, collectRisks, generateNarratives } from '../lib/insights.js'

/* ------------------------------------------------------------------ *
 * 合成项目
 * ------------------------------------------------------------------ */

function makeProject() {
  const files = [
    {
      id: 'README.md',
      language: 'markdown',
      loc: 20,
      parsed: { symbols: [], imports: [], calls: [], routes: [], exports: [], todos: [] },
    },
    {
      id: 'src/server.ts',
      language: 'typescript',
      loc: 30,
      parsed: {
        symbols: [
          { name: 'bootstrap', kind: 'function', line: 3, endLine: 10, exported: true },
          { name: 'handleOrder', kind: 'function', line: 12, endLine: 20, exported: false },
        ],
        imports: [{ specifier: './orders', names: ['createOrder'], line: 1 }],
        calls: [{ calleeName: 'createOrder', line: 14, fromSymbolName: 'handleOrder' }],
        routes: [{ method: 'post', path: '/orders', line: 12, handlerName: 'handleOrder', framework: 'express' }],
        exports: ['bootstrap'],
        todos: [{ line: 9, text: 'TODO: 加限流', kind: 'todo' }],
      },
    },
    {
      id: 'src/orders.ts',
      language: 'typescript',
      loc: 25,
      parsed: {
        symbols: [{ name: 'createOrder', kind: 'function', line: 5, endLine: 18, exported: true }],
        imports: [],
        calls: [],
        routes: [],
        exports: ['createOrder'],
        todos: [],
      },
    },
    {
      id: 'test/server.test.ts',
      language: 'typescript',
      loc: 12,
      parsed: {
        symbols: [{ name: 'orderSpec', kind: 'function', line: 4, endLine: 10 }],
        imports: [],
        calls: [],
        routes: [],
        exports: [],
        todos: [],
      },
    },
  ]
  const ir = buildIR({
    root: '/demo',
    name: 'demo',
    files,
    profile: {
      name: 'demo',
      entrypoints: [{ path: 'src/server.ts', kind: 'main' }],
      ci: [{ id: 'github', path: '.github/workflows/ci.yml' }],
      containers: ['Dockerfile'],
      gaps: [{ id: 'no-ci', priority: 'P2', title: '缺少 CI', detail: '未发现 CI 配置', evidence: ['.github/workflows/ci.yml'] }],
      sensitive: [{ path: '.env', kind: 'dotenv', reason: '可能含凭据' }],
      signals: {
        todoCount: 1,
        todos: [{ path: 'src/server.ts', line: 9, text: 'TODO: 加限流', kind: 'todo' }],
        debugStatementCount: 0,
        secretSuspects: [{ path: 'src/config.ts', line: 4, kind: 'hardcoded-key' }],
        largeFiles: [],
        generatedFiles: [],
      },
      ecosystems: [{ kind: 'node', manifest: 'package.json', name: 'demo', version: '1.0.0', scripts: {} }],
    },
  })
  ir.graph = buildGraphs(ir)
  const flows = detectFlows(ir)
  return { ir, graph: ir.graph, flows }
}

/** 假 LLM 客户端：只实现插件真正用到的两个方法。 */
function fakeLlm(text, options = {}) {
  return {
    describe: () => ({ available: options.available !== false, provider: 'p', model: 'm', reason: null }),
    complete: async () => {
      if (options.throwError === true) throw new Error('模拟上游失败')
      return { text, provider: 'p', model: 'm', usage: null, elapsedMs: 1 }
    },
  }
}

/* ------------------------------------------------------------------ *
 * 确定性洞察
 * ------------------------------------------------------------------ */

test('insights：阅读顺序给出带证据的步骤，空项目不抛错', () => {
  const { ir, graph, flows } = makeProject()
  const order = buildReadingOrder(ir, graph, flows)
  assert.ok(order.length >= 3)
  for (const step of order) {
    assert.ok(typeof step.target === 'string' && step.target.length > 0)
    assert.ok(typeof step.why === 'string' && step.why.length > 0)
    assert.ok(typeof step.path === 'string' && step.path.length > 0)
    assert.ok(step.evidence.length > 0)
  }
  assert.deepEqual(buildReadingOrder(undefined, undefined, undefined), [])
  assert.deepEqual(buildReadingOrder({ files: [], symbols: [], modules: [], routes: [] }, {}, []), [])
})

test('insights：风险汇总按严重度排序，且绝不输出疑似密钥的取值', () => {
  const { ir, graph, flows } = makeProject()
  const risks = collectRisks(ir, ir.profileSummary, graph, flows)
  assert.ok(risks.length >= 3)
  const severities = risks.map((risk) => risk.severity)
  const order = { critical: 0, high: 1, medium: 2, low: 3 }
  for (let index = 1; index < severities.length; index += 1) {
    assert.ok(order[severities[index - 1]] <= order[severities[index]], '风险必须按严重度排序')
  }
  assert.ok(risks.some((risk) => risk.id === 'sensitive-files' && risk.severity === 'critical'))
  assert.ok(risks.some((risk) => risk.id.startsWith('secret:')))
  // 凭据类风险只能描述"位置 + 判定依据"，绝不能出现任何取值
  const secretRisk = risks.find((risk) => risk.id.startsWith('secret:'))
  assert.match(secretRisk.detail, /未记录取值|不输出/, '必须说明取值未被记录')
  const prose = risks.map((risk) => `${risk.title} ${risk.detail}`).join('\n')
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(prose), '不得出现形似密钥的取值')
  assert.ok(!/password\s*[:=]\s*\S+/i.test(prose), '不得出现密码赋值')
  assert.equal(collectRisks(ir, null, graph, flows, { maxRisks: 2 }).length, 2)
})

test('insights：事实简报受长度约束且包含关键事实', () => {
  const { ir, graph, flows } = makeProject()
  const brief = buildFactBrief(ir, graph, flows, { maxChars: 2000 })
  assert.ok(brief.length <= 2000)
  assert.match(brief, /项目事实简报/)
  assert.match(brief, /src\/server\.ts#handleOrder@12/)
  assert.match(brief, /POST \/orders/)

  const tiny = buildFactBrief(ir, graph, flows, { maxChars: 600 })
  assert.ok(tiny.length <= 600)
})

/* ------------------------------------------------------------------ *
 * LLM 叙事的降级路径
 * ------------------------------------------------------------------ */

test('insights：没有 LLM 客户端 / 没有验证器时明确降级', async () => {
  const { ir, graph, flows } = makeProject()
  const validator = createValidator(ir)

  const noLlm = await generateNarratives({ ir, graph, flows, llm: undefined, validator })
  assert.equal(noLlm.used, false)
  assert.match(noLlm.reason, /未提供 LLM/)
  assert.deepEqual(noLlm.narratives.architecture, [])

  const noValidator = await generateNarratives({ ir, graph, flows, llm: fakeLlm('{}'), validator: undefined })
  assert.equal(noValidator.used, false)
  assert.match(noValidator.reason, /验证器/)
})

test('insights：LLM 不可用时不出网', async () => {
  const { ir, graph, flows } = makeProject()
  const result = await generateNarratives({
    ir,
    graph,
    flows,
    llm: fakeLlm('{}', { available: false }),
    validator: createValidator(ir),
  })
  assert.equal(result.used, false)
})

test('insights：模型输出不是 JSON 时丢弃全部叙事', async () => {
  const { ir, graph, flows } = makeProject()
  const result = await generateNarratives({
    ir, graph, flows, llm: fakeLlm('我觉得这个项目挺好的，没有 JSON。'), validator: createValidator(ir),
  })
  assert.equal(result.used, false)
  assert.match(result.reason, /JSON/)
})

test('insights：模型调用抛错时降级为确定性报告', async () => {
  const { ir, graph, flows } = makeProject()
  const result = await generateNarratives({
    ir, graph, flows, llm: fakeLlm('', { throwError: true }), validator: createValidator(ir),
  })
  assert.equal(result.used, false)
  assert.match(result.reason, /模型调用失败/)
})

test('insights：引用有效的断言被保留，引用错误的断言被丢弃', async () => {
  const { ir, graph, flows } = makeProject()
  const payload = JSON.stringify({
    projectSummary: { text: '这是订单服务', citations: [{ path: 'src/server.ts', line: 3 }] },
    architecture: [
      { text: '入口在 bootstrap', citations: [{ path: 'src/server.ts', line: 3 }] },
      { text: '凭空捏造的一层', citations: [{ path: 'src/ghost.ts', line: 1 }] },
      { text: '没有引用的断言', citations: [] },
    ],
    modules: [
      { module: 'src', text: '核心业务在 src', citations: [{ path: 'src/orders.ts', line: 5 }] },
      { module: 'ghost-module', text: '这个模块不存在', citations: [{ path: 'src/nope.ts', line: 2 }] },
      { module: 'test', text: '测试在 test 目录', citations: [{ path: 'test/server.test.ts', line: 4 }] },
    ],
    risks: [{ text: '缺少限流', citations: [{ path: 'src/server.ts', line: 9 }] }],
  })
  const result = await generateNarratives({
    ir, graph, flows, llm: fakeLlm(payload), validator: createValidator(ir),
  })

  assert.equal(result.used, true)
  assert.equal(result.narratives.projectSummary.citations[0].text, 'src/server.ts:3')
  assert.equal(result.narratives.architecture.length, 1, '只有带有效引用的架构断言应保留')
  assert.equal(result.narratives.risks.length, 1)
  assert.ok(result.validation.dropped >= 3, `应丢弃无效断言，实际 ${result.validation.dropped}`)

  // 关键回归：中间那条被丢弃后，module 名不能错位
  assert.deepEqual(result.narratives.modules.map((entry) => entry.module), ['src', 'test'])
  assert.match(result.narratives.modules[0].text, /核心业务/)
  assert.match(result.narratives.modules[1].text, /测试/)
})

test('insights：模型输出带代码围栏与尾逗号也能解析', async () => {
  const { ir, graph, flows } = makeProject()
  const payload = ['```json', JSON.stringify({
    architecture: [{ text: '入口', citations: [{ path: 'src/server.ts', line: 3 }] }],
  }).replace(/}$/, ',}'), '```'].join('\n')
  const result = await generateNarratives({ ir, graph, flows, llm: fakeLlm(payload), validator: createValidator(ir) })
  assert.equal(result.used, true)
  assert.equal(result.narratives.architecture.length, 1)
})

test('insights：LLM 的阅读顺序同样必须过验证器', async () => {
  const { ir, graph, flows } = makeProject()
  const payload = JSON.stringify({
    readingOrder: [
      { target: '入口', why: '先看入口', citations: [{ path: 'src/server.ts', line: 3 }] },
      { target: '幽灵', why: '不存在的文件', citations: [{ path: 'src/ghost.ts', line: 1 }] },
      { target: '没引用', why: '空引用', citations: [] },
    ],
  })
  const result = await generateNarratives({ ir, graph, flows, llm: fakeLlm(payload), validator: createValidator(ir) })
  assert.equal(result.narratives.readingOrder.length, 1)
  assert.equal(result.narratives.readingOrder[0].target, '入口')
})

/* ------------------------------------------------------------------ *
 * buildInsights 组装
 * ------------------------------------------------------------------ */

test('insights：withLlm=false 时给出完整确定性洞察，且不调用模型', async () => {
  const { ir, graph, flows } = makeProject()
  let called = 0
  const llm = { describe: () => ({ available: true, provider: 'p', model: 'm' }), complete: async () => { called += 1; return { text: '{}' } } }

  const insights = await buildInsights({ ir, profile: ir.profileSummary, graph, flows, llm, validator: createValidator(ir), options: { withLlm: false } })
  assert.equal(called, 0, '默认不得调用 LLM')
  assert.equal(insights.llm.used, false)
  assert.ok(insights.risks.length > 0)
  assert.ok(insights.readingOrder.length > 0, '确定性阅读顺序必须存在')
  assert.deepEqual(insights.narratives.architecture, [])
})

test('insights：withLlm=true 且有可用模型时，叙事覆盖阅读顺序', async () => {
  const { ir, graph, flows } = makeProject()
  const payload = JSON.stringify({
    readingOrder: [{ target: '先读入口', why: '最快建立全局观', citations: [{ path: 'src/server.ts', line: 3 }] }],
  })
  const insights = await buildInsights({
    ir, profile: ir.profileSummary, graph, flows, llm: fakeLlm(payload), validator: createValidator(ir), options: { withLlm: true },
  })
  assert.equal(insights.llm.used, true)
  assert.equal(insights.readingOrder[0].target, '先读入口')
  assert.ok(insights.readingOrderDeterministic.length > 0, '确定性顺序仍要保留，便于比对')
})

test('insights：LLM 返回空叙事时回退到确定性阅读顺序', async () => {
  const { ir, graph, flows } = makeProject()
  const insights = await buildInsights({
    ir, profile: ir.profileSummary, graph, flows, llm: fakeLlm('{}'), validator: createValidator(ir), options: { withLlm: true },
  })
  assert.equal(insights.readingOrder.length, insights.readingOrderDeterministic.length)
})
