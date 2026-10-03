/**
 * 端到端验收测试：在临时目录里造一个小型"真实项目"，跑完整流水线。
 *
 * 覆盖范围（这是"能不能交付"的判定依据，而不是单个函数的正确性）：
 *   扫描 → 解析 → IR → 图谱 → 流程 → 报告 → 索引 → 问答 → 增量更新，
 * 以及两条容易退化的边界：
 *   · 工具层返回的每个值都必须是无损 JSON（宿主会校验，失败即 INVALID_TOOL_OUTPUT）；
 *   · 本工具自己的产物（`.project-compass/`、`docs/project-compass/`）**不得**被下一轮分析吃进去。
 *
 * @module test/e2e.test
 */

import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { scanProject } from '../lib/scan.js'
import { analyzeProject } from '../lib/analyze.js'
import { buildGraphs } from '../lib/graph.js'
import { detectFlows } from '../lib/flows.js'
import { createToolDefinitions } from '../lib/tools.js'
import { generateReports, buildSearchIndex, askQuestion } from '../lib/pipeline.js'
import { createValidator } from '../lib/validate.js'
import { saveIR, saveProfile, saveState } from '../lib/project.js'
import { IR_SCHEMA_VERSION, validateIR } from '../lib/ir.js'
import { reportPaths, irFile, indexFile } from '../lib/paths.js'
import { readJsonFile } from '../lib/store.js'

/* ------------------------------------------------------------------ *
 * 临时项目 fixture
 * ------------------------------------------------------------------ */

const SERVER_JS = `import express from 'express'
import { createOrder, findOrder } from './service.js'
import { logger } from './logger.js'

const app = express()

// 创建订单：先校验再落库
app.post('/api/orders', async (req, res) => {
  const order = await createOrder(req.body)
  logger.info('order created')
  res.json(order)
})

app.get('/api/orders/:id', async (req, res) => {
  const order = await findOrder(req.params.id)
  if (!order) {
    res.status(404).json({ error: 'not found' })
    return
  }
  res.json(order)
})

export function startServer(port) {
  return app.listen(port)
}
`

const SERVICE_JS = `import { insertOrder, selectOrder } from './repository.js'
import { validateOrder } from './validation.js'

/** 创建订单并返回持久化结果 */
export async function createOrder(input) {
  const clean = validateOrder(input)
  const saved = await insertOrder(clean)
  return { id: saved.id, status: 'created' }
}

/** 按 id 查询订单 */
export async function findOrder(id) {
  return selectOrder(id)
}
`

const VALIDATION_JS = `export function validateOrder(input) {
  if (!input || !input.items) throw new Error('订单缺少商品')
  return { items: input.items, total: input.items.length }
}
`

const REPOSITORY_JS = `export async function insertOrder(order) {
  return { id: 'order-1', ...order }
}

export async function selectOrder(id) {
  return { id, items: [] }
}
`

const LOGGER_JS = `export const logger = {
  info(message) {
    console.log(message)
  },
}
`

const TEST_JS = `import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrder } from '../src/service.js'

test('createOrder 返回 created', async () => {
  const order = await createOrder({ items: [1, 2] })
  assert.equal(order.status, 'created')
})
`

const PACKAGE_JSON = {
  name: 'demo-orders',
  version: '1.0.0',
  type: 'module',
  main: 'src/server.js',
  exports: { '.': './src/server.js', './validation': './src/validation.js' },
  scripts: { test: 'node --test', build: 'node --version', lint: 'eslint .', start: 'node src/server.js' },
  dependencies: { express: '^4.19.0' },
  devDependencies: {},
}

const README_MD = `# demo-orders

订单服务示例：提供订单创建与查询接口。

## 运行

\`\`\`bash
npm install
npm start
\`\`\`
`

const ENV_FILE = `DATABASE_URL=postgres://user:supersecretpassword@localhost:5432/orders
API_TOKEN=sk-live-abcdefghijklmnopqrstuvwxyz012345
`

const DOCKERFILE = `FROM node:20-alpine
WORKDIR /app
COPY . .
CMD ["node", "src/server.js"]
`

const CI_YML = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node --test
`

/** 建一个临时项目；返回根路径与清理函数。 */
async function makeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compass-e2e-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await mkdir(path.join(root, 'test'), { recursive: true })
  await mkdir(path.join(root, '.github', 'workflows'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify(PACKAGE_JSON, null, 2))
  await writeFile(path.join(root, 'README.md'), README_MD)
  await writeFile(path.join(root, '.env'), ENV_FILE)
  await writeFile(path.join(root, 'Dockerfile'), DOCKERFILE)
  await writeFile(path.join(root, '.github', 'workflows', 'ci.yml'), CI_YML)
  await writeFile(path.join(root, 'src', 'server.js'), SERVER_JS)
  await writeFile(path.join(root, 'src', 'service.js'), SERVICE_JS)
  await writeFile(path.join(root, 'src', 'validation.js'), VALIDATION_JS)
  await writeFile(path.join(root, 'src', 'repository.js'), REPOSITORY_JS)
  await writeFile(path.join(root, 'src', 'logger.js'), LOGGER_JS)
  await writeFile(path.join(root, 'test', 'service.test.js'), TEST_JS)
  const cleaned = await readFile(path.join(root, 'test', 'service.test.js'), 'utf8')
  assert.ok(cleaned.includes('createOrder'))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/* ------------------------------------------------------------------ *
 * 1. 扫描
 * ------------------------------------------------------------------ */

test('e2e：扫描识别技术栈、命令、测试框架与敏感文件（不读取其内容）', async () => {
  const { root, cleanup } = await makeProject()
  try {
    const profile = await scanProject(root)

    assert.ok(profile.sources.length >= 8, `应纳入分析的文件不少于 8 个，实际 ${profile.sources.length}`)
    assert.deepEqual(validateProfileShape(profile), [])

    const sourcePaths = profile.sources.map((source) => source.path)
    assert.ok(sourcePaths.includes('src/server.js'))
    const dockerfile = profile.sources.find((source) => source.path === 'Dockerfile')
    assert.ok(dockerfile !== undefined, 'Dockerfile 是文本文件，应纳入分析')
    assert.equal(dockerfile.binary, false)

    const ecosystem = profile.ecosystems.find((entry) => entry.kind === 'node')
    assert.ok(ecosystem !== undefined, '应识别出 node 生态')
    assert.equal(ecosystem.scripts.test, 'node --test')

    const presets = profile.commands.map((command) => command.preset)
    assert.ok(presets.includes('test'), '应识别出 test 命令')
    assert.ok(presets.includes('build'), '应识别出 build 命令')

    const sensitive = profile.sensitive.map((entry) => entry.path)
    assert.ok(sensitive.includes('.env'), '应把 .env 登记为敏感文件')

    // 安全红线：敏感文件的内容不得出现在任何输出里
    const serialized = JSON.stringify(profile)
    assert.ok(!serialized.includes('supersecretpassword'), '敏感文件内容泄漏进画像')
    assert.ok(!serialized.includes('sk-live-'), '疑似密钥内容泄漏进画像')

    assert.ok(profile.ci.some((entry) => entry.path.includes('.github/workflows')), '应识别出 CI 配置')
    assert.ok(profile.containers.some((entry) => entry.includes('Dockerfile')), '应识别出容器配置')
    assert.ok(profile.tests.testFileCount >= 1, '应识别出测试文件')
  } finally {
    await cleanup()
  }
})

/** Profile 的关键字段自检（形状退化时给出可读信息）。 */
function validateProfileShape(profile) {
  const problems = []
  if (!Array.isArray(profile.sources)) problems.push('sources 不是数组')
  if (!Array.isArray(profile.entrypoints)) problems.push('entrypoints 不是数组')
  if (!Array.isArray(profile.languages)) problems.push('languages 不是数组')
  if (!Array.isArray(profile.gaps)) problems.push('gaps 不是数组')
  if (profile.tests === undefined) problems.push('缺少 tests')
  if (profile.ignore === undefined) problems.push('缺少 ignore')
  for (const source of profile.sources ?? []) {
    if (typeof source.path !== 'string' || typeof source.binary !== 'boolean' || typeof source.sensitive !== 'boolean') {
      problems.push(`sources 条目字段不完整：${JSON.stringify(source)}`)
      break
    }
  }
  return problems
}

/* ------------------------------------------------------------------ *
 * 2. 解析 / IR / 图谱 / 流程
 * ------------------------------------------------------------------ */

test('e2e：解析出 IR、解析跨文件调用、识别 HTTP 路由与关键流程', async () => {
  const { root, cleanup } = await makeProject()
  try {
    const profile = await scanProject(root)
    const result = await analyzeProject(root, { profile })
    const ir = result.ir

    assert.equal(ir.schemaVersion, IR_SCHEMA_VERSION)
    assert.deepEqual(validateIR(ir), [])

    // 符号与路由
    const routePaths = ir.routes.map((route) => `${route.method} ${route.path}`).sort()
    assert.deepEqual(routePaths, ['GET /api/orders/:id', 'POST /api/orders'])
    for (const route of ir.routes) {
      assert.ok(route.handlerSymbolId !== null, `路由 ${route.id} 应绑定到处理器符号`)
    }

    // 跨文件调用绑定（server.js → service.js）
    const createOrderSymbol = ir.symbols.find((symbol) => symbol.name === 'createOrder' && symbol.fileId === 'src/service.js')
    assert.ok(createOrderSymbol !== undefined, '应解析出 createOrder')
    const inbound = ir.calls.filter((call) => call.toSymbolId === createOrderSymbol.id)
    assert.ok(inbound.some((call) => call.fileId === 'src/server.js'), 'server.js 对 createOrder 的调用应绑定成功')
    assert.ok(createOrderSymbol.fanIn >= 2, `createOrder 至少被 server 与测试调用，实际 fanIn=${createOrderSymbol.fanIn}`)

    // 外部依赖与未解析调用都不允许伪造绑定
    const expressImport = ir.imports.find((record) => record.specifier === 'express')
    assert.equal(expressImport.external, true)
    assert.equal(expressImport.packageName, 'express')
    for (const call of ir.calls) {
      if (call.resolution === 'unresolved') assert.equal(call.toSymbolId, null, '未解析调用不得有绑定目标')
    }

    // 图谱与风险
    const graph = buildGraphs(ir)
    assert.ok(graph.stats.moduleNodes >= 3, `模块数应 ≥3，实际 ${graph.stats.moduleNodes}`)
    assert.ok(graph.stats.fileEdges >= 3, `文件依赖边应 ≥3，实际 ${graph.stats.fileEdges}`)
    assert.ok(graph.metrics.entryReach['src/service.js'] === true, 'service.js 应从入口可达')

    // 流程：POST /api/orders 应能走到 repository
    const flows = detectFlows(ir)
    const createFlow = flows.find((flow) => flow.name === 'POST /api/orders')
    assert.ok(createFlow !== undefined, '应识别出 POST /api/orders 流程')
    assert.ok(createFlow.steps.length >= 3, `流程步骤应 ≥3，实际 ${createFlow.steps.length}`)
    const stepFiles = createFlow.steps.map((step) => step.fileId)
    assert.ok(stepFiles.includes('src/service.js'), '流程应展开到 service.js')
    assert.ok(createFlow.evidence.every((item) => /:\d+$/.test(item)), '流程证据必须是 path:line 形式')

    // 确定性：同样输入两次分析，IR 逐字节一致
    const again = await analyzeProject(root, { profile, force: true })
    assert.equal(JSON.stringify(again.ir.symbols), JSON.stringify(ir.symbols))
  } finally {
    await cleanup()
  }
})

test('e2e：机器状态目录自我忽略（避免用户的绝对路径被提交）', async () => {
  const { root, cleanup } = await makeProject()
  try {
    const profile = await scanProject(root)
    const { ir } = await analyzeProject(root, { profile })
    await saveProfile(root, profile)
    await saveIR(root, ir)
    await saveState(root, {})

    // 状态文件里确实记录了本机绝对路径——这正是"必须自我忽略"的原因
    const scan = await readJsonFile(path.join(root, '.project-compass', 'scan.json'), {})
    assert.equal(scan.root, root, '扫描快照会记录项目根的绝对路径')
    const irOnDisk = await readJsonFile(path.join(root, '.project-compass', 'ir.json'), {})
    assert.equal(irOnDisk.root, root, 'IR 同样记录绝对路径')

    const ignoreFile = path.join(root, '.project-compass', '.gitignore')
    const content = await readFile(ignoreFile, 'utf8')
    assert.match(content, /^\*$/m, '.project-compass/.gitignore 必须包含 * 以自我忽略')

    // 用户已经写过这个文件时不得覆盖
    await writeFile(ignoreFile, '# 用户自己写的\n!keep.json\n')
    await saveState(root, {})
    assert.match(await readFile(ignoreFile, 'utf8'), /!keep\.json/, '不得覆盖用户已有内容')
  } finally {
    await cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * 3. 报告 + 自反式膨胀防护
 * ------------------------------------------------------------------ */

test('e2e：生成 6 份报告，且报告产物不会被下一轮分析吃进去', async () => {
  const { root, cleanup } = await makeProject()
  try {
    const profile = await scanProject(root)
    const result = await analyzeProject(root, { profile })
    const generated = await generateReports(root, { ir: result.ir, profile, graph: result.graph, flows: result.flows })

    const paths = reportPaths(root)
    for (const key of ['onboarding', 'architecture', 'moduleMap', 'keyFlows', 'gettingStarted']) {
      const text = await readFile(paths[key], 'utf8')
      assert.ok(text.length > 200, `${key} 内容过短`)
      assert.match(text, /生成时间/, `${key} 缺少元信息块`)
    }
    const json = await readJsonFile(paths.json, undefined)
    assert.ok(json !== undefined && typeof json === 'object', 'project-compass.json 应可解析')
    assert.equal(json.tool.name, 'dsh-project-compass')

    const onboarding = await readFile(paths.onboarding, 'utf8')
    assert.match(onboarding, /按角色阅读路线|阅读路线/, 'ONBOARDING 应包含按角色阅读路线')
    assert.match(onboarding, /```mermaid/, 'ONBOARDING 应包含 Mermaid 图')
    assert.match(onboarding, /src\/server\.js:\d+/, 'ONBOARDING 应给出带行号的证据')
    assert.ok(generated.meta.counts.files >= 8)

    // 关键：重新扫描时，本工具自己的产物必须被排除
    const rescan = await scanProject(root)
    const rescanPaths = rescan.sources.map((source) => source.path)
    assert.ok(!rescanPaths.some((entry) => entry.startsWith('.project-compass')), '状态目录不得被纳入分析')
    assert.ok(!rescanPaths.some((entry) => entry.startsWith('docs/project-compass')), '报告产物不得被纳入分析')

    const second = await analyzeProject(root, { profile: rescan })
    assert.equal(second.ir.stats.files, result.ir.stats.files, '重跑分析的文件集合不应因产物而增长')
  } finally {
    await cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * 4. 索引 + 问答
 * ------------------------------------------------------------------ */

test('e2e：索引可用于带引用的问答，且引用必须指向真实文件与行号', async () => {
  const { root, cleanup } = await makeProject()
  try {
    const profile = await scanProject(root)
    const result = await analyzeProject(root, { profile })
    const built = await buildSearchIndex(root, result.ir, {})
    assert.ok(built.stats.chunks > 0, '索引应有分块')
    assert.ok(await readJsonFile(indexFile(root), undefined) !== undefined, '索引应落盘')

    const answer = await askQuestion(root, result.ir, 'createOrder 创建订单')
    assert.ok(typeof answer.answer === 'string' && answer.answer.length > 0, '应给出答案')
    assert.ok(answer.citations.length > 0, '应给出引用')
    assert.ok(['extractive', 'hybrid', 'llm'].includes(answer.mode))
    assert.ok(['high', 'medium', 'low'].includes(answer.confidence))

    const fileIds = new Set(result.ir.files.map((file) => file.id))
    for (const citation of answer.citations) {
      assert.ok(fileIds.has(citation.path), `引用指向不存在的文件：${citation.path}`)
      if (citation.line !== null && citation.line !== undefined) {
        const file = result.ir.files.find((candidate) => candidate.id === citation.path)
        assert.ok(citation.line >= 1 && citation.line <= Math.max(1, file.loc), `引用行号越界：${citation.text}`)
      }
    }
    assert.ok(answer.citations.some((citation) => citation.path.startsWith('src/')), '应命中源码文件')

    // 无关问题不得被包装成"结论"：置信度必须低，且明确说明证据不足
    const unrelated = await askQuestion(root, result.ir, '量子纠缠与光合作用的耦合机制')
    const disclaimer = /未在项目索引中找到相关证据|证据不足/.test(unrelated.answer) ||
      (unrelated.notes ?? []).some((note) => /证据不足|未命中/.test(note))
    assert.ok(
      unrelated.confidence === 'low',
      `无关问题的置信度应为 low，实际 ${unrelated.confidence}；答案：${unrelated.answer.slice(0, 200)}`,
    )
    assert.ok(disclaimer, `无关问题必须显式说明证据不足；答案：${unrelated.answer.slice(0, 200)}`)
  } finally {
    await cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * 5. 增量更新
 * ------------------------------------------------------------------ */

test('e2e：增量分析只重算变更文件，并反映到 IR', async () => {
  const { root, cleanup } = await makeProject()
  try {
    // 每轮都重新扫描，与工具层的行为一致：文件增删必须反映到分析范围里
    const run = async (extra = {}) => {
      const profile = await scanProject(root)
      return analyzeProject(root, { profile, ...extra })
    }

    const first = await run()
    assert.ok(first.stats.cacheMisses >= 8, '首轮应全部未命中缓存')
    const symbolsBefore = first.ir.symbols.length

    // 未改动的重跑：应全部命中缓存
    const second = await run()
    assert.equal(second.stats.cacheMisses, 0, '未改动时不应重新解析任何文件')
    assert.ok(second.stats.cacheHits >= 8, '应大量命中缓存')

    // 改一个文件：新增一个导出符号
    await writeFile(
      path.join(root, 'src', 'service.js'),
      `${SERVICE_JS}\n/** 取消订单 */\nexport async function cancelOrder(id) {\n  return { id, status: 'cancelled' }\n}\n`,
    )
    const third = await run()
    assert.equal(third.stats.cacheMisses, 1, '只应重新解析被修改的那一个文件')
    assert.ok(
      third.ir.symbols.some((symbol) => symbol.name === 'cancelOrder'),
      '新增符号应出现在 IR 中',
    )
    assert.equal(third.ir.symbols.length, symbolsBefore + 1)

    // 删除一个文件：IR 不应残留
    await rm(path.join(root, 'src', 'logger.js'))
    const fourth = await run()
    assert.ok(!fourth.ir.files.some((file) => file.id === 'src/logger.js'), '已删除文件不应残留在 IR')
    assert.ok(!fourth.ir.modules.some((module) => module.id === 'src' && module.files.includes('src/logger.js')))
  } finally {
    await cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * 6. 工具层契约
 * ------------------------------------------------------------------ */

test('e2e：工具层返回值是无损 JSON，且六步流程端到端可用', async () => {
  const { root, cleanup } = await makeProject()
  try {
    const definitions = createToolDefinitions({ logger: { info() {}, warn() {}, debug() {} } }, {})
    assert.deepEqual(
      definitions.map((definition) => definition.name),
      ['project_compass_scan', 'project_compass_analyze', 'project_compass_report', 'project_compass_ask', 'project_compass_update', 'project_compass_status'],
    )

    const exec = { agent: { id: 'e2e', session: { header: { cwd: root } } } }
    const byName = new Map(definitions.map((definition) => [definition.name, definition]))
    const call = async (suffix, args = {}) => {
      const definition = byName.get(`project_compass_${suffix}`)
      const value = await definition.execute({ projectPath: root, ...args }, exec)
      // 宿主会校验返回值：必须能无损序列化，且不含 undefined/NaN
      const serialized = JSON.stringify(value)
      assert.ok(serialized !== undefined && serialized.length > 0, `${suffix} 返回值无法序列化`)
      assert.ok(!serialized.includes('undefined'), `${suffix} 返回值含 undefined`)
      return value
    }

    const scanned = await call('scan')
    assert.equal(scanned.projectPath, root)
    assert.ok(scanned.summary.includes('下一步'))

    const analyzed = await call('analyze')
    assert.ok(analyzed.counts.symbols > 0)
    assert.deepEqual(validateIR(await readJsonFile(irFile(root), undefined)), [])

    const reported = await call('report')
    assert.equal(Object.keys(reported.files).length, 6)
    assert.equal(reported.llm.used, false, '默认不得调用 LLM')
    assert.ok(reported.index === null || reported.index.chunks > 0)

    const asked = await call('ask', { question: '订单创建流程经过哪些模块' })
    assert.ok(asked.answer.length > 0)
    assert.ok(Array.isArray(asked.citations))

    const updated = await call('update')
    assert.ok(updated.changes !== null && updated.changes !== undefined)

    const status = await call('status')
    assert.equal(status.analyzed, true)
    assert.equal(status.hasScan, true)
    assert.equal(status.answerCount >= 1, true, '问答应被计入统计')

    // 报告产物清单必须 6/6
    const present = Object.values(status.artifacts).filter((entry) => entry.exists)
    assert.equal(present.length, 6, `产物应 6 份齐全，实际 ${present.length}`)

    // 未分析项目上的 report/ask 必须给出可操作错误，而不是静默降级
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'compass-empty-'))
    try {
      await assert.rejects(
        () => byName.get('project_compass_report').execute({ projectPath: emptyRoot }, exec),
        /尚未分析|缺少可用的 IR/,
      )
    } finally {
      await rm(emptyRoot, { recursive: true, force: true })
    }
  } finally {
    await cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * 7. 参数校验与降级
 * ------------------------------------------------------------------ */

test('e2e：非法入参直接报错，不产生半成品产物', async () => {
  const { root, cleanup } = await makeProject()
  try {
    const definitions = createToolDefinitions({ logger: { info() {}, warn() {}, debug() {} } }, {})
    const byName = new Map(definitions.map((definition) => [definition.name, definition]))
    const exec = { agent: { id: 'e2e', session: { header: { cwd: root } } } }

    await assert.rejects(() => byName.get('project_compass_ask').execute({ projectPath: root }, exec), /question 必填/)
    await assert.rejects(
      () => byName.get('project_compass_scan').execute({ projectPath: path.join(root, '不存在') }, exec),
      /项目路径不存在/,
    )
    await assert.rejects(
      () => byName.get('project_compass_analyze').execute({ projectPath: root, maxFiles: 'many' }, exec),
      /maxFiles 必须是数字/,
    )

    // 校验失败不应写出任何产物
    const entries = await readdir(root)
    assert.ok(!entries.includes('docs'), '参数校验失败时不得生成报告目录')
  } finally {
    await cleanup()
  }
})
