/**
 * 工具输出 schema 与宿主校验语义的一致性测试。
 *
 * 为什么需要它：宿主会在工具 `execute()` **返回之后**校验 `output.schema`，校验不过就
 * 把整次调用判失败（INVALID_TOOL_OUTPUT）。而此前所有测试都直接调 `execute()`，
 * 恰好绕过了这道校验——于是出现过这样的线上缺陷：
 *
 *   · `loose()` 只声明 `type: 'object'`，但 `status` 在未分析时返回 `ir: null / index: null`；
 *   · 同一批字段里还混着**数组**（`analyze.modules`、`analyze.flows`、`ask.citations` …），
 *     `type: 'object'` 同样会拒；
 *   · `analyze.changes`、`report.roleRoutes` 压根没在 schema 里声明，
 *     而根 schema 是 `additionalProperties: false`，同样会被拒。
 *
 * 宿主的真实语义（读自宿主实现，不是猜的）：
 *   1. `type: 'object'` = **纯对象**：`null` 与数组都不算（`isPlainJsonRecord` 同时排除二者）；
 *   2. `additionalProperties: false` 会拒绝一切未声明字段；
 *   3. `required` 只检查"缺失或 undefined"，**null 能过 required**（但会被 type 拦下）；
 *   4. `type` 必须是**单个字符串**；数组形式会走到 `assertNever` 抛错；
 *   5. `oneOf` 逐分支尝试（要求恰好一个分支匹配）；
 *   6. `type: 'array'` 不声明 `items` 时只校验"是不是数组"。
 *
 * 本文件用一个与上述语义等价的校验器，对**每个工具 × 每种状态/开关**的返回值做校验；
 * 并自带反例，确保校验器自身不会退化成"永远通过"。
 *
 * @module test/output-schema.test
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { createToolDefinitions } from '../lib/tools.js'

/* ------------------------------------------------------------------ *
 * 宿主支持的 schema 关键字（JsonSchemaNode 的封闭集合）
 * ------------------------------------------------------------------ */

const ALLOWED_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'const', 'description', 'title', 'default', 'examples',
])

/** 宿主不支持的写法：出现即视为契约缺陷。 */
const FORBIDDEN_KEYWORDS = ['anyOf', 'allOf', 'not', 'if', 'then', 'else', '$ref', 'definitions']

/** 一个 JSON 值是不是"无损 JSON"（宿主对所有值都有这条最低要求）。 */
function isLosslessJson(value) {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isLosslessJson)
  if (type === 'object') return Object.values(value).every(isLosslessJson)
  return false
}

/** 按宿主语义校验一个值。返回违规说明（空数组 = 通过）。 */
export function valueViolations(node, value, at = 'value') {
  if (node === undefined || node === null || typeof node !== 'object') return []
  const problems = []

  // oneOf：逐分支尝试，要求恰好一个分支通过
  if (Array.isArray(node.oneOf)) {
    const matched = node.oneOf.filter((branch) => valueViolations(branch, value, at).length === 0)
    if (matched.length === 0) problems.push(`${at} 不匹配任何 oneOf 分支（实际=${describe(value)}）`)
    else if (matched.length > 1) problems.push(`${at} 同时匹配 ${matched.length} 个 oneOf 分支（要求恰好一个）`)
    return problems
  }

  // type 必须是单值字符串（数组形式在宿主会 assertNever 抛错）
  if (Object.hasOwn(node, 'type') && typeof node.type !== 'string') {
    problems.push(`${at} 的 schema.type 必须是单值字符串，实际 ${JSON.stringify(node.type)}`)
    return problems
  }

  const type = node.type
  if (type === undefined) {
    // 无 type：宿主只要求无损 JSON
    if (!isLosslessJson(value)) problems.push(`${at} 不是无损 JSON`)
    return problems
  }

  switch (type) {
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`${at} 应为 object（实际=${describe(value)}）`)
        return problems
      }
      break
    case 'array':
      if (!Array.isArray(value)) {
        problems.push(`${at} 应为 array（实际=${describe(value)}）`)
        return problems
      }
      break
    case 'string':
      if (typeof value !== 'string') problems.push(`${at} 应为 string（实际=${describe(value)}）`)
      return problems
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) problems.push(`${at} 应为 integer（实际=${describe(value)}）`)
      return problems
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${at} 应为 number（实际=${describe(value)}）`)
      return problems
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${at} 应为 boolean（实际=${describe(value)}）`)
      return problems
    case 'null':
      if (value !== null) problems.push(`${at} 应为 null（实际=${describe(value)}）`)
      return problems
    default:
      problems.push(`${at} 的 schema.type 不是宿主支持的类型：${JSON.stringify(type)}`)
      return problems
  }

  if (type === 'object') {
    const properties = node.properties ?? {}
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) problems.push(`${at}.${key} 缺少必需字段`)
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) problems.push(`${at}.${key} 未在 schema 中声明（additionalProperties: false）`)
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue
      problems.push(...valueViolations(child, value[key], `${at}.${key}`))
    }
  }

  if (type === 'array' && node.items !== undefined) {
    value.forEach((entry, index) => problems.push(...valueViolations(node.items, entry, `${at}[${index}]`)))
  }

  return problems
}

/** 校验 schema 本身是否只用了宿主支持的写法。 */
export function schemaViolations(node, at = 'schema') {
  if (node === undefined || node === null || typeof node !== 'object') return [`${at} 不是对象`]
  const problems = []
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) problems.push(`${at} 含宿主不支持的关键字「${key}」`)
    if (FORBIDDEN_KEYWORDS.includes(key)) problems.push(`${at} 含禁用关键字「${key}」`)
  }
  if (Object.hasOwn(node, 'type') && typeof node.type !== 'string') {
    problems.push(`${at}.type 必须是单值字符串（宿主不支持 type 数组）`)
  }
  if (Array.isArray(node.oneOf)) {
    if (node.oneOf.length === 0) problems.push(`${at}.oneOf 不能为空`)
    node.oneOf.forEach((branch, index) => problems.push(...schemaViolations(branch, `${at}.oneOf[${index}]`)))
  } else if (Object.hasOwn(node, 'oneOf')) {
    problems.push(`${at}.oneOf 必须是数组`)
  }
  if (Object.hasOwn(node, 'properties')) {
    if (typeof node.properties !== 'object' || node.properties === null) problems.push(`${at}.properties 必须是对象`)
    else {
      for (const [key, child] of Object.entries(node.properties)) {
        problems.push(...schemaViolations(child, `${at}.properties.${key}`))
      }
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(node.properties, key)) problems.push(`${at}.required 含未声明的字段「${key}」`)
      }
    }
  }
  if (Object.hasOwn(node, 'items')) problems.push(...schemaViolations(node.items, `${at}.items`))
  return problems
}

/** 人类可读的类型描述。 */
function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') return 'object'
  return typeof value + (typeof value === 'number' ? `(${value})` : '')
}

/* ------------------------------------------------------------------ *
 * 守卫自检：先证明它会失败
 * ------------------------------------------------------------------ */

test('守卫自检：null / 数组 / 未声明字段都必须被判为违规', () => {
  assert.ok(valueViolations({ type: 'object' }, null, 'value.ir').length > 0, 'null 不能被当作 object')
  assert.ok(valueViolations({ type: 'object' }, [], 'value.modules').length > 0, '数组不能被当作 object')
  assert.ok(
    valueViolations({ type: 'object', properties: {}, additionalProperties: false }, { a: 1 }, 'value').length > 0,
    '未声明字段必须被 additionalProperties: false 拒掉',
  )
  assert.ok(valueViolations({ type: 'integer' }, 1.5, 'value.n').length > 0, '1.5 不是 integer')
  assert.ok(valueViolations({ type: 'object', required: ['a'] }, {}, 'value').length > 0, '缺少必需字段')
})

test('守卫自检：可空字段必须用 oneOf，且三个分支各自通过', () => {
  const nullable = { oneOf: [{ type: 'object' }, { type: 'array' }, { type: 'null' }] }
  assert.deepEqual(valueViolations(nullable, {}, 'v'), [])
  assert.deepEqual(valueViolations(nullable, [], 'v'), [])
  assert.deepEqual(valueViolations(nullable, null, 'v'), [])
  assert.ok(valueViolations(nullable, 'x', 'v').length > 0, '字符串不属于任何分支')
  // required 只查缺失/undefined，null 能过 required（但会被 type 拦下）
  const requiredNull = { type: 'object', properties: { a: { type: 'null' } }, required: ['a'] }
  assert.deepEqual(valueViolations(requiredNull, { a: null }, 'v'), [])
})

test('守卫自检：issue 里被否掉的 type 数组写法会被 schema 检查拦下', () => {
  const problems = schemaViolations({ type: ['object', 'null'] })
  assert.ok(problems.some((p) => p.includes('单值字符串')), `应报出 type 数组：${JSON.stringify(problems)}`)
  assert.ok(schemaViolations({ anyOf: [{ type: 'object' }] }).some((p) => p.includes('不支持')))
  assert.ok(schemaViolations({ type: 'object', properties: {}, required: ['nope'] }).some((p) => p.includes('未声明')))
})

/* ------------------------------------------------------------------ *
 * 静态检查：6 个工具的 schema 本身要合法
 * ------------------------------------------------------------------ */

test('schema 静态检查：只用宿主支持的关键字，required 与 properties 对齐', () => {
  const definitions = createToolDefinitions({}, {})
  const problems = []
  for (const definition of definitions) {
    const name = definition.name
    const found = schemaViolations(definition.output.schema, `${name}.output.schema`)
    for (const problem of found) problems.push(problem)
    // 根 schema 必须是 object 且关闭 additionalProperties，否则返回值失去约束
    assert.equal(definition.output.schema.type, 'object', `${name} 的根 schema 应为 object`)
    assert.equal(definition.output.schema.additionalProperties, false, `${name} 应关闭 additionalProperties`)
  }
  assert.deepEqual(problems, [], `工具 schema 含宿主不支持的写法：\n${problems.join('\n')}`)
})

/* ------------------------------------------------------------------ *
 * 真实工具 × 真实状态
 * ------------------------------------------------------------------ */

/** 造一个最小但"有内容"的项目，让 ask / report 有东西可分析。 */
async function makeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compass-schema-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'schema-fixture',
    version: '1.0.0',
    type: 'module',
    main: 'src/index.js',
    scripts: { test: 'node --test' },
  }))
  await writeFile(path.join(root, 'src', 'index.js'), [
    "import { greet } from './greet.js'",
    '',
    'export function main() {',
    '  return greet(\'world\')',
    '}',
    '',
  ].join('\n'))
  await writeFile(path.join(root, 'src', 'greet.js'), [
    'export function greet(name) {',
    '  return `hello ${name}`',
    '}',
    '',
  ].join('\n'))
  return root
}

/** 执行一个工具并校验其返回值是否符合自身 output.schema。 */
async function runAndCheck(byName, name, args, exec) {
  const definition = byName.get(`project_compass_${name}`)
  assert.ok(definition !== undefined, `缺少工具 ${name}`)
  const value = await definition.execute(args, exec)
  const problems = valueViolations(definition.output.schema, value, `${name} 的返回值`)
  return { value, problems }
}

test('真实返回值：未分析状态（首次运行，含 status 的 null 分支）', async () => {
  const root = await makeProject()
  try {
    const byName = new Map(createToolDefinitions({ logger: { info() {}, warn() {}, debug() {} } }, {})
      .map((definition) => [definition.name, definition]))
    const exec = { agent: { id: 'schema', session: { header: { cwd: root } } } }

    // 未分析时必须先跑 status：此时 ir / index 都是 null，是 issue 的原始场景
    const first = await runAndCheck(byName, 'status', { projectPath: root }, exec)
    assert.equal(first.value.analyzed, false)
    assert.equal(first.value.ir, null, '未分析时 ir 必须是 null（否则这个用例失去意义）')
    assert.equal(first.value.index, null, '未分析时 index 必须是 null')
    assert.deepEqual(first.problems, [])

    const scan = await runAndCheck(byName, 'scan', { projectPath: root }, exec)
    assert.deepEqual(scan.problems, [])

    // 首次分析：changes 为 null，且 modules / flows 是数组
    const analyze = await runAndCheck(byName, 'analyze', { projectPath: root }, exec)
    assert.equal(analyze.value.changes, null, '首次分析没有基线，changes 应为 null')
    assert.ok(Array.isArray(analyze.value.modules), 'modules 是数组')
    assert.ok(Array.isArray(analyze.value.flows), 'flows 是数组')
    assert.deepEqual(analyze.problems, [])

    const report = await runAndCheck(byName, 'report', { projectPath: root }, exec)
    assert.equal(typeof report.value.roleRoutes, 'number', 'roleRoutes 是数字且必须已声明')
    assert.deepEqual(report.problems, [])

    // ask：citations / relatedSymbols / relatedFlows 都是数组
    const ask = await runAndCheck(byName, 'ask', { projectPath: root, question: 'greet 做了什么' }, exec)
    assert.ok(Array.isArray(ask.value.citations), 'citations 是数组')
    assert.deepEqual(ask.problems, [])

    const update = await runAndCheck(byName, 'update', { projectPath: root }, exec)
    assert.deepEqual(update.problems, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('真实返回值：已分析状态 + 会产出 null 的参数开关', async () => {
  const root = await makeProject()
  try {
    const byName = new Map(createToolDefinitions({ logger: { info() {}, warn() {}, debug() {} } }, {})
      .map((definition) => [definition.name, definition]))
    const exec = { agent: { id: 'schema', session: { header: { cwd: root } } } }

    // 先建立基线（后续 cases 依赖已分析状态）
    await byName.get('project_compass_analyze').execute({ projectPath: root }, exec)

    const cases = [
      ['status', {}],
      ['status', { detail: 'full' }],
      ['scan', {}],
      ['analyze', { force: true }],
      ['report', {}],
      // 关掉索引 → index 必须允许 null（此前会被 type: object 拒）
      ['report', { withIndex: false }],
      ['ask', { question: 'main 做了什么', limit: 3 }],
      ['update', {}],
      // 同时关掉报告与索引 → reports 与 index 都是 null
      ['update', { withReport: false, withIndex: false }],
    ]

    const failures = []
    for (const [name, extra] of cases) {
      const { value, problems } = await runAndCheck(byName, name, { projectPath: root, ...extra }, exec)
      void value
      for (const problem of problems) failures.push(`${name} ${JSON.stringify(extra)} → ${problem}`)
    }
    assert.deepEqual(failures, [], `工具返回值违反宿主 schema 语义：\n${failures.join('\n')}`)

    // 覆盖率护栏：用例数量下降说明有人删了场景，而不是问题消失了
    assert.ok(cases.length >= 9, `用例数异常：${cases.length}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
