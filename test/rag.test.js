/**
 * FR7 检索层单测：embed / chunk / rag。
 *
 * 全部使用自造的小型 IR，不读真实项目、不联网、不依赖 DSH 宿主。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { chunkFile, chunkIR } from '../lib/chunk.js'
import { EMBED_DIM, cosine, embed, embedDerived, embedTexts, vectorFromDerived } from '../lib/embed.js'
import { indexFile } from '../lib/paths.js'
import { answer, buildIndex, indexStats, loadIndex, saveIndex, searchIndex, updateIndex } from '../lib/rag.js'

/* ------------------------------------------------------------------ *
 * 测试夹具：手写 IR + 源码
 * ------------------------------------------------------------------ */

const AUTH_SOURCE = [
  "import { findUser, signToken, hashPassword, revokeSession } from './user.js'", // 1
  '', // 2
  '/**', // 3
  ' * 用户登录：校验凭据并签发会话。', // 4
  ' */', // 5
  'export function login(username, password) {', // 6
  '  const user = findUser(username)', // 7
  '  if (!user) return null', // 8
  '  if (user.password !== hashPassword(password)) return null', // 9
  '  return { token: signToken(user.id) }', // 10
  '}', // 11
  '', // 12
  'export function logout(sessionId) {', // 13
  '  return revokeSession(sessionId)', // 14
  '}', // 15
].join('\n')

const USER_SOURCE = [
  "import { db } from './db.js'", // 1
  '', // 2
  '/** 按主键查询用户。 */', // 3
  'export function getUserById(id) {', // 4
  '  return db.users.find((item) => item.id === id)', // 5
  '}', // 6
  '', // 7
  "export const USER_TABLE = 'users'", // 8
  '', // 9
  'export function listUsers(limit = 20) {', // 10
  '  return db.users.slice(0, limit)', // 11
  '}', // 12
].join('\n')

const EMPTY_SOURCE = ['// 没有可解析符号的模块', 'export default null'].join('\n')

const CONFIG_SOURCE = [
  '{',
  '  "name": "demo",',
  '  "version": "1.0.0",',
  '  "type": "module",',
  '  "scripts": {',
  '    "test": "node --test"',
  '  },',
  '  "dependencies": {}',
  '}',
].join('\n')

const DOC_LINES = Array.from({ length: 250 }, (_, i) => `## Section ${i + 1}: project compass notes`)
const DOC_SOURCE = DOC_LINES.join('\n')

const SOURCES = {
  'src/auth.js': AUTH_SOURCE,
  'src/user.js': USER_SOURCE,
  'src/empty.js': EMPTY_SOURCE,
  'package.json': CONFIG_SOURCE,
  'README.md': DOC_SOURCE,
}

function readText(fileId) {
  return SOURCES[fileId]
}

function makeSymbol(fileId, name, kind, line, endLine, extra = {}) {
  const slash = fileId.lastIndexOf('/')
  return {
    id: `${fileId}#${name}@${line}`,
    fileId,
    moduleId: slash > 0 ? fileId.slice(0, slash) : '.',
    name,
    kind,
    line,
    endLine,
    exported: extra.exported !== false,
    parent: null,
    signature: extra.signature ?? null,
    doc: extra.doc ?? null,
    loc: endLine - line + 1,
    fanIn: 0,
    fanOut: 0,
    risk: 'low',
  }
}

function makeFile(id, moduleId, language, kind, loc, hash, symbols) {
  return {
    id,
    moduleId,
    language,
    kind,
    loc,
    bytes: loc * 30,
    hash,
    symbols: symbols.map((symbol) => symbol.id),
    imports: [],
    calls: [],
    routes: [],
    exports: symbols.map((symbol) => symbol.name),
    todos: [],
    parse: kind === 'source' ? 'deep' : 'light',
    warnings: [],
  }
}

const LOGIN = makeSymbol('src/auth.js', 'login', 'function', 6, 11, {
  signature: 'login(username, password)',
  doc: '用户登录：校验凭据并签发会话。',
})
const LOGOUT = makeSymbol('src/auth.js', 'logout', 'function', 13, 15, { signature: 'logout(sessionId)' })
const GET_USER = makeSymbol('src/user.js', 'getUserById', 'function', 4, 6, { signature: 'getUserById(id)' })
const USER_TABLE = makeSymbol('src/user.js', 'USER_TABLE', 'const', 8, 8)
const LIST_USERS = makeSymbol('src/user.js', 'listUsers', 'function', 10, 12, { signature: 'listUsers(limit)' })

function makeIr() {
  const files = [
    makeFile('src/auth.js', 'src', 'javascript', 'source', 15, 'hash-auth', [LOGIN, LOGOUT]),
    makeFile('src/user.js', 'src', 'javascript', 'source', 12, 'hash-user', [GET_USER, USER_TABLE, LIST_USERS]),
    makeFile('src/empty.js', 'src', 'javascript', 'source', 2, 'hash-empty', []),
    makeFile('package.json', '.', 'json', 'config', 9, 'hash-config', []),
    makeFile('README.md', '.', 'markdown', 'docs', 250, 'hash-doc', []),
  ]
  return {
    schemaVersion: 1,
    root: '/virtual/demo',
    name: 'demo',
    generatedAt: '2024-01-01T00:00:00.000Z',
    profileSummary: { kinds: ['library'], ecosystems: [], commands: [], entrypoints: [], tests: [], signals: {} },
    modules: [
      {
        id: 'src',
        name: 'src',
        dir: 'src',
        language: 'javascript',
        kind: 'source',
        files: ['src/auth.js', 'src/user.js', 'src/empty.js'],
        loc: 29,
        symbolCount: 5,
        entrypoints: [],
        dependsOn: [],
        dependedOnBy: [],
        risk: 'low',
        notes: [],
      },
    ],
    files,
    symbols: [LOGIN, LOGOUT, GET_USER, USER_TABLE, LIST_USERS],
    imports: [],
    calls: [],
    routes: [],
    graph: { module: { nodes: [], edges: [], cycles: [] }, file: { nodes: [], edges: [], cycles: [] }, symbol: { nodes: [], edges: [], cycles: [] }, metrics: {}, stats: {} },
    flows: [
      {
        id: 'flow:login',
        name: '用户登录流程',
        kind: 'http',
        entry: { fileId: 'src/auth.js', line: 6, symbolId: LOGIN.id, symbolName: 'login', label: 'POST /login' },
        steps: [
          { order: 1, fileId: 'src/user.js', line: 4, symbolId: GET_USER.id, symbolName: 'getUserById', kind: 'call', via: 'findUser' },
        ],
        evidence: ['src/auth.js:6'],
        confidence: 'medium',
        notes: [],
      },
    ],
    stats: { modules: 1, files: 5, sourceFiles: 3, symbols: 5, imports: 0, calls: 0, routes: 0, loc: 277, languages: ['javascript', 'json', 'markdown'] },
    warnings: [],
    truncated: false,
    budget: { filesAnalyzed: 5, filesSkipped: 0, bytesRead: 1000, durationMs: 1, llmCalls: 0 },
  }
}

const IR = makeIr()

/* ------------------------------------------------------------------ *
 * 证据闸门夹具：含中文 README 的订单服务
 * （用于验证"无关问题不得给高置信度"这一核心承诺）
 * ------------------------------------------------------------------ */

const ORDER_SOURCE = [
  "import { validate } from './validate.js'", // 1
  '', // 2
  '/**', // 3
  ' * 创建订单并返回持久化结果。', // 4
  ' */', // 5
  'export function createOrder(input) {', // 6
  '  const clean = validate(input)', // 7
  "  return { id: 'order-1', ...clean, status: 'created' }", // 8
  '}', // 9
  '', // 10
  '/** 取消订单 */', // 11
  'export function cancelOrder(id) {', // 12
  "  return { id, status: 'cancelled' }", // 13
  '}', // 14
].join('\n')

// README 里刻意放入「的 / 与 / 在」这些高频字：它们 df>0，但不得被当成证据。
const ORDER_README = [
  '# 订单服务', // 1
  '', // 2
  '订单服务示例：订单的创建与查询都在这里，先用 validate 校验再落库。', // 3
  '', // 4
  '## 运行', // 5
  '', // 6
  'npm start', // 7
].join('\n')

const CI_SOURCE = [
  'name: ci', // 1
  'on: [push]', // 2
  'jobs:', // 3
  '  test:', // 4
  '    runs-on: ubuntu-latest', // 5
  '    steps:', // 6
  '      - uses: actions/checkout@v4', // 7
  '      - run: node --test', // 8
].join('\n')

const ORDER_SOURCES = {
  'src/order.js': ORDER_SOURCE,
  'README.md': ORDER_README,
  '.github/workflows/ci.yml': CI_SOURCE,
}

function readOrderText(fileId) {
  return ORDER_SOURCES[fileId]
}

const CREATE_ORDER = makeSymbol('src/order.js', 'createOrder', 'function', 6, 9, {
  signature: 'createOrder(input)',
  doc: '创建订单并返回持久化结果。',
})
const CANCEL_ORDER = makeSymbol('src/order.js', 'cancelOrder', 'function', 12, 14, { doc: '取消订单' })

function makeOrderIr() {
  return {
    schemaVersion: 1,
    root: '/virtual/orders',
    name: 'orders',
    generatedAt: '2024-01-01T00:00:00.000Z',
    modules: [],
    files: [
      makeFile('src/order.js', 'src', 'javascript', 'source', 14, 'hash-order', [CREATE_ORDER, CANCEL_ORDER]),
      makeFile('README.md', '.', 'markdown', 'docs', 7, 'hash-readme', []),
      makeFile('.github/workflows/ci.yml', '.github/workflows', 'yaml', 'config', 8, 'hash-ci', []),
    ],
    symbols: [CREATE_ORDER, CANCEL_ORDER],
    imports: [],
    calls: [],
    routes: [],
    graph: {},
    flows: [],
    stats: { modules: 0, files: 3, sourceFiles: 1, symbols: 2, imports: 0, calls: 0, routes: 0, loc: 29, languages: ['javascript', 'markdown', 'yaml'] },
    warnings: [],
    truncated: false,
    budget: {},
  }
}

/* ------------------------------------------------------------------ *
 * embed
 * ------------------------------------------------------------------ */

test('embed：维度正确、L2 归一化、同一文本可重现', () => {
  const a = embed('getUserById login 用户登录')
  const b = embed('getUserById login 用户登录')
  assert.equal(a.length, EMBED_DIM)
  assert.ok(a instanceof Float64Array)
  assert.deepEqual([...a], [...b], '同一文本两次向量化必须逐位一致')

  let norm = 0
  for (const value of a) norm += value * value
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-9, `模长应≈1，实际 ${Math.sqrt(norm)}`)

  assert.equal(embed('x', 64).length, 64)
  assert.equal(embedDerived('x', 32).values.length, 32)
  assert.equal(embedTexts(['a', 'b']).length, 2)
  assert.ok(embedTexts(['a', 'b'])[0] instanceof Float64Array)

  const zero = embed('')
  assert.equal(cosine(zero, zero), 0, '零向量余弦为 0，不能 NaN')
  assert.equal(cosine(a, null), 0)
})

test('embed：语义相近（含标识符拆分）余弦高于无关文本', () => {
  const near = cosine(embed('getUserById'), embed('get user by id'))
  const far = cosine(embed('getUserById'), embed('database migration schema'))
  assert.ok(near > far, `相近 ${near} 应大于无关 ${far}`)
  assert.ok(near > 0.5, `标识符拆分应带来明显相似度，实际 ${near}`)

  const login = cosine(embed('用户登录 login 密码校验'), embed('用户登录：校验凭据并签发会话'))
  const unrelated = cosine(embed('用户登录 login 密码校验'), embed('数据库迁移 schema 变更'))
  assert.ok(login > unrelated)
})

test('embed：跨进程稳定（子进程结果与当前进程一致）', () => {
  const moduleUrl = new URL('../lib/embed.js', import.meta.url).href
  const script = [
    `import { embed } from ${JSON.stringify(moduleUrl)}`,
    "const v = embed('getUserById login 用户登录', 64)",
    "console.log(Array.from(v).map((x) => x.toFixed(12)).join(','))",
  ].join('\n')
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  const remote = stdout.trim().split(',').map(Number)
  const local = [...embed('getUserById login 用户登录', 64)]
  assert.equal(remote.length, local.length)
  for (let i = 0; i < local.length; i += 1) {
    assert.ok(Math.abs(remote[i] - local[i]) < 1e-12, `第 ${i} 维跨进程不一致：${remote[i]} vs ${local[i]}`)
  }
})

test('embed：embedDerived / vectorFromDerived 往返一致且可 JSON 落盘', () => {
  const derived = embedDerived('用户登录 login getUserById')
  assert.equal(derived.dim, EMBED_DIM)
  assert.equal(derived.values.length, EMBED_DIM)
  assert.ok(derived.values.every((value) => Number.isFinite(value)))

  const restored = vectorFromDerived(derived)
  assert.ok(restored instanceof Float64Array)
  assert.ok(cosine(restored, embed('用户登录 login getUserById')) > 0.999)

  const roundTrip = JSON.parse(JSON.stringify(derived))
  assert.ok(cosine(vectorFromDerived(roundTrip), restored) > 0.999)
  assert.equal(vectorFromDerived(undefined).length, EMBED_DIM)
})

/* ------------------------------------------------------------------ *
 * chunk
 * ------------------------------------------------------------------ */

test('chunk：符号边界、稳定 id、header chunk、config/doc 分块', () => {
  const chunks = chunkIR(IR, { readText })
  assert.ok(chunks.length > 0)
  assert.ok(chunks.every((chunk) => chunk.text.trim().length > 0), '不允许空内容 chunk')

  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  const login = byId.get('src/auth.js:6:symbol')
  assert.ok(login, 'login 符号应有稳定 id')
  assert.equal(login.symbolName, 'login')
  assert.equal(login.symbolKind, 'function')
  assert.equal(login.kind, 'symbol')
  assert.equal(login.startLine, 6)
  assert.equal(login.endLine, 11)
  assert.equal(login.fileId, 'src/auth.js')
  assert.equal(login.moduleId, 'src')
  assert.match(login.text, /export function login/)
  assert.match(login.text, /用户登录/, 'doc 注释应并入 chunk 文本，供中文查询召回')
  assert.ok(login.tokens.includes('login'))
  assert.ok(!login.tokens.includes('function'), 'tokens 来自 util.tokenize（含停用词过滤）')
  assert.match(login.hash, /^[0-9a-f]{16}$/)

  // 顺序与 id 稳定
  assert.deepEqual(chunkIR(IR, { readText }).map((chunk) => chunk.id), chunks.map((chunk) => chunk.id))

  // 无符号文件仍有 header chunk
  const emptyHeader = byId.get('src/empty.js:1:file-header')
  assert.ok(emptyHeader, '无符号文件也要有 file-header chunk')
  assert.ok(emptyHeader.text.trim().length > 0)

  // config 整块 / doc 滑窗
  const configChunks = chunks.filter((chunk) => chunk.fileId === 'package.json' && chunk.kind === 'config')
  assert.ok(configChunks.length >= 1)
  assert.equal(configChunks[0].startLine, 1)

  const docChunks = chunks.filter((chunk) => chunk.fileId === 'README.md' && chunk.kind === 'doc')
  assert.ok(docChunks.length >= 3, `250 行文档应滑窗切块，实际 ${docChunks.length}`)
  assert.equal(docChunks[0].startLine, 1)
  assert.equal(docChunks[docChunks.length - 1].endLine, 250)
  assert.ok(docChunks.every((chunk) => chunk.endLine - chunk.startLine + 1 <= 80), '滑窗不得超过 80 行')
})

test('chunk：无 readText 时退化为结构化摘要，仍非空且可检索', () => {
  const chunks = chunkIR(IR)
  const login = chunks.find((chunk) => chunk.symbolId === LOGIN.id)
  assert.ok(login)
  assert.match(login.text, /login/)
  assert.match(login.text, /src\/auth\.js/)
  assert.match(login.text, /用户登录/, 'IR 里的 doc 也要出现在摘要文本里')
  assert.ok(chunks.every((chunk) => chunk.text.trim().length > 0))
})

test('chunk：超长符号按 maxChunkChars 截断并标注', () => {
  const source = ['export function bigOne() {', ...Array.from({ length: 200 }, (_, i) => `  const value${i} = ${i}`), '}'].join('\n')
  const file = { id: 'src/big.js', moduleId: 'src', language: 'javascript', kind: 'source', loc: 202, exports: [] }
  const symbols = [makeSymbol('src/big.js', 'bigOne', 'function', 1, 202)]
  const chunks = chunkFile(file, symbols, { readText: () => source, maxChunkChars: 300 })
  const big = chunks.find((chunk) => chunk.kind === 'symbol')
  assert.ok(big)
  assert.ok(big.text.length <= 300, `截断后长度不能超过上限，实际 ${big.text.length}`)
  assert.match(big.text, /已截断/)
  assert.equal(big.id, 'src/big.js:1:symbol')
})

test('chunk：maxChunksPerFile 生效且 header 必留', () => {
  const symbols = Array.from({ length: 10 }, (_, i) => makeSymbol('f.js', `fn${i}`, 'function', i + 1, i + 1))
  const chunks = chunkFile({ id: 'f.js', moduleId: '.', language: 'javascript', kind: 'source', loc: 10 }, symbols, { maxChunksPerFile: 3 })
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].kind, 'file-header')
  assert.ok(chunks.every((chunk) => chunk.text.trim().length > 0))
})

/* ------------------------------------------------------------------ *
 * 检索
 * ------------------------------------------------------------------ */

test('searchIndex：中文查询命中 login 符号所在 chunk（BM25）', async () => {
  const index = await buildIndex(null, IR, { readText })
  const hits = searchIndex(index, '用户登录', { limit: 5 })
  assert.ok(hits.length > 0)
  assert.equal(hits[0].symbolName, 'login', '中文注释应通过 BM25 把 login 排到第一')
  assert.ok(hits[0].scores.bm25 > 0)
  assert.ok(hits.some((hit) => hit.symbolName === 'login'))

  const shape = hits[0]
  assert.equal(typeof shape.chunkId, 'string')
  assert.equal(typeof shape.fileId, 'string')
  assert.equal(typeof shape.startLine, 'number')
  assert.equal(typeof shape.text, 'string')
  for (const key of ['bm25', 'vector', 'fused', 'rerank']) {
    assert.equal(typeof shape.scores[key], 'number', `scores.${key} 必须存在`)
  }
})

test('searchIndex：标识符拆分与三联组让 getUserById 召回自身', async () => {
  const index = await buildIndex(null, IR, { readText })
  const hits = searchIndex(index, 'getUserById', { limit: 5 })
  assert.equal(hits[0].symbolName, 'getUserById')
  assert.ok(hits[0].scores.bm25 > 0)

  // 去掉 camelCase 的同一查询也应召回（验证分词有效）
  const spaced = searchIndex(index, 'get user by id', { limit: 5 })
  assert.ok(spaced.some((hit) => hit.symbolName === 'getUserById'))

  // 路径/文件名关键词
  const byPath = searchIndex(index, 'auth.js login', { limit: 5 })
  assert.equal(byPath[0].fileId, 'src/auth.js')
})

test('searchIndex：RRF + 重排让精确符号名排第一，且纯函数不读盘', async () => {
  const index = await buildIndex(null, IR, { readText })
  const before = JSON.stringify(index)
  const hits = searchIndex(index, 'login', { limit: 5 })
  assert.equal(hits[0].symbolName, 'login')
  assert.ok(hits[0].scores.rerank >= hits[1].scores.rerank)
  assert.equal(JSON.stringify(index), before, 'searchIndex 不得修改索引')

  // 同文件去冗余：src/auth.js 的命中不会在极小的 limit 下霸榜
  const one = searchIndex(index, 'auth', { limit: 1, perFileLimit: 1 })
  assert.equal(one.length, 1)
})

test('searchIndex：空查询 / 无词项查询返回空数组，非法输入不抛错', async () => {
  const index = await buildIndex(null, IR, { readText })
  assert.deepEqual(searchIndex(index, ''), [])
  assert.deepEqual(searchIndex(index, '   '), [])
  assert.deepEqual(searchIndex(index, '!!!'), [])
  assert.deepEqual(searchIndex(undefined, 'login'), [])
  assert.deepEqual(searchIndex({ schemaVersion: 1 }, 'login'), [])
  assert.deepEqual(searchIndex(index, null), [])
})

/* ------------------------------------------------------------------ *
 * 索引落盘
 * ------------------------------------------------------------------ */

test('buildIndex → saveIndex → loadIndex 往返（临时目录，测后清理）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'compass-rag-'))
  try {
    const index = await buildIndex(root, IR, { readText, concurrency: 2 })
    assert.equal(index.schemaVersion, 1)
    assert.equal(index.chunks.length, index.vectors.length)
    assert.equal(indexStats(index).files, 5)

    const target = await saveIndex(root, index)
    assert.equal(target, indexFile(root))

    const loaded = await loadIndex(root)
    assert.ok(loaded, 'loadIndex 应读回索引')
    assert.deepEqual(loaded.chunks.map((chunk) => chunk.id), index.chunks.map((chunk) => chunk.id))
    assert.deepEqual(indexStats(loaded), indexStats(index))
    assert.deepEqual(
      searchIndex(loaded, 'login', { limit: 3 }).map((hit) => hit.chunkId),
      searchIndex(index, 'login', { limit: 3 }).map((hit) => hit.chunkId),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('loadIndex：损坏 / 版本不符 / 结构不一致 → undefined，不抛错', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'compass-rag-bad-'))
  try {
    await mkdir(path.dirname(indexFile(root)), { recursive: true })

    await writeFile(indexFile(root), '{ 这不是 JSON', 'utf8')
    assert.equal(await loadIndex(root), undefined)

    await writeFile(indexFile(root), JSON.stringify({ schemaVersion: 2, chunks: [], vectors: [] }), 'utf8')
    assert.equal(await loadIndex(root), undefined, '版本不符必须降级')

    await writeFile(indexFile(root), JSON.stringify({ schemaVersion: 1, chunks: [{ id: 'a' }], vectors: [] }), 'utf8')
    assert.equal(await loadIndex(root), undefined, 'chunks 与 vectors 数量不一致必须降级')

    await writeFile(indexFile(root), '', 'utf8')
    assert.equal(await loadIndex(root), undefined)

    assert.equal(await loadIndex('/definitely/not/exists/compass'), undefined)
    assert.equal(await loadIndex(undefined), undefined)

    // 索引缺失时 answer 也要给出明确的"无证据"回答
    const empty = await answer(root, null, 'login')
    assert.equal(empty.confidence, 'low')
    assert.match(empty.answer, /未在项目索引中找到相关证据/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateIndex：只重建变更文件，其它文件与向量原样保留', async () => {
  const index = await buildIndex(null, IR, { readText })
  const beforeAuth = index.chunks.filter((chunk) => chunk.fileId === 'src/auth.js')
  const beforeUser = index.chunks.filter((chunk) => chunk.fileId === 'src/user.js')
  assert.ok(beforeAuth.length > 0 && beforeUser.length > 0)

  const updatedAuth = AUTH_SOURCE.replace('return { token: signToken(user.id) }', 'return { token: signToken(user.id), issuedAt: Date.now() }')
  const next = updateIndex(index, IR, ['src/auth.js'], {
    readText: (fileId) => (fileId === 'src/auth.js' ? updatedAuth : readText(fileId)),
  })

  const afterAuth = next.chunks.filter((chunk) => chunk.fileId === 'src/auth.js')
  const afterUser = next.chunks.filter((chunk) => chunk.fileId === 'src/user.js')

  assert.deepEqual(afterAuth.map((chunk) => chunk.id), beforeAuth.map((chunk) => chunk.id), '行号未变时 id 应稳定')
  assert.notDeepEqual(afterAuth.map((chunk) => chunk.hash), beforeAuth.map((chunk) => chunk.hash), '变更文件必须重建')

  assert.deepEqual(afterUser, beforeUser, '未变更文件的分块必须原样保留')
  const userBefore = index.chunks.findIndex((chunk) => chunk.id === beforeUser[0].id)
  const userAfter = next.chunks.findIndex((chunk) => chunk.id === beforeUser[0].id)
  assert.deepEqual(next.vectors[userAfter], index.vectors[userBefore], '未变更文件的向量必须保留')

  const authBefore = index.chunks.findIndex((chunk) => chunk.id === 'src/auth.js:6:symbol')
  const authAfter = next.chunks.findIndex((chunk) => chunk.id === 'src/auth.js:6:symbol')
  assert.notDeepEqual(next.vectors[authAfter], index.vectors[authBefore], '变更文件的向量必须更新')

  assert.equal(next.stats.chunks, index.chunks.length)
  assert.equal(next.stats.files, 5)
  assert.deepEqual(next.vectors.length, next.chunks.length)

  // 文件从 IR 消失 → 其分块被删除
  const prunedIr = { ...IR, files: IR.files.filter((file) => file.id !== 'src/empty.js') }
  const pruned = updateIndex(next, prunedIr, [], { readText })
  assert.ok(!pruned.chunks.some((chunk) => chunk.fileId === 'src/empty.js'), '已删除文件的分块必须移除')
  assert.ok(pruned.chunks.some((chunk) => chunk.fileId === 'src/user.js'))

  // 变更后的索引仍可检索
  assert.equal(searchIndex(next, 'login', { limit: 1 })[0].symbolName, 'login')
})

/* ------------------------------------------------------------------ *
 * 问答
 * ------------------------------------------------------------------ */

test('answer：抽取式回答带可反查引用、相关符号与流程', async () => {
  const index = await buildIndex(null, IR, { readText })
  const result = await answer(null, IR, '用户登录是如何实现的？', { index })

  assert.equal(result.question, '用户登录是如何实现的？')
  assert.equal(result.mode, 'extractive')
  assert.match(result.answer, /login/)
  assert.match(result.answer, /src\/auth\.js/)
  assert.ok(result.citations.length > 0)
  assert.ok(['high', 'medium'].includes(result.confidence), `置信度不应为 low，实际 ${result.confidence}`)
  assert.ok(Number.isFinite(result.elapsedMs))

  const files = new Map(IR.files.map((file) => [file.id, file]))
  for (const citation of result.citations) {
    const file = files.get(citation.path)
    assert.ok(file, `引用路径必须存在于 IR：${citation.path}`)
    assert.ok(citation.line >= 1 && citation.line <= file.loc, `引用行号必须落在 1..${file.loc}，实际 ${citation.line}`)
    assert.ok(typeof citation.why === 'string' && citation.why.length > 0)
    assert.ok(typeof citation.text === 'string' && citation.text.length > 0)
    assert.equal(typeof citation.score, 'number')
  }

  assert.ok(result.relatedSymbols.some((symbol) => symbol.name === 'login'))
  assert.ok(result.relatedSymbols.every((symbol) => files.has(symbol.fileId)))
  assert.ok(result.relatedFlows.some((flow) => flow.id === 'flow:login'))
  assert.ok(result.evidence.every((item) => /^[^:]+:\d+$/.test(item)))
  assert.ok(result.notes.length > 0)
})

test('answer：空查询 / 无词项 → 明确无证据、confidence 低，不编造', async () => {
  const index = await buildIndex(null, IR, { readText })

  const empty = await answer(null, IR, '', { index })
  assert.equal(empty.confidence, 'low')
  assert.deepEqual(empty.citations, [])
  assert.deepEqual(empty.evidence, [])
  assert.match(empty.answer, /未在项目索引中找到相关证据/)
  assert.ok(empty.notes.some((note) => note.includes('证据不足')))

  const noToken = await answer(null, IR, '!!!', { index })
  assert.match(noToken.answer, /未在项目索引中找到相关证据/)
  assert.equal(noToken.confidence, 'low')
  assert.equal(noToken.mode, 'extractive')

  const missing = await answer(null, null, 'login')
  assert.match(missing.answer, /未在项目索引中找到相关证据/)
  assert.equal(missing.confidence, 'low')
})

test('answer：无索引时从 IR 现场构建，相关流程也可来自 ir.graph.flows', async () => {
  const result = await answer(null, IR, '用户登录', {})
  assert.ok(result.citations.length > 0)
  assert.ok(result.relatedFlows.some((flow) => flow.id === 'flow:login'))

  const graphIr = { ...IR, flows: undefined, graph: { ...IR.graph, flows: IR.flows } }
  const viaGraph = await answer(null, graphIr, '用户登录', {})
  assert.ok(viaGraph.relatedFlows.some((flow) => flow.id === 'flow:login'))
})

test('answer：withLlm 且客户端可用时才走 LLM，失败或校验不过一律回退', async () => {
  const index = await buildIndex(null, IR, { readText })

  let called = 0
  const okClient = {
    available: () => true,
    complete: async () => {
      called += 1
      return { text: '用户登录由 `login` 实现（src/auth.js:6）。', provider: 'fake', model: 'fake' }
    },
  }
  const llm = await answer(null, IR, '用户登录', { index, withLlm: true, llmClient: okClient })
  assert.equal(called, 1)
  assert.equal(llm.mode, 'llm')
  assert.match(llm.answer, /src\/auth\.js:6/)
  assert.ok(llm.citations.length > 0, 'LLM 模式下仍保留检索引用')

  // 校验不通过 → 回退抽取式
  const rejectClient = { available: () => true, complete: async () => ({ text: '凭空编造的结论（nope.js:999）。' }) }
  const rejected = await answer(null, IR, '用户登录', {
    index,
    withLlm: true,
    llmClient: rejectClient,
    validator: { checkText: () => ({ ok: false, total: 1, valid: 0, dropped: [{ claim: 'nope.js:999', reason: 'unknown-path' }] }) },
  })
  assert.equal(rejected.mode, 'extractive')
  assert.ok(rejected.notes.some((note) => note.includes('回退抽取式')))

  // LLM 抛错 → 回退抽取式
  const brokenClient = { available: () => true, complete: async () => { throw new Error('boom') } }
  const broken = await answer(null, IR, '用户登录', { index, withLlm: true, llmClient: brokenClient })
  assert.equal(broken.mode, 'extractive')
  assert.ok(broken.notes.some((note) => note.includes('LLM 调用失败')))

  // 不可用 → 不调用
  let unavailableCalled = 0
  const unavailable = { available: () => false, complete: async () => { unavailableCalled += 1; return { text: 'x' } } }
  const fallback = await answer(null, IR, '用户登录', { index, withLlm: true, llmClient: unavailable })
  assert.equal(unavailableCalled, 0)
  assert.equal(fallback.mode, 'extractive')
})

test('indexStats：汇总字段完整，非法输入不抛错', async () => {
  const index = await buildIndex(null, IR, { readText })
  const stats = indexStats(index)
  assert.equal(stats.chunks, index.chunks.length)
  assert.equal(stats.files, 5)
  assert.equal(stats.dim, EMBED_DIM)
  assert.ok(stats.tokens > 0)
  assert.equal(typeof stats.builtAt, 'string')
  assert.deepEqual(Object.keys(stats).sort(), ['builtAt', 'chunks', 'dim', 'files', 'tokens'])

  const broken = indexStats(undefined)
  assert.deepEqual(broken, { chunks: 0, files: 0, tokens: 0, dim: EMBED_DIM, builtAt: null })
  assert.equal(indexStats({ chunks: 'x' }).chunks, 0)
})

/* ------------------------------------------------------------------ *
 * 证据闸门：无关问题必须 low，相关问题不得被误杀
 * ------------------------------------------------------------------ */

test('answer：与代码库无关的问题必须 low，且明确说明未找到证据', async () => {
  const ir = makeOrderIr()
  const index = await buildIndex(null, ir, { readText: readOrderText })
  // 干扰项：'与'、'的' 确实存在于索引中（README 里到处都是），但它们是单字，不构成证据
  assert.ok((index.df['与'] ?? 0) > 0, '干扰字符应在索引中真实存在')
  assert.ok((index.df['的'] ?? 0) > 0)

  const result = await answer(null, ir, '量子纠缠与光合作用的耦合机制', { index })

  assert.equal(result.confidence, 'low', `无关问题不得给出高置信度；答案：${result.answer.slice(0, 200)}`)
  assert.deepEqual(result.citations, [], '没有证据就不应有引用')
  assert.deepEqual(result.evidence, [])
  assert.match(result.answer, /未在项目索引中找到相关证据/)
  assert.ok(result.notes.some((note) => /证据不足|未命中/.test(note)), `notes 必须说明证据不足：${result.notes.join(' / ')}`)
  // 不得把最近片段包装成结论
  assert.doesNotMatch(result.answer, /最相关的实现/)
  assert.doesNotMatch(result.answer, /结论：/)
  assert.match(result.answer, /仅供人工核对/)
  assert.match(result.answer, /不构成证据/)
})

test('answer：只有常见字的干扰查询（的了和是在与）同样 low', async () => {
  const ir = makeOrderIr()
  const index = await buildIndex(null, ir, { readText: readOrderText })
  assert.ok((index.df['的'] ?? 0) > 0 && (index.df['在'] ?? 0) > 0 && (index.df['与'] ?? 0) > 0)

  const result = await answer(null, ir, '的了和是在与', { index })

  assert.equal(result.confidence, 'low')
  assert.deepEqual(result.citations, [])
  assert.match(result.answer, /未在项目索引中找到相关证据/)
  assert.ok(result.notes.some((note) => note.includes('证据不足')))
})

test('answer：同一份 IR 的相关问题仍是 high/medium 且引用正确', async () => {
  const ir = makeOrderIr()
  const index = await buildIndex(null, ir, { readText: readOrderText })

  const symbolQuery = await answer(null, ir, 'createOrder 创建订单', { index })
  assert.ok(['high', 'medium'].includes(symbolQuery.confidence), `相关问题的置信度不应是 low：${symbolQuery.confidence}`)
  assert.ok(symbolQuery.citations.length > 0)
  assert.equal(symbolQuery.citations[0].path, 'src/order.js')
  assert.equal(symbolQuery.citations[0].symbol, 'createOrder')
  assert.ok(symbolQuery.notes.some((note) => note.includes('证据闸门')))

  const businessQuery = await answer(null, ir, '订单创建流程经过哪些模块', { index })
  assert.ok(['high', 'medium'].includes(businessQuery.confidence), `中文业务问题不应被闸掉：${businessQuery.confidence}`)
  assert.ok(businessQuery.citations.some((citation) => citation.path === 'src/order.js'))

  // 单个有区分度的短查询词（run）也不能被闸门误杀
  const singleTerm = await answer(null, ir, 'run 做了什么', { index })
  assert.ok(['high', 'medium'].includes(singleTerm.confidence), `单个有区分度词项应给出 medium 及以上：${singleTerm.confidence}`)
  assert.equal(singleTerm.citations[0].path, '.github/workflows/ci.yml')
  assert.equal(singleTerm.confidence, 'medium', '仅一个强词项时不应给 high')
})

test('answer：没有命中时，最接近的片段只出现在正文里，不进入 citations', async () => {
  const ir = makeOrderIr()
  const index = await buildIndex(null, ir, { readText: readOrderText })
  const result = await answer(null, ir, '量子纠缠', { index })
  assert.equal(result.confidence, 'low')
  assert.deepEqual(result.citations, [])
  assert.deepEqual(result.evidence, [])
  assert.deepEqual(result.relatedSymbols, [])
  assert.deepEqual(result.relatedFlows, [])
  assert.match(result.answer, /未在项目索引中找到相关证据/)
})
