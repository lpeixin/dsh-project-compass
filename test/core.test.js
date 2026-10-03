/**
 * 核心层单测：util / ir / graph / flows / validate / cache / llm。
 *
 * 这些测试**不触网、不依赖 DSH 宿主**，全部用合成数据，因此可以在任何 CI 里跑。
 *
 * @module test/core.test
 */

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cite, clip, compileGlob, countLines, decodeText, hashContent, isBinarySample, jsonSafe, mapLimit,
  matchGlob, matchIgnoreRules, mermaidSafe, percentile, splitIdentifier, stableStringify, tokenize, toPosix,
} from '../lib/util.js'
import { absPath, isInside, moduleIdOf, relPath, reportPaths } from '../lib/paths.js'
import { cacheKey, createCache, diffFiles, PARSER_VERSION } from '../lib/cache.js'
import { buildIR, fileKindOf, IR_SCHEMA_VERSION, summarizeProfile, validateIR } from '../lib/ir.js'
import { buildGraphs, detectCycles } from '../lib/graph.js'
import { detectFlows, flowDiagram } from '../lib/flows.js'
import { createValidator } from '../lib/validate.js'
import { createLlmClient, extractJson, LLM_ERROR } from '../lib/llm.js'

/* ------------------------------------------------------------------ *
 * util
 * ------------------------------------------------------------------ */

test('util：标识符拆分与分词对 camelCase / snake_case 都成立', () => {
  assert.deepEqual(splitIdentifier('getUserByID'), ['get', 'user', 'by', 'id'])
  assert.deepEqual(splitIdentifier('HTTPResponse_parser'), ['http', 'response', 'parser'])
  const tokens = tokenize('const userProfile = await loadUserProfile(id)')
  assert.ok(tokens.includes('user'))
  assert.ok(tokens.includes('profile'))
  assert.ok(tokens.includes('load'))
  assert.ok(!tokens.includes('const'), '停用词应被过滤')
})

test('util：glob 与忽略规则（含取反、目录语义）', () => {
  assert.equal(matchGlob('node_modules', 'node_modules/react/index.js'), true)
  assert.equal(matchGlob('*.md', 'docs/readme.md'), true)
  assert.equal(matchGlob('docs/*.md', 'docs/a/b.md'), false)
  assert.equal(matchGlob('**/*.test.js', 'src/a/b.test.js'), true)
  assert.equal(matchGlob('{src,lib}/index.js', 'lib/index.js'), true)
  assert.equal(compileGlob('a?c.js').test('abc.js'), true)

  const rules = ['dist/', '*.log', '!keep.log']
  assert.equal(matchIgnoreRules('dist/main.js', rules), true)
  assert.equal(matchIgnoreRules('logs/app.log', rules), true)
  assert.equal(matchIgnoreRules('keep.log', rules), false, '后出现的取反规则应生效')
})

test('util：hashContent 稳定且对内容敏感', () => {
  assert.equal(hashContent('hello'), hashContent('hello'))
  assert.notEqual(hashContent('hello'), hashContent('hello '))
  assert.match(hashContent('x'), /^[0-9a-f]{16}$/)
})

test('util：jsonSafe 清洗非 JSON 值并断开环', () => {
  const cyclic = { name: 'a', n: Number.NaN, u: undefined, fn: () => 1, date: new Date(0), big: 10n }
  cyclic.self = cyclic
  const clean = jsonSafe(cyclic)
  assert.equal(clean.name, 'a')
  assert.equal(clean.n, null)
  assert.equal('u' in clean, false)
  assert.equal('fn' in clean, false)
  assert.equal(clean.date, '1970-01-01T00:00:00.000Z')
  assert.equal(clean.big, '10')
  assert.equal(clean.self, '[circular]')
  assert.doesNotThrow(() => JSON.stringify(clean))
})

test('util：文本工具与稳定序列化', () => {
  assert.equal(countLines('a\nb\nc'), 3)
  assert.equal(countLines('a\nb\n'), 2)
  assert.equal(countLines(''), 0)
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 'a', 'BOM 应被去掉')
  assert.equal(isBinarySample(new Uint8Array([1, 2, 0, 4])), true)
  assert.equal(isBinarySample(new Uint8Array([1, 2, 3, 4])), false)
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(clip('abcdef', 4), 'abc…')
  assert.equal(toPosix('a\\b'), 'a/b')
  assert.equal(moduleIdOf('src/a/b.ts'), 'src/a')
  assert.equal(moduleIdOf('index.js'), '.')
  assert.equal(isInside('/p', '/p/a'), true)
  assert.equal(isInside('/p', '/other'), false)
  assert.equal(relPath('/p', '/p/src/a.ts'), 'src/a.ts')
  assert.equal(absPath('/p', 'src/a.ts'), '/p/src/a.ts')
  assert.equal(reportPaths('/p', undefined).onboarding, '/p/docs/project-compass/ONBOARDING.md')
  assert.equal(reportPaths('/p', 'out').json, '/p/out/project-compass.json')
})

test('util：mapLimit 保序、隔离错误、遵守并发上限', async () => {
  let active = 0
  let peak = 0
  const result = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    if (value === 3) throw new Error('boom')
    return value * 2
  })
  assert.deepEqual(result, [2, 4, undefined, 8, 10])
  assert.ok(peak <= 2, `并发峰值应 <= 2，实际 ${peak}`)
})

test('util：证据引用与 Mermaid 文本安全', () => {
  assert.equal(cite('a/b.ts', { line: 3 }).text, 'a/b.ts:3')
  assert.equal(cite('a/b.ts', { symbol: 'run' }).text, 'a/b.ts#run')
  assert.equal(mermaidSafe('a["b"] --> c'), 'a b -- c', '引号/方括号/尖括号必须被清掉')
})

/* ------------------------------------------------------------------ *
 * ir / graph / flows
 * ------------------------------------------------------------------ */

/** 合成一个两模块、三文件的 IR 输入。 */
function sampleFiles() {
  return [
    {
      id: 'src/server.ts',
      language: 'typescript',
      loc: 20,
      bytes: 400,
      hash: 'h1',
      parsed: {
        symbols: [
          { name: 'createServer', kind: 'function', line: 3, endLine: 12, exported: true },
          { name: 'handleLogin', kind: 'function', line: 14, endLine: 18, exported: false },
        ],
        imports: [{ specifier: './auth', names: ['login'], line: 1 }],
        calls: [
          { calleeName: 'login', line: 15, fromSymbolName: 'handleLogin' },
          { calleeName: 'console.log', line: 16, fromSymbolName: 'handleLogin' },
          { calleeName: 'mystery', line: 17, fromSymbolName: 'handleLogin' },
        ],
        routes: [{ method: 'post', path: '/login', line: 5, handlerName: 'handleLogin', framework: 'express' }],
        exports: ['createServer'],
        todos: [{ line: 9, text: 'TODO: rate limit', kind: 'todo' }],
      },
    },
    {
      id: 'src/auth.ts',
      language: 'typescript',
      loc: 30,
      bytes: 600,
      hash: 'h2',
      parsed: {
        symbols: [{ name: 'login', kind: 'function', line: 4, endLine: 29, exported: true }],
        imports: [{ specifier: 'jsonwebtoken', names: ['jwt'], line: 2 }],
        calls: [{ calleeName: 'jwt.sign', line: 6, receiver: 'jwt', fromSymbolName: 'login' }],
        routes: [],
        exports: ['login'],
        todos: [],
      },
    },
    {
      id: 'test/server.test.ts',
      language: 'typescript',
      loc: 10,
      bytes: 200,
      hash: 'h3',
      parsed: {
        symbols: [{ name: 'loginSpec', kind: 'function', line: 3, endLine: 9, exported: false }],
        imports: [],
        calls: [],
        routes: [],
        exports: [],
        todos: [],
      },
    },
  ]
}

function sampleIR(overrides = {}) {
  return buildIR({
    root: '/demo',
    name: 'demo',
    files: sampleFiles(),
    profile: {
      name: 'demo',
      entrypoints: [{ path: 'src/server.ts', kind: 'main' }],
      size: { files: 3, dirs: 2, bytes: 1200, sourceFiles: 2, skipped: 0, truncated: false },
    },
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  })
}

test('ir：文件分类覆盖测试/配置/文档/基础设施/生成物', () => {
  assert.equal(fileKindOf('src/a.ts', 'typescript'), 'source')
  assert.equal(fileKindOf('test/a.test.ts', 'typescript'), 'test')
  assert.equal(fileKindOf('src/a.spec.js', 'javascript'), 'test')
  assert.equal(fileKindOf('package.json', 'json'), 'config')
  assert.equal(fileKindOf('README.md', 'markdown'), 'docs')
  assert.equal(fileKindOf('Dockerfile', 'text'), 'infra')
  assert.equal(fileKindOf('.github/workflows/ci.yml', 'yaml'), 'infra')
  assert.equal(fileKindOf('src/a.min.js', 'javascript'), 'generated')
  assert.equal(fileKindOf('src/logo.svg', 'text'), 'asset')
})

test('ir：装配出的 IR 结构自洽（validateIR 无问题）', () => {
  const ir = sampleIR()
  assert.equal(ir.schemaVersion, IR_SCHEMA_VERSION)
  assert.deepEqual(validateIR(ir), [])
  assert.equal(ir.stats.files, 3)
  assert.equal(ir.stats.modules, 2, 'src 与 test 是两个模块')
  assert.equal(ir.stats.routes, 1)
  assert.equal(ir.stats.unresolvedCalls, 2, 'mystery 与外部 jwt.sign 都无法绑定到项目内符号')
  assert.equal(ir.stats.externalImports, 1)
})

test('ir：导入解析区分相对路径与外部包，并抽对包名', () => {
  const ir = sampleIR()
  const relative = ir.imports.find((record) => record.specifier === './auth')
  assert.equal(relative.target, 'src/auth.ts')
  assert.equal(relative.resolved, true)
  assert.equal(relative.targetModule, 'src')

  const external = ir.imports.find((record) => record.specifier === 'jsonwebtoken')
  assert.equal(external.target, null)
  assert.equal(external.external, true)
  assert.equal(external.packageName, 'jsonwebtoken')
})

test('ir：调用绑定遵守 same-file / import / global / unresolved 四级，且不猜测', () => {
  const ir = sampleIR()
  const byName = new Map(ir.calls.map((call) => [call.calleeName, call]))

  const imported = byName.get('login')
  assert.equal(imported.resolution, 'import')
  assert.equal(imported.toSymbolId, 'src/auth.ts#login@4')

  const globalCall = byName.get('console.log')
  assert.equal(globalCall.resolution, 'global')
  assert.equal(globalCall.toSymbolId, null)

  const unknown = byName.get('mystery')
  assert.equal(unknown.resolution, 'unresolved')
  assert.equal(unknown.toSymbolId, null, '未解析调用不允许有绑定目标')

  const external = byName.get('jwt.sign')
  assert.equal(external.toSymbolId, null)
  assert.equal(external.external, true)
})

test('ir：路由绑定到处理器符号并保留中间件与框架', () => {
  const ir = sampleIR()
  const route = ir.routes[0]
  assert.equal(route.method, 'POST')
  assert.equal(route.path, '/login')
  assert.equal(route.framework, 'express')
  assert.equal(route.handlerSymbolId, 'src/server.ts#handleLogin@14')
})

test('ir：模块聚合出依赖关系、kind 与"无测试"提示', () => {
  const ir = sampleIR()
  const src = ir.modules.find((module) => module.id === 'src')
  const testModule = ir.modules.find((module) => module.id === 'test')
  assert.equal(src.kind, 'source')
  assert.equal(testModule.kind, 'test')
  assert.equal(src.language, 'typescript')
  assert.ok(src.notes.includes('该模块没有测试文件'))
  assert.equal(src.symbolCount, 3)
})

test('ir：同一输入两次装配结果逐字节一致（幂等）', () => {
  const a = sampleIR()
  const b = sampleIR()
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

test('ir：模块级依赖边来自跨模块 import', () => {
  const ir = sampleIR({
    files: [
      {
        id: 'src/index.ts',
        language: 'typescript',
        loc: 3,
        parsed: { symbols: [], imports: [{ specifier: '../lib/util', names: ['a'], line: 1 }], calls: [], routes: [], exports: [], todos: [] },
      },
      {
        id: 'lib/util.ts',
        language: 'typescript',
        loc: 3,
        parsed: { symbols: [{ name: 'a', kind: 'function', line: 1, endLine: 1 }], imports: [], calls: [], routes: [], exports: [], todos: [] },
      },
    ],
  })
  const src = ir.modules.find((module) => module.id === 'src')
  const lib = ir.modules.find((module) => module.id === 'lib')
  assert.deepEqual(src.dependsOn, ['lib'])
  assert.deepEqual(lib.dependedOnBy, ['src'])
})

test('ir：Python 包路径与 Java 点分导入都能落到项目内文件', () => {
  const ir = buildIR({
    root: '/demo',
    files: [
      {
        id: 'app/main.py',
        language: 'python',
        loc: 5,
        parsed: { symbols: [], imports: [{ specifier: 'app.services.user', names: ['get_user'], line: 1 }], calls: [], routes: [], exports: [], todos: [] },
      },
      {
        id: 'app/services/user.py',
        language: 'python',
        loc: 5,
        parsed: { symbols: [{ name: 'get_user', kind: 'function', line: 1, endLine: 3, exported: true }], imports: [], calls: [], routes: [], exports: [], todos: [] },
      },
      {
        id: 'src/main/java/com/demo/App.java',
        language: 'java',
        loc: 5,
        parsed: { symbols: [], imports: [{ specifier: 'com.demo.Service', names: ['Service'], line: 1 }], calls: [], routes: [], exports: [], todos: [] },
      },
      {
        id: 'src/main/java/com/demo/Service.java',
        language: 'java',
        loc: 5,
        parsed: { symbols: [{ name: 'Service', kind: 'class', line: 1, endLine: 5, exported: true }], imports: [], calls: [], routes: [], exports: [], todos: [] },
      },
    ],
  })
  const pythonImport = ir.imports.find((record) => record.specifier === 'app.services.user')
  assert.equal(pythonImport.target, 'app/services/user.py')
  const javaImport = ir.imports.find((record) => record.specifier === 'com.demo.Service')
  assert.equal(javaImport.target, 'src/main/java/com/demo/Service.java')
})

test('ir：validateIR 能报出被破坏的结构', () => {
  const ir = sampleIR()
  ir.symbols.push({ ...ir.symbols[0] })
  ir.calls.push({ id: 'x', fileId: 'src/server.ts', moduleId: 'src', line: 1, calleeName: 'x', resolution: 'unresolved', toSymbolId: 'ghost#x@1', fromSymbolId: null, external: false, kind: 'call', receiver: null })
  const problems = validateIR(ir)
  assert.ok(problems.some((problem) => problem.includes('id 重复')))
  assert.ok(problems.some((problem) => problem.includes('不存在的符号')))
  assert.ok(problems.some((problem) => problem.includes('unresolved 调用却带绑定')))

  assert.deepEqual(validateIR(null), ['IR 为空'])
})

test('ir：summarizeProfile 对缺失画像安全', () => {
  assert.equal(summarizeProfile(undefined), null)
  const summary = summarizeProfile({ name: 'x', kinds: ['cli'] })
  assert.equal(summary.name, 'x')
  assert.deepEqual(summary.tests.frameworks, [])
  assert.deepEqual(summary.signals.todos, [])
})

/* ------------------------------------------------------------------ *
 * graph
 * ------------------------------------------------------------------ */

test('graph：环检测找到强连通分量并忽略自环噪声', () => {
  const nodes = ['a', 'b', 'c', 'd']
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'a' },
    { from: 'c', to: 'd' },
  ]
  const cycles = detectCycles(nodes, edges, 10)
  assert.equal(cycles.length, 1)
  assert.deepEqual(cycles[0], ['a', 'b', 'c'])
})

test('graph：三张图与度量对合成 IR 全部可用', () => {
  const ir = sampleIR()
  const graph = buildGraphs(ir)
  assert.equal(graph.stats.fileNodes, 3)
  assert.equal(graph.stats.fileEdges, 1, 'src/server.ts -> src/auth.ts')
  assert.ok(graph.stats.moduleNodes === 2)
  assert.equal(graph.stats.symbolNodes, 2, '只有 handleLogin 与 login 参与了已解析调用')
  assert.equal(graph.stats.truncatedSymbols, 0)
  assert.equal(graph.metrics.entryReach['src/server.ts'], true)
  assert.equal(graph.metrics.entryReach['src/auth.ts'], true, '入口能到达 auth')
  assert.ok(graph.metrics.hubs.length > 0)
  assert.ok(graph.metrics.riskModules.some((entry) => entry.id === 'src'))
})

test('graph：跨模块环会被记录到 metrics/cycles', () => {
  const files = ['a', 'b'].map((name, index) => ({
    id: `${name}/x.ts`,
    language: 'typescript',
    loc: 3,
    parsed: {
      symbols: [],
      imports: [{ specifier: index === 0 ? '../b/x' : '../a/x', names: ['v'], line: 1 }],
      calls: [],
      routes: [],
      exports: [],
      todos: [],
    },
  }))
  const ir = buildIR({ root: '/demo', files })
  const graph = buildGraphs(ir)
  assert.equal(graph.stats.moduleCycles, 1)
  assert.deepEqual(graph.module.cycles[0], ['a', 'b'])
  const risk = graph.metrics.riskModules.find((entry) => entry.id === 'a')
  assert.ok(risk.reasons.includes('位于依赖环上'))
})

test('graph：孤立文件被识别（排除入口与配置类）', () => {
  const ir = buildIR({
    root: '/demo',
    files: [
      { id: 'src/alone.ts', language: 'typescript', loc: 2, parsed: { symbols: [{ name: 'x', kind: 'function', line: 1, endLine: 2 }], imports: [], calls: [], routes: [], exports: [], todos: [] } },
      { id: 'README.md', language: 'markdown', loc: 2, parsed: { symbols: [], imports: [], calls: [], routes: [], exports: [], todos: [] } },
    ],
  })
  const graph = buildGraphs(ir)
  assert.deepEqual(graph.metrics.orphans, ['src/alone.ts'])
})

/* ------------------------------------------------------------------ *
 * flows
 * ------------------------------------------------------------------ */

test('flows：路由流程沿已解析调用链展开并给出证据', () => {
  const ir = sampleIR()
  ir.graph = buildGraphs(ir)
  const flows = detectFlows(ir)
  const http = flows.find((flow) => flow.kind === 'http')
  assert.ok(http !== undefined, '应识别出 HTTP 流程')
  assert.equal(http.entry.fileId, 'src/server.ts')
  assert.ok(http.steps.length >= 2)
  assert.equal(http.steps[0].kind, 'entry')
  assert.ok(http.evidence.every((item) => /:\d+$/.test(item)))
  assert.ok(['high', 'medium', 'low'].includes(http.confidence))
  assert.doesNotThrow(() => flowDiagram(http))
})

test('flows：处理器未解析时置信度低且给出解释，不编造步骤', () => {
  const ir = buildIR({
    root: '/demo',
    files: [
      {
        id: 'src/routes.ts',
        language: 'typescript',
        loc: 5,
        parsed: { symbols: [], imports: [], calls: [], routes: [{ method: 'GET', path: '/x', line: 2, handlerName: 'notHere', framework: 'express' }], exports: [], todos: [] },
      },
    ],
  })
  ir.graph = buildGraphs(ir)
  const flows = detectFlows(ir)
  const http = flows.find((flow) => flow.kind === 'http')
  assert.equal(http.confidence, 'low')
  assert.equal(http.steps.length, 1)
  assert.ok(http.notes.some((note) => note.includes('未在项目内解析到符号')))
})

test('flows：没有路由的库项目仍能识别公开 API 流程', () => {
  const ir = buildIR({
    root: '/demo',
    files: [
      {
        id: 'src/api.ts',
        language: 'typescript',
        loc: 20,
        parsed: {
          symbols: [
            { name: 'publicApi', kind: 'function', line: 1, endLine: 5, exported: true },
            { name: 'internal', kind: 'function', line: 7, endLine: 9, exported: false },
          ],
          imports: [],
          calls: [{ calleeName: 'internal', line: 2, fromSymbolName: 'publicApi' }],
          routes: [],
          exports: ['publicApi'],
          todos: [],
        },
      },
    ],
  })
  ir.graph = buildGraphs(ir)
  const flows = detectFlows(ir)
  assert.ok(flows.some((flow) => flow.kind === 'library' && flow.entry.symbolName === 'publicApi'))
})

test('flows：空 IR 不抛错', () => {
  assert.deepEqual(detectFlows(undefined), [])
  assert.deepEqual(detectFlows({ files: [], symbols: [], calls: [], routes: [] }), [])
})

/* ------------------------------------------------------------------ *
 * validate
 * ------------------------------------------------------------------ */

test('validate：行号越界与不存在的路径都会被拦下', () => {
  const ir = sampleIR()
  const validator = createValidator(ir)
  assert.equal(validator.checkCitation({ path: 'src/server.ts', line: 5 }).ok, true)
  assert.equal(validator.checkCitation({ path: 'src/server.ts', line: 999 }).ok, false)
  assert.equal(validator.checkCitation({ path: 'src/ghost.ts', line: 1 }).ok, false)
  assert.equal(validator.checkCitation({ path: 'src/server.ts', symbol: 'handleLogin' }).ok, true)
  assert.equal(validator.checkCitation({ path: 'src/server.ts', symbol: 'ghost' }).ok, false)
})

test('validate：checkText 抽取引用并报告被丢弃的声明', () => {
  const ir = sampleIR()
  const validator = createValidator(ir)
  const report = validator.checkText('入口在 `src/server.ts:3`，登录逻辑在 `src/auth.ts:4`，还有一处 `src/nope.ts:1`。')
  assert.equal(report.ok, false)
  assert.equal(report.valid, 2)
  assert.deepEqual(report.unknownPaths, ['src/nope.ts'])
  assert.ok(report.dropped.length >= 1)
  assert.equal(validator.stats().checkedTexts, 1)
})

test('validate：checkClaims 丢弃无引用与引用错误的断言', () => {
  const ir = sampleIR()
  const validator = createValidator(ir)
  const { kept, dropped, report } = validator.checkClaims([
    { text: '入口函数是 createServer', citations: [{ path: 'src/server.ts', line: 3, symbol: 'createServer' }] },
    { text: '凭空断言', citations: [] },
    { text: '错误引用', citations: [{ path: 'src/ghost.ts', line: 1 }] },
  ])
  assert.equal(kept.length, 1)
  assert.equal(kept[0].citations[0].text, 'src/server.ts:3#createServer')
  assert.equal(dropped.length, 2)
  assert.equal(report.kept, 1)
})

test('validate：sanitizeText 只删掉含错引用的句子', () => {
  const ir = sampleIR()
  const validator = createValidator(ir)
  const { text, dropped } = validator.sanitizeText('入口在 src/server.ts:3。这里有假引用 src/fake.ts:1。结尾在 src/auth.ts:4。')
  assert.ok(text.includes('src/server.ts:3'))
  assert.ok(text.includes('src/auth.ts:4'))
  assert.ok(!text.includes('src/fake.ts'))
  assert.equal(dropped.length, 1)
})

/* ------------------------------------------------------------------ *
 * cache
 * ------------------------------------------------------------------ */

test('cache：键随内容/语言/解析器版本变化', () => {
  const base = { hash: 'h', language: 'typescript', parserVersion: PARSER_VERSION }
  assert.equal(cacheKey(base), cacheKey({ ...base }))
  assert.notEqual(cacheKey(base), cacheKey({ ...base, hash: 'h2' }))
  assert.notEqual(cacheKey(base), cacheKey({ ...base, language: 'python' }))
  assert.notEqual(cacheKey(base), cacheKey({ ...base, parserVersion: PARSER_VERSION + 1 }))
})

test('cache：往返命中、内容变化即未命中、可剪枝', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compass-cache-'))
  try {
    const cache = await createCache(root)
    const parsed = { symbols: [{ name: 'a', kind: 'function', line: 1, endLine: 1 }], imports: [], calls: [], routes: [], exports: [], todos: [] }
    assert.equal(await cache.get('src/a.ts', 'h1', 'typescript'), undefined)
    assert.equal(await cache.put('src/a.ts', 'h1', 'typescript', parsed), true)
    assert.deepEqual(await cache.get('src/a.ts', 'h1', 'typescript'), parsed)
    assert.equal(await cache.get('src/a.ts', 'h2', 'typescript'), undefined, '内容变了必须重算')
    assert.equal(await cache.get('src/a.ts', 'h1', 'python'), undefined, '语言变了必须重算')

    const key = cacheKey({ hash: 'h1', language: 'typescript', parserVersion: PARSER_VERSION })
    assert.equal(await cache.prune([key]), 0, '命中的键应被保留')
    assert.equal(await cache.prune([]), 1, '不在保留集合里的条目应被删除')
    const stats = cache.stats()
    assert.ok(stats.hits >= 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cache：损坏的缓存文件不影响使用', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compass-cache-bad-'))
  try {
    const { writeTextFile } = await import('../lib/store.js')
    const { cacheEntryFile } = await import('../lib/paths.js')
    const key = cacheKey({ hash: 'h9', language: 'typescript', parserVersion: PARSER_VERSION })
    await writeTextFile(cacheEntryFile(root, key), '{ 这不是 JSON')
    const cache = await createCache(root)
    assert.equal(await cache.get('src/a.ts', 'h9', 'typescript'), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cache：diffFiles 分类出新增/变更/删除/未变', () => {
  const ir = { files: [{ id: 'a.ts', hash: '1' }, { id: 'b.ts', hash: '2' }, { id: 'gone.ts', hash: '3' }] }
  const diff = diffFiles(ir, [{ id: 'a.ts', hash: '1' }, { id: 'b.ts', hash: '9' }, { id: 'c.ts', hash: '4' }])
  assert.deepEqual(diff.unchanged, ['a.ts'])
  assert.deepEqual(diff.changed, ['b.ts'])
  assert.deepEqual(diff.added, ['c.ts'])
  assert.deepEqual(diff.removed, ['gone.ts'])
})

/* ------------------------------------------------------------------ *
 * llm（无宿主降级路径）
 * ------------------------------------------------------------------ */

/** 造一个假的宿主上下文：只实现插件真正会用到的两个服务。 */
function fakeCtx(chunks, selection = { provider: 'p', model: 'm' }) {
  const stream = () => (async function* generate() {
    for (const chunk of chunks) yield chunk
  })()
  return {
    get: (name) => (name === 'llm' ? { stream } : undefined),
    agentDefaultModel: { currentSelection: () => selection },
  }
}

test('llm：没有宿主服务时不可用且说明原因，调用抛带码的错误', async () => {
  const client = createLlmClient(undefined, {})
  assert.equal(client.available(), false)
  assert.match(client.describe().reason, /未挂载 llm/)
  await assert.rejects(
    () => client.complete({ prompt: 'hi' }),
    (error) => error.code === LLM_ERROR.UNAVAILABLE,
  )
})

test('llm：配置关闭时即使宿主存在也不可用', () => {
  const client = createLlmClient(fakeCtx([]), { enabled: false })
  assert.equal(client.available(), false)
  assert.match(client.describe().reason, /已关闭/)
})

test('llm：extractJson 容错解析围栏/废话/尾逗号', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('好的，结果如下：{"a":1,}'), { a: 1 })
  assert.deepEqual(extractJson('[{"a":1}]'), [{ a: 1 }])
  assert.equal(extractJson('完全没有 JSON'), undefined)
  assert.equal(extractJson(''), undefined)
})

test('llm：从宿主流式分片汇总文本与用量', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '你好' },
    { type: 'text-delta', index: 0, text: '，世界' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const client = createLlmClient(fakeCtx(chunks), {})
  assert.equal(client.available(), true)
  const result = await client.complete({ system: 's', prompt: 'p' })
  assert.equal(result.text, '你好，世界')
  assert.equal(result.provider, 'p')
  assert.equal(result.usage.outputTokens, 5)
  assert.equal(client.stats().calls, 1)
})

test('llm：block-end 形式的文本同样能被汇总', async () => {
  const chunks = [
    { type: 'block-end', index: 0, block: { type: 'text', text: '来自块的内容' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const client = createLlmClient(fakeCtx(chunks), {})
  const result = await client.complete({ prompt: 'p' })
  assert.equal(result.text, '来自块的内容')
})

test('llm：达到调用上限后不再可用（预算护栏）', async () => {
  const client = createLlmClient(fakeCtx([
    { type: 'text-delta', text: 'x' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), { maxCalls: 1 })
  await client.complete({ prompt: 'one' })
  assert.equal(client.available(), false)
  assert.match(client.describe().reason, /上限/)
  await assert.rejects(
    () => client.complete({ prompt: 'two' }),
    (error) => error.code === LLM_ERROR.BUDGET || error.code === LLM_ERROR.UNAVAILABLE,
  )
})

test('llm：模型返回错误结束原因时抛 LLM_FAILED', async () => {
  const client = createLlmClient(fakeCtx([
    { type: 'finish', reason: { kind: 'error', failure: { message: '上游 500' } } },
  ]), {})
  await assert.rejects(
    () => client.complete({ prompt: 'x' }),
    (error) => error.code === LLM_ERROR.FAILED && /上游 500/.test(error.message),
  )
})

test('llm：空内容视为失败，避免把空摘要写进报告', async () => {
  const client = createLlmClient(fakeCtx([{ type: 'finish', reason: { kind: 'stop' } }]), {})
  await assert.rejects(() => client.complete({ prompt: 'x' }), (error) => error.code === LLM_ERROR.FAILED)
})
