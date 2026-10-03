/**
 * 报告渲染层测试（node:test + node:assert/strict，零依赖、不联网）。
 *
 * 覆盖：6 个产物键、元信息块、证据引用、FR11 角色路线、Mermaid 基础语法、
 * 空数据降级、maxNodes 截断注记、密钥值不外泄。
 *
 * @module dsh-project-compass/test/report
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { renderReports, renderRoleRoutes, roleCatalogue } from '../lib/report.js'
import {
  architectureDiagram,
  fileGraphDiagram,
  flowDiagram,
  moduleGraphDiagram,
  sequenceForFlow,
} from '../lib/mermaid.js'

/* ------------------------------------------------------------------ *
 * 合成 model（2–3 个模块 + 符号/导入/调用/路由/flow/graph）
 * ------------------------------------------------------------------ */

const GENERATED_AT = '2024-05-01T00:00:00.000Z'

function buildModel() {
  const files = [
    {
      id: 'src/api/routes.js',
      moduleId: 'src/api',
      language: 'javascript',
      kind: 'source',
      loc: 40,
      bytes: 900,
      languageGuessed: false,
      symbols: ['src/api/routes.js#createOrder@12', 'src/api/routes.js#listOrders@30'],
      imports: ['src/api/routes.js:3'],
      calls: ['src/api/routes.js:20:saveOrder'],
      routes: ['POST /orders', 'GET /orders'],
      exports: ['createOrder'],
      todos: [{ line: 36, text: 'TODO: 补部分失败重试', kind: 'todo' }],
      parse: 'deep',
      warnings: [],
    },
    {
      id: 'src/api/handlers.js',
      moduleId: 'src/api',
      language: 'javascript',
      kind: 'source',
      loc: 30,
      bytes: 700,
      symbols: ['src/api/handlers.js#saveOrder@9'],
      imports: ['src/api/handlers.js:2'],
      calls: ['src/api/handlers.js:11:insertOrder'],
      routes: [],
      exports: ['saveOrder'],
      todos: [],
      parse: 'deep',
      warnings: [],
    },
    {
      id: 'src/db/repo.js',
      moduleId: 'src/db',
      language: 'javascript',
      kind: 'source',
      loc: 24,
      bytes: 500,
      symbols: ['src/db/repo.js#insertOrder@8'],
      imports: ['src/db/repo.js:1'],
      calls: [],
      routes: [],
      exports: ['insertOrder'],
      todos: [],
      parse: 'deep',
      warnings: [],
    },
    {
      id: 'test/api.test.js',
      moduleId: 'test',
      language: 'javascript',
      kind: 'test',
      loc: 18,
      bytes: 380,
      symbols: ['test/api.test.js#ordersSuite@5'],
      imports: ['test/api.test.js:1'],
      calls: ['test/api.test.js:9:createOrder'],
      routes: [],
      exports: [],
      todos: [],
      parse: 'deep',
      warnings: [],
    },
    {
      id: 'Dockerfile',
      moduleId: '.',
      language: 'text',
      kind: 'infra',
      loc: 12,
      bytes: 220,
      symbols: [],
      imports: [],
      calls: [],
      routes: [],
      exports: [],
      todos: [],
      parse: 'light',
      warnings: [],
    },
  ]

  const symbols = [
    { id: 'src/api/routes.js#createOrder@12', fileId: 'src/api/routes.js', moduleId: 'src/api', name: 'createOrder', kind: 'function', line: 12, endLine: 26, exported: true, parent: null, signature: 'createOrder(req, res)', doc: '创建订单', loc: 14, fanIn: 2, fanOut: 3, risk: 'medium' },
    { id: 'src/api/routes.js#listOrders@30', fileId: 'src/api/routes.js', moduleId: 'src/api', name: 'listOrders', kind: 'route-handler', line: 30, endLine: 35, exported: true, parent: null, signature: null, doc: null, loc: 5, fanIn: 1, fanOut: 1, risk: 'low' },
    { id: 'src/api/handlers.js#saveOrder@9', fileId: 'src/api/handlers.js', moduleId: 'src/api', name: 'saveOrder', kind: 'function', line: 9, endLine: 20, exported: true, parent: null, signature: 'saveOrder(order)', doc: null, loc: 11, fanIn: 3, fanOut: 2, risk: 'medium' },
    { id: 'src/db/repo.js#insertOrder@8', fileId: 'src/db/repo.js', moduleId: 'src/db', name: 'insertOrder', kind: 'function', line: 8, endLine: 16, exported: true, parent: null, signature: 'insertOrder(row)', doc: null, loc: 8, fanIn: 4, fanOut: 1, risk: 'low' },
    { id: 'test/api.test.js#ordersSuite@5', fileId: 'test/api.test.js', moduleId: 'test', name: 'ordersSuite', kind: 'function', line: 5, endLine: 17, exported: false, parent: null, signature: null, doc: null, loc: 12, fanIn: 0, fanOut: 2, risk: 'low' },
  ]

  const ir = {
    schemaVersion: 1,
    root: '/tmp/demo-shop',
    name: 'demo-shop',
    generatedAt: GENERATED_AT,
    profileSummary: { kinds: ['api-service'], ecosystems: ['node'], commands: ['install', 'test'], entrypoints: ['src/api/routes.js'], tests: ['test/api.test.js'], signals: ['todoCount'] },
    modules: [
      { id: 'src/api', name: 'api', dir: 'src/api', language: 'javascript', kind: 'source', files: ['src/api/routes.js', 'src/api/handlers.js'], loc: 70, symbolCount: 3, entrypoints: ['src/api/routes.js'], dependsOn: ['src/db'], dependedOnBy: ['test'], risk: 'medium', notes: [] },
      { id: 'src/db', name: 'db', dir: 'src/db', language: 'javascript', kind: 'source', files: ['src/db/repo.js'], loc: 24, symbolCount: 1, entrypoints: [], dependsOn: [], dependedOnBy: ['src/api'], risk: 'low', notes: [] },
      { id: 'test', name: 'test', dir: 'test', language: 'javascript', kind: 'test', files: ['test/api.test.js'], loc: 18, symbolCount: 1, entrypoints: [], dependsOn: ['src/api'], dependedOnBy: [], risk: 'low', notes: [] },
      { id: '.', name: 'root', dir: '.', language: 'text', kind: 'infra', files: ['Dockerfile'], loc: 12, symbolCount: 0, entrypoints: [], dependsOn: [], dependedOnBy: [], risk: 'low', notes: [] },
    ],
    files,
    symbols,
    imports: [
      { id: 'src/api/routes.js:3', fileId: 'src/api/routes.js', moduleId: 'src/api', specifier: './handlers.js', line: 3, names: ['saveOrder'], kind: 'static', target: 'src/api/handlers.js', targetModule: 'src/api', external: false, packageName: null, resolved: true },
      { id: 'src/api/handlers.js:2', fileId: 'src/api/handlers.js', moduleId: 'src/api', specifier: '../db/repo.js', line: 2, names: ['insertOrder'], kind: 'static', target: 'src/db/repo.js', targetModule: 'src/db', external: false, packageName: null, resolved: true },
      { id: 'src/db/repo.js:1', fileId: 'src/db/repo.js', moduleId: 'src/db', specifier: 'pg', line: 1, names: ['Pool'], kind: 'static', target: null, targetModule: null, external: true, packageName: 'pg', resolved: false },
      { id: 'test/api.test.js:1', fileId: 'test/api.test.js', moduleId: 'test', specifier: 'node:test', line: 1, names: ['test'], kind: 'static', target: null, targetModule: null, external: true, packageName: 'node:test', resolved: false },
    ],
    calls: [
      { id: 'src/api/routes.js:20:saveOrder', fileId: 'src/api/routes.js', moduleId: 'src/api', line: 20, calleeName: 'saveOrder', receiver: null, kind: 'call', fromSymbolId: 'src/api/routes.js#createOrder@12', toSymbolId: 'src/api/handlers.js#saveOrder@9', resolution: 'import', external: false },
      { id: 'src/api/handlers.js:11:insertOrder', fileId: 'src/api/handlers.js', moduleId: 'src/api', line: 11, calleeName: 'insertOrder', receiver: null, kind: 'await', fromSymbolId: 'src/api/handlers.js#saveOrder@9', toSymbolId: 'src/db/repo.js#insertOrder@8', resolution: 'import', external: false },
      { id: 'src/api/routes.js:22:console.log', fileId: 'src/api/routes.js', moduleId: 'src/api', line: 22, calleeName: 'log', receiver: 'console', kind: 'call', fromSymbolId: 'src/api/routes.js#createOrder@12', toSymbolId: null, resolution: 'global', external: false },
      { id: 'test/api.test.js:9:createOrder', fileId: 'test/api.test.js', moduleId: 'test', line: 9, calleeName: 'createOrder', receiver: null, kind: 'call', fromSymbolId: 'test/api.test.js#ordersSuite@5', toSymbolId: null, resolution: 'unresolved', external: false },
    ],
    routes: [
      { id: 'POST /orders', method: 'POST', path: '/orders', framework: 'express', fileId: 'src/api/routes.js', moduleId: 'src/api', line: 20, handlerSymbolId: 'src/api/routes.js#createOrder@12', handlerName: 'createOrder', middlewares: ['auth'], kind: 'http' },
      { id: 'GET /orders', method: 'GET', path: '/orders', framework: 'express', fileId: 'src/api/routes.js', moduleId: 'src/api', line: 30, handlerSymbolId: 'src/api/routes.js#listOrders@30', handlerName: 'listOrders', middlewares: [], kind: 'http' },
    ],
    graph: {},
    stats: { modules: 4, files: 5, sourceFiles: 4, symbols: 5, imports: 4, calls: 4, routes: 2, loc: 124, languages: [{ name: 'javascript', files: 4, loc: 112 }, { name: 'text', files: 1, loc: 12 }] },
    warnings: [],
    truncated: false,
    budget: { filesAnalyzed: 5, filesSkipped: 0, bytesRead: 2700, durationMs: 120, llmCalls: 0 },
  }

  const profile = {
    root: '/tmp/demo-shop',
    name: 'demo-shop',
    scannedAt: GENERATED_AT,
    durationMs: 80,
    size: { files: 6, dirs: 5, bytes: 4096, sourceFiles: 4, skipped: 1, truncated: false },
    languages: [
      { name: 'javascript', files: 4, loc: 112, bytes: 2480 },
      { name: 'text', files: 1, loc: 12, bytes: 220 },
    ],
    kinds: ['api-service'],
    ecosystems: [{ kind: 'node', manifest: 'package.json', name: 'demo-shop', version: '1.0.0', scripts: { test: 'node --test' } }],
    commands: [
      { preset: 'install', argv: ['npm', 'install'], source: 'package.json' },
      { preset: 'test', argv: ['npm', 'test'], source: 'package.json' },
      { preset: 'build', argv: ['npm', 'run', 'build'], source: 'package.json' },
    ],
    entrypoints: [{ path: 'src/api/routes.js', kind: 'http-server', evidence: 'src/api/routes.js:1' }],
    configs: [{ path: '.env.example', kind: 'env' }, { path: 'package.json', kind: 'manifest' }],
    docs: ['README.md'],
    ci: [{ id: 'github-actions', path: '.github/workflows/test.yml' }],
    containers: ['Dockerfile'],
    iac: [],
    tests: {
      frameworks: [{ id: 'node:test', label: 'node:test', evidence: 'package.json:1' }],
      testFiles: ['test/api.test.js'],
      testFileCount: 1,
      coverageConfig: [],
    },
    deps: {
      direct: ['express', 'pg'],
      dev: [],
      notable: [
        { name: 'express', version: '^4.19.0', kind: 'runtime' },
        { name: 'pg', version: '^8.11.0', kind: 'runtime' },
      ],
    },
    signals: {
      todoCount: 1,
      todos: [{ path: 'src/api/routes.js', line: 36, text: 'TODO: 补部分失败重试', kind: 'todo' }],
      debugStatementCount: 1,
      // 故意夹带一个"疑似密钥值"，报告只能输出位置，绝不能回显这个字段
      secretSuspects: [{ path: '.env.example', line: 3, kind: 'api-key', value: 'sk-SHOULD-NOT-APPEAR' }],
      largeFiles: ['src/api/routes.js'],
      generatedFiles: [],
    },
    sensitive: [{ path: '.env', kind: 'env', reason: '包含密钥' }],
    ignore: { rules: ['node_modules/**'], sources: ['.gitignore'] },
    gaps: [
      { id: 'GAP-1', priority: 'P1', title: '缺少集成测试', detail: '只有 1 个测试文件', evidence: ['test/api.test.js:1'] },
    ],
    warnings: ['示例告警：1 个文件解析降级'],
    truncated: false,
  }

  const graph = {
    module: {
      nodes: [
        { id: 'src/api', label: 'api', loc: 70, files: 2, symbolCount: 3, kind: 'source' },
        { id: 'src/db', label: 'db', loc: 24, files: 1, symbolCount: 1, kind: 'source' },
        { id: 'test', label: 'test', loc: 18, files: 1, symbolCount: 1, kind: 'test' },
        { id: '.', label: 'root', loc: 12, files: 1, symbolCount: 0, kind: 'infra' },
      ],
      edges: [
        { from: 'src/api', to: 'src/db', weight: 3, external: false },
        { from: 'test', to: 'src/api', weight: 2, external: false },
        { from: 'src/api', to: 'test', weight: 1, external: false },
      ],
      cycles: [['src/api', 'test']],
    },
    file: {
      nodes: [
        { id: 'src/api/routes.js', label: 'routes.js', loc: 40 },
        { id: 'src/api/handlers.js', label: 'handlers.js', loc: 30 },
        { id: 'src/db/repo.js', label: 'repo.js', loc: 24 },
        { id: 'test/api.test.js', label: 'api.test.js', loc: 18 },
      ],
      edges: [
        { from: 'src/api/routes.js', to: 'src/api/handlers.js', weight: 1, external: false },
        { from: 'src/api/handlers.js', to: 'src/db/repo.js', weight: 1, external: false },
        { from: 'test/api.test.js', to: 'src/api/routes.js', weight: 2, external: false },
      ],
      cycles: [],
    },
    symbol: {
      nodes: symbols.map((symbol) => ({ id: symbol.id, label: symbol.name, loc: symbol.loc })),
      edges: [
        { from: 'src/api/routes.js#createOrder@12', to: 'src/api/handlers.js#saveOrder@9', weight: 1, external: false },
        { from: 'src/api/handlers.js#saveOrder@9', to: 'src/db/repo.js#insertOrder@8', weight: 1, external: false },
      ],
      cycles: [],
    },
    metrics: {
      fanIn: { 'src/api': 2, 'src/db': 1, test: 0, '.': 0 },
      fanOut: { 'src/api': 2, 'src/db': 0, test: 1, '.': 0 },
      hubs: [{ id: 'src/api', fanIn: 2, fanOut: 2 }, { id: 'src/db', fanIn: 1, fanOut: 0 }],
      orphans: ['.'],
      entryReach: { 'src/api/routes.js': true, 'src/db/repo.js': true, 'test/api.test.js': false },
      riskModules: [{ id: 'src/api', score: 7, reasons: ['位于循环依赖中', '枢纽模块'] }],
    },
    stats: { moduleNodes: 4, moduleEdges: 3, fileNodes: 4, fileEdges: 3, symbolNodes: 5, symbolEdges: 2, crossModuleEdges: 2, cycles: 1 },
  }

  const flows = [
    {
      id: 'POST /orders',
      name: '创建订单',
      kind: 'http',
      entry: { fileId: 'src/api/routes.js', line: 20, symbolId: 'src/api/routes.js#createOrder@12', symbolName: 'createOrder', label: 'POST /orders' },
      steps: [
        { order: 1, fileId: 'src/api/routes.js', line: 20, symbolId: 'src/api/routes.js#createOrder@12', symbolName: 'createOrder', kind: 'entry', via: 'express-router' },
        { order: 2, fileId: 'src/api/handlers.js', line: 9, symbolId: 'src/api/handlers.js#saveOrder@9', symbolName: 'saveOrder', kind: 'call', via: 'import' },
        { order: 3, fileId: 'src/db/repo.js', line: 8, symbolId: null, symbolName: 'insertOrder', kind: 'data', via: 'call' },
        { order: 4, fileId: 'src/api/routes.js', line: 25, symbolId: null, symbolName: null, kind: 'response', via: 'return' },
      ],
      evidence: ['src/api/routes.js:20', 'src/api/handlers.js:9'],
      confidence: 'medium',
      notes: ['第 3 步未解析到符号定义'],
    },
    {
      id: 'GET /orders',
      name: '查询订单列表',
      kind: 'http',
      entry: { fileId: 'src/api/routes.js', line: 30, symbolId: 'src/api/routes.js#listOrders@30', symbolName: 'listOrders', label: 'GET /orders' },
      steps: [],
      evidence: [],
      confidence: 'low',
      notes: [],
    },
  ]

  const insights = {
    narratives: [
      { title: '分层结构', text: 'API 层通过 handlers 访问 db 层，未发现反向依赖。', evidence: ['src/api/handlers.js:2'] },
      { title: '未验证的猜测', text: '可能使用了连接池中间件。', evidence: [] },
    ],
    risks: ['错误处理分散在 handlers 内', { title: '缺少输入校验', detail: '未发现校验中间件', evidence: ['src/api/routes.js:20'] }],
    roles: [{ id: 'backend', focus: '先看路由再看服务层（insights 覆盖）' }],
    readingOrder: ['src/api/routes.js:20', { path: 'src/db/repo.js', line: 8, title: '数据访问入口', why: '唯一的持久化出口' }],
  }

  return {
    ir,
    profile,
    graph,
    flows,
    insights,
    meta: {
      generatedAt: GENERATED_AT,
      version: '0.1.0',
      llm: { used: false, provider: '', model: '' },
      validation: { dropped: [{ claim: '不存在的符号 foo', reason: 'unknown symbol' }], total: 3, valid: 2 },
    },
  }
}

/** 只有后端证据的项目（用于验证不编造前端路线）。 */
function buildBackendOnlyModel() {
  const model = buildModel()
  model.profile.entrypoints = [{ path: 'src/api/routes.js', kind: 'http-server', evidence: 'src/api/routes.js:1' }]
  model.profile.configs = [{ path: 'package.json', kind: 'manifest' }]
  model.profile.docs = []
  model.profile.ci = []
  model.profile.containers = []
  model.profile.tests = { frameworks: [], testFiles: [], testFileCount: 0, coverageConfig: [] }
  model.profile.deps = { direct: ['express'], dev: [], notable: [{ name: 'express', version: '^4.19.0', kind: 'runtime' }] }
  model.ir.modules = model.ir.modules.filter((module) => module.kind === 'source')
  model.ir.files = model.ir.files.filter((file) => file.moduleId.startsWith('src/'))
  model.ir.symbols = model.ir.symbols.filter((symbol) => symbol.fileId.startsWith('src/'))
  model.flows = model.flows.slice(0, 1)
  return model
}

/* ------------------------------------------------------------------ *
 * Mermaid 基础语法校验器（自写，不引入任何依赖）
 * ------------------------------------------------------------------ */

function countChar(text, char) {
  let count = 0
  for (const item of text) if (item === char) count += 1
  return count
}

/** 抽出所有 ```mermaid 代码块，并检查围栏是否配对。 */
function mermaidBlocks(text) {
  const lines = String(text).split('\n')
  const blocks = []
  let inBlock = false
  let current = []
  let fences = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      fences += 1
      if (!inBlock && trimmed === '```mermaid') {
        inBlock = true
        current = []
        continue
      }
      if (inBlock) {
        inBlock = false
        blocks.push(current.join('\n'))
        current = []
      }
      continue
    }
    if (inBlock) current.push(line)
  }
  return { blocks, fences, closed: !inBlock }
}

/** 校验单个 Mermaid 源：首行、括号配平、引号成对、节点 id、边语法、subgraph 配对。 */
function validateMermaid(source) {
  const problems = []
  const lines = String(source ?? '').split('\n')
  const first = (lines[0] ?? '').trim()
  if (!/^(flowchart (TD|TB|LR|RL|BT)|sequenceDiagram)$/.test(first)) problems.push(`首行非法：${first}`)
  const code = lines.filter((line) => !line.trim().startsWith('%%'))
  const text = code.join('\n')
  for (const [open, close] of [['[', ']'], ['(', ')'], ['{', '}']]) {
    const left = countChar(text, open)
    const right = countChar(text, close)
    if (left !== right) problems.push(`括号不配平 ${open}${close}：${left}/${right}`)
  }
  if (countChar(text, '"') % 2 !== 0) problems.push('双引号数量为奇数')

  if (first.startsWith('flowchart')) {
    const ids = new Set()
    for (const line of code) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const subgraph = trimmed.match(/^subgraph\s+([A-Za-z0-9_]+)/)
      if (subgraph) ids.add(subgraph[1])
      const declared = trimmed.match(/^([A-Za-z0-9_]+)\[/)
      if (declared) ids.add(declared[1])
      const edge = trimmed.match(/^([A-Za-z0-9_]+)\s*(-\.->|-->)(.*)$/)
      if (edge) {
        ids.add(edge[1])
        const rest = edge[3].trim()
        if (rest.length > 0) {
          const labelled = rest.match(/^\|(\d+)\|\s+([A-Za-z0-9_]+)$/)
          const plain = rest.match(/^([A-Za-z0-9_]+)$/)
          if (labelled) ids.add(labelled[2])
          else if (plain) ids.add(plain[1])
          else problems.push(`边语法可疑：${trimmed}`)
        }
      }
    }
    for (const id of ids) {
      if (!/^(empty|n\d+|sg_[A-Za-z0-9_]+)$/.test(id)) problems.push(`节点 id 非法：${id}`)
    }
    const opens = code.filter((line) => line.trim().startsWith('subgraph')).length
    const ends = code.filter((line) => line.trim() === 'end').length
    if (opens !== ends) problems.push(`subgraph/end 不配对：${opens}/${ends}`)
  } else {
    for (const line of code) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const ok = /^(sequenceDiagram|autonumber|participant\s+[A-Za-z0-9_]+\s+as\s+.+|Note over\s+[^:]+:\s*.+|[A-Za-z0-9_]+\s*(-->>|->>|--x|->)\s*[A-Za-z0-9_]+\s*:\s*.+)$/.test(trimmed)
      if (!ok) problems.push(`时序图语句可疑：${trimmed}`)
    }
  }
  return problems
}

function assertMermaidValid(source, hint) {
  const problems = validateMermaid(source)
  assert.deepEqual(problems, [], `${hint} 的 Mermaid 校验失败：\n${problems.join('\n')}\n---\n${source}`)
}

/* ------------------------------------------------------------------ *
 * 证据纪律守卫：聚合类数字不得挂具体源文件当证据
 * ------------------------------------------------------------------ */

/** 聚合类事实的措辞（规模、计数、分布）。 */
const AGGREGATE_PATTERNS = [
  /文件 \d+ 个/,
  /符号 \d+ 个/,
  /\d+ 行/,
  /依赖边 \d+ 条/,
  /循环依赖 \d+ 处/,
  /模块 \d+ 个/,
  /测试文件 \d+ 个/,
  /路由 \d+ 条/,
  /入口 \d+ 个/,
  /文件数/,
  /\bLOC\b/,
]

/** 聚合类事实允许出现的数据来源标注。 */
const DATA_SOURCE_PATTERN = /project-compass\.json|\.project-compass\/scan\.json|依赖图谱|IR 统计|IR 模块记录|IR 路由记录|扫描画像|流程分析|由本次静态分析聚合得出/

/** 源码/配置源文件引用（出现在行尾即视为"给这一行当证据"）。`.json` 属数据来源，放行。 */
const SOURCE_FILE_TAIL = /`[^`]*\.(?:js|mjs|cjs|ts|tsx|jsx|py|java|kt|go|rs|rb|php|vue|svelte|sh|bash|sql|css|scss|html|yml|yaml|toml|md|txt)(?::\d+)?(?:#[\w$@]+)?`\s*\|?\s*$/

/** 把 Markdown 切成一段段表格（连续的 `|` 行）。 */
function tableBlocks(markdown) {
  const blocks = []
  let current = null
  for (const line of String(markdown ?? '').split('\n')) {
    if (line.trim().startsWith('|')) {
      if (current === null) {
        current = []
        blocks.push(current)
      }
      current.push(line)
    } else {
      current = null
    }
  }
  return blocks
}

/** 找出一行里"聚合关键词 + 行尾源文件引用 + 未标注数据来源"的组合。 */
function aggregateEvidenceOffenders(markdown) {
  const offenders = []
  const lines = String(markdown ?? '').split('\n')
  lines.forEach((line, index) => {
    if (!AGGREGATE_PATTERNS.some((pattern) => pattern.test(line))) return
    if (DATA_SOURCE_PATTERN.test(line)) return
    if (SOURCE_FILE_TAIL.test(line)) offenders.push(`第 ${index + 1} 行：${line.trim()}`)
  })
  return offenders
}

const REPORT_KEYS = ['onboarding', 'architecture', 'moduleMap', 'keyFlows', 'gettingStarted', 'json']
const MARKDOWN_KEYS = REPORT_KEYS.filter((key) => key !== 'json')

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

test('renderReports 返回 6 个键，Markdown 非空，json 是对象', () => {
  const model = buildModel()
  const { files, meta } = renderReports(model)

  assert.deepEqual(Object.keys(files), REPORT_KEYS)
  for (const key of MARKDOWN_KEYS) {
    assert.equal(typeof files[key], 'string', `${key} 应为字符串`)
    assert.ok(files[key].trim().length > 200, `${key} 内容过短，疑似占位符`)
  }
  assert.equal(typeof files.json, 'object')
  assert.ok(!Array.isArray(files.json))
  assert.doesNotThrow(() => JSON.stringify(files.json))
  assert.equal(meta.generatedAt, GENERATED_AT)
  assert.equal(meta.counts.modules, 4)
})

test('每份 Markdown 都包含元信息块与证据引用', () => {
  const { files } = renderReports(buildModel())
  const evidencePattern = /\w+\.\w+:\d+/
  for (const key of MARKDOWN_KEYS) {
    const text = files[key]
    assert.match(text, /生成时间/, `${key} 缺少生成时间`)
    assert.match(text, /证据口径/, `${key} 缺少证据口径`)
    assert.match(text, /工具版本/, `${key} 缺少工具版本`)
    assert.match(text, /LLM 参与/, `${key} 缺少 LLM 参与说明`)
    assert.match(text, /验证器/, `${key} 缺少验证器丢弃条数`)
    assert.match(text, /本报告全部结论来自静态证据，未调用 LLM/, `${key} 未声明未调用 LLM`)
    assert.match(text, evidencePattern, `${key} 缺少 path:line 形式的证据引用`)
  }
})

test('证据纪律：聚合类数字不挂具体源文件当证据（自动化守卫）', () => {
  const { files } = renderReports(buildModel())
  for (const key of MARKDOWN_KEYS) {
    const offenders = aggregateEvidenceOffenders(files[key])
    assert.deepEqual(offenders, [], `${key} 存在"聚合数字 + 源文件证据"的可疑组合：\n${offenders.join('\n')}`)
  }
})

test('证据纪律：聚合类事实必须带数据来源标注（正向断言）', () => {
  const { files } = renderReports(buildModel())

  // 1) 任何"聚合措辞"的数据行，都必须写数据来源
  for (const key of ['onboarding', 'architecture', 'moduleMap', 'keyFlows', 'gettingStarted']) {
    const rows = files[key]
      .split('\n')
      .filter((line) => line.startsWith('|') && /\d/.test(line) && !/^\|[\s-|]+\|$/.test(line) && AGGREGATE_PATTERNS.some((pattern) => pattern.test(line)))
    for (const row of rows) assert.match(row, DATA_SOURCE_PATTERN, `${key} 的聚合行缺少数据来源标注：${row}`)
  }

  // 2) 表头声明为"数据来源"的表格，其每一行数据都必须是数据来源，而不是源文件
  for (const key of ['onboarding', 'architecture', 'moduleMap']) {
    for (const block of tableBlocks(files[key])) {
      const header = block[0]
      if (!header.includes('数据来源')) continue
      const dataRows = block.slice(2).filter((row) => row.trim().length > 0)
      assert.ok(dataRows.length > 0, `${key} 的"数据来源"表没有数据行`)
      for (const row of dataRows) assert.match(row, DATA_SOURCE_PATTERN, `${key} 的"数据来源"表混入了非数据来源：${row}`)
    }
  }

  // 3) 数据来源本身不得是源码文件
  assert.ok(!/来自 IR 统计（`[^`]*\.js/.test(files.architecture))
  assert.match(files.architecture, /来自依赖图谱（project-compass\.json:graph\.stats）/)
  assert.match(files.onboarding, /来自扫描画像（\.project-compass\/scan\.json）/)
  assert.match(files.onboarding, /^- \*\*第 1 步：读 `/m)
})

test('证据纪律：散文式证据串不会被伪造成 path:line，复合串取第一段可引用位置', () => {
  const model = buildModel()
  model.profile.tests.frameworks = [{ id: 'jest', label: 'jest', evidence: 'HTTP 服务创建调用 (行 5)' }]
  model.profile.gaps = [{ id: 'G1', priority: 'P0', title: '散文证据缺口', detail: '说明', evidence: ['配置文件里缺少超时设置'] }]

  const prose = renderReports(model)
  for (const key of MARKDOWN_KEYS) {
    assert.ok(!prose.files[key].includes('HTTP 服务创建调用 (行 5):1'), `${key} 把散文证据伪造成了引用`)
    assert.ok(!prose.files[key].includes('配置文件里缺少超时设置:1'), `${key} 把散文证据伪造成了引用`)
  }
  assert.match(prose.files.architecture, /框架证据：（未提供框架证据）/)

  // 复合证据串：取第一段真实可引用的 `path:line`
  model.profile.tests.frameworks = [{ id: 'node:test', label: 'node:test', evidence: 'test/api.test.js:1；package.json:scripts.test:1' }]
  const composite = renderReports(model)
  assert.match(composite.files.architecture, /框架证据：`test\/api\.test\.js:1`/)
})

test('ONBOARDING 含“按角色阅读路线”表格且 5 个角色都出现', () => {
  const { files } = renderReports(buildModel())
  const onboarding = files.onboarding
  assert.match(onboarding, /按角色阅读路线/)
  assert.match(onboarding, /\|\s*角色\s*\|/)
  for (const role of roleCatalogue()) {
    assert.ok(onboarding.includes(role.label), `缺少角色 ${role.label}`)
  }
  assert.equal(roleCatalogue().length, 5)
  assert.deepEqual(roleCatalogue().map((role) => role.id), ['backend', 'frontend', 'test', 'devops', 'data'])
})

test('Mermaid 代码块通过基础语法校验（围栏配对 + 首行 + 节点 id + 括号配平）', () => {
  const { files } = renderReports(buildModel())
  for (const key of MARKDOWN_KEYS) {
    const { blocks, fences, closed } = mermaidBlocks(files[key])
    assert.equal(fences % 2, 0, `${key} 的代码围栏数量为奇数`)
    assert.ok(closed, `${key} 存在未闭合的代码块`)
    assert.ok(blocks.length > 0, `${key} 没有 Mermaid 代码块`)
    blocks.forEach((block, index) => assertMermaidValid(block, `${key}#${index}`))
  }
})

test('mermaid.js 五个导出都能产出合法 Mermaid，且空图/空流程降级', () => {
  const model = buildModel()
  const outputs = {
    moduleGraph: moduleGraphDiagram(model.graph, { maxNodes: 40 }),
    moduleGraphGrouped: moduleGraphDiagram(model.graph, { maxNodes: 40, groupByKind: true }),
    fileGraph: fileGraphDiagram(model.graph, { maxNodes: 40 }),
    architecture: architectureDiagram(model, { maxNodes: 40 }),
    flow: flowDiagram(model.flows[0]),
    sequence: sequenceForFlow(model.flows[0]),
  }
  for (const [name, source] of Object.entries(outputs)) assertMermaidValid(source, name)
  assert.match(outputs.architecture, /subgraph sg_source\["源码 source"\]/)
  assert.match(outputs.architecture, /-->\|3\|/)
  assert.match(outputs.architecture, /-\.->\|2\|/)

  const emptyGraph = moduleGraphDiagram({ module: { nodes: [], edges: [] } })
  assert.match(emptyGraph, /^flowchart TD/)
  assert.match(emptyGraph, /empty\["无数据"\]/)
  assert.match(emptyGraph, /数据不足/)
  assertMermaidValid(emptyGraph, 'empty-graph')

  const emptyFlow = sequenceForFlow({ id: 'x', name: '空流程', steps: [] })
  assert.match(emptyFlow, /^sequenceDiagram/)
  assert.match(emptyFlow, /数据不足/)
  assertMermaidValid(emptyFlow, 'empty-flow')

  assert.equal(moduleGraphDiagram(null), moduleGraphDiagram({ module: { nodes: [], edges: [] } }))
})

test('中文标签用双引号包裹，标识符只用安全的 n0/n1', () => {
  const model = buildModel()
  model.ir.modules[0].name = '订单[接口]"层"'
  const source = architectureDiagram(model, { maxNodes: 40 })
  assert.match(source, /n\d+\["[^"\n]*"\]/)
  assert.match(source, /订单 接口 层/)
  assert.ok(!/n\d+\[[^"\]]/.test(source), '节点标签未加双引号')
})

test('maxNodes 截断时输出“已省略”注记，不静默截断', () => {
  const nodes = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, label: `模块${index}`, kind: index % 2 === 0 ? 'source' : 'test', loc: index * 10 }))
  const edges = []
  for (let index = 1; index < 10; index += 1) edges.push({ from: `m${index}`, to: 'm0', weight: index })
  const graph = { module: { nodes, edges }, metrics: { fanIn: { m0: 9 }, fanOut: {} } }

  const truncated = moduleGraphDiagram(graph, { maxNodes: 3 })
  assert.match(truncated, /（已省略 7 个节点）/)
  assertMermaidValid(truncated, 'truncated-module-graph')
  assert.equal(truncated.split('\n').filter((line) => /^  n\d+\[/.test(line)).length, 3)

  const full = moduleGraphDiagram(graph, { maxNodes: 40 })
  assert.ok(!full.includes('已省略'))
  assert.equal(full.split('\n').filter((line) => /^  n\d+\[/.test(line)).length, 10)

  const { files } = renderReports(buildModel(), { maxNodes: 3 })
  assert.match(files.architecture, /已省略 1 个节点/)
})

test('空 IR / insights 缺失 / flows 为空时不抛错，并给出“数据不足”说明', () => {
  const empties = [
    {},
    { ir: {}, profile: {}, graph: {}, flows: [], insights: {} },
    { ir: { modules: [], files: [], symbols: [], routes: [], stats: {} }, profile: { commands: [] }, graph: { module: { nodes: [], edges: [] } }, flows: [], insights: null },
  ]
  for (const model of empties) {
    let result
    assert.doesNotThrow(() => {
      result = renderReports(model)
    })
    assert.deepEqual(Object.keys(result.files), REPORT_KEYS)
    for (const key of MARKDOWN_KEYS) {
      assert.equal(typeof result.files[key], 'string')
      assert.match(result.files[key], /数据不足/, `${key} 缺少数据不足说明`)
    }
    assert.equal(typeof result.files.json, 'object')
    assert.doesNotThrow(() => JSON.stringify(result.files.json))
    assert.deepEqual(renderRoleRoutes(model).length, 5)
  }
})

test('insights 字段缺失或形状怪异时仍然可渲染', () => {
  const model = buildModel()
  model.insights = { narratives: '一段字符串叙述', risks: { a: '风险字符串' }, roles: null, readingOrder: null }
  const { files } = renderReports(model)
  assert.match(files.architecture, /一段字符串叙述/)
  assert.match(files.onboarding, /风险字符串|错误处理/)
})

test('对齐 lib/insights.js 的真实形状：claim 用 citations、readingOrder 用 citations', () => {
  const model = buildModel()
  model.insights = {
    narratives: {
      projectSummary: { text: '这是一个订单服务。', citations: [{ path: 'src/api/routes.js', line: 20 }] },
      architecture: [{ text: '入口集中在 routes.js。', citations: [{ path: 'src/api/routes.js', line: 1 }] }],
      modules: [{ module: 'src/db', text: 'db 层只负责写入。', citations: [{ path: 'src/db/repo.js', line: 8 }] }],
      risks: [],
      readingOrder: [],
    },
    readingOrder: [{ target: '先读路由定义', why: '对外契约都在这里', citations: [{ path: 'src/api/routes.js', line: 20 }] }],
    risks: [{ id: 'module-risk:src/api', severity: 'high', title: '模块 src/api 风险分 7/10', detail: '位于循环依赖中', evidence: ['src/api'], source: 'graph', verified: true }],
    llm: { used: true, provider: 'deepseek', model: 'flash', elapsedMs: 10 },
    validation: { claims: 5, kept: 3, dropped: 2 },
  }
  model.meta.llm = { used: true, provider: 'deepseek', model: 'flash', calls: 2 }
  model.meta.validation = { claims: 5, kept: 3, dropped: 2 }

  const { files } = renderReports(model)
  assert.match(files.onboarding, /先读路由定义/)
  assert.match(files.onboarding, /先读路由定义[\s\S]{0,160}src\/api\/routes\.js:20|src\/api\/routes\.js:20[\s\S]{0,160}先读路由定义/)
  assert.match(files.architecture, /这是一个订单服务/)
  assert.match(files.architecture, /db 层只负责写入/)
  assert.match(files.onboarding, /\[high\]/)
  assert.match(files.onboarding, /丢弃 2 条/)
  assert.match(files.architecture, /LLM 参与\*\*：是/)
  assert.ok(!files.architecture.includes('未验证（LLM 叙述未提供静态证据）'), '有 citations 的叙述不应被标为未验证')
})

test('renderRoleRoutes 由证据推导；只有后端项目时不编造前端路线', () => {
  const mixed = buildModel()
  const routes = renderRoleRoutes(mixed)
  assert.equal(routes.length, 5)
  const backend = routes.find((route) => route.role === 'backend')
  assert.ok(backend.order.length >= 2)
  assert.ok(backend.order.every((item, index) => item.step === index + 1))
  assert.ok(backend.order.some((item) => item.path === 'src/api/routes.js'))
  assert.ok(backend.focus.includes('insights 覆盖'), 'insights.roles 应覆盖 focus 文案')
  assert.ok(backend.checklist.length > 0)
  for (const route of routes) {
    assert.deepEqual(Object.keys(route).sort(), ['checklist', 'focus', 'label', 'order', 'role'])
  }

  const single = renderRoleRoutes(mixed, { role: 'data' })
  assert.equal(single.length, 1)
  assert.equal(single[0].role, 'data')
  assert.ok(single[0].order.some((item) => item.path === 'src/db/repo.js'))

  const backendOnly = renderRoleRoutes(buildBackendOnlyModel(), { role: 'frontend' })
  assert.equal(backendOnly.length, 1)
  assert.match(backendOnly[0].order[0].target, /该项目无明显前端证据/)
  assert.equal(backendOnly[0].order[0].path, null)
  assert.match(backendOnly[0].order[0].why, /替代建议/)
  for (const item of backendOnly[0].order) {
    assert.equal(item.path, null, '不得编造前端文件路径')
    assert.equal(item.line, null)
  }
})

test('GETTING_STARTED 用真实命令并标注来源，且不回显疑似密钥值', () => {
  const { files } = renderReports(buildModel())
  const gettingStarted = files.gettingStarted
  assert.match(gettingStarted, /npm install/)
  assert.match(gettingStarted, /package\.json/)
  assert.match(gettingStarted, /\.env\.example/)
  assert.match(gettingStarted, /疑似密钥位置/)
  assert.ok(!gettingStarted.includes('sk-SHOULD-NOT-APPEAR'), '疑似密钥值泄漏到 Markdown')
  assert.ok(!JSON.stringify(files.json).includes('sk-SHOULD-NOT-APPEAR'), '疑似密钥值泄漏到 JSON')
})

test('json 是 IR 摘要视图，字段齐全且可序列化', () => {
  const { files } = renderReports(buildModel())
  const view = files.json
  for (const key of ['schemaVersion', 'generatedAt', 'tool', 'project', 'modules', 'files', 'symbols', 'routes', 'entrypoints', 'commands', 'flows', 'graph', 'risks', 'roleRoutes', 'evidence']) {
    assert.ok(key in view, `json 视图缺少字段 ${key}`)
  }
  assert.equal(view.schemaVersion, 1)
  assert.equal(view.tool.name, 'dsh-project-compass')
  assert.equal(view.project.name, 'demo-shop')
  assert.equal(view.modules.length, 4)
  assert.equal(view.modules[0].files > 0, true)
  assert.equal(view.files.length, 5)
  assert.ok(view.symbols.every((symbol) => 'fanIn' in symbol && 'fanOut' in symbol))
  assert.equal(view.routes.length, 2)
  assert.equal(view.flows.length, 2)
  assert.equal(view.flows[1].steps.length, 0)
  assert.equal(view.roleRoutes.length, 5)
  assert.equal(view.graph.cycles.length, 1)
  assert.ok(view.graph.hubs.length > 0)
  assert.ok(view.risks.items.length > 0)
  assert.equal(view.risks.todos.count, 1)
  assert.match(JSON.stringify(view), /静态证据/)
})

test('KEY_FLOWS 无流程时给出自行定位入口的方法', () => {
  const model = buildModel()
  model.flows = []
  const { files } = renderReports(model)
  assert.match(files.keyFlows, /数据不足/)
  assert.match(files.keyFlows, /如何自行定位入口/)
  assert.match(files.keyFlows, /profile\.entrypoints/)
  const { blocks } = mermaidBlocks(files.keyFlows)
  for (const block of blocks) assertMermaidValid(block, 'key-flows-empty')
})

test('includeMermaid=false 时降级为说明而非图表源码', () => {
  const { files } = renderReports(buildModel(), { includeMermaid: false })
  assert.ok(!files.architecture.includes('```mermaid'))
  assert.match(files.architecture, /已禁用 Mermaid 渲染/)
})

test('渲染层不抛错：畸形 graph/flows 也能产出全部产物', () => {
  const model = buildModel()
  model.graph = { module: { nodes: 'not-an-array', edges: [null, { from: 'a' }] }, metrics: { fanIn: null, hubs: [{}] } }
  model.flows = [{ id: 'x', steps: [{ fileId: null, line: 'NaN' }] }, null]
  let result
  assert.doesNotThrow(() => {
    result = renderReports(model)
  })
  for (const key of MARKDOWN_KEYS) assert.equal(typeof result.files[key], 'string')
  assert.doesNotThrow(() => JSON.stringify(result.files.json))
})
