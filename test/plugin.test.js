/**
 * 插件入口测试：`apply` / `inject` / 导出形状 / 工具契约 / 卸载。
 *
 * 为什么值得单独测：插件最致命的失败模式不是逻辑错，而是**加载不起来**
 * （导出形状不对、注册时抛错、卸载不干净）。这些在真实宿主里一旦发生，
 * 用户看到的是"插件没反应"，很难排查，所以这里用假 ctx 把它钉死。
 *
 * @module test/plugin.test
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import * as plugin from '../lib/index.js'
import { createToolDefinitions } from '../lib/tools.js'
import { SKILL_NAME } from '../lib/version.js'

/** 造一个记录注册行为的假宿主上下文。 */
function fakeContext() {
  const tools = []
  const commands = []
  const skills = []
  const contexts = []
  const log = []
  const disposed = []
  const services = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => disposed.push(`tool:${definition.name}`)
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => disposed.push(`command:${definition.name}`)
      },
    },
    skills: {
      register(definition) {
        skills.push(definition)
        return () => disposed.push(`skill:${definition.name}`)
      },
    },
    systemPrompt: {
      context(definition) {
        contexts.push(definition)
        return () => disposed.push(`context:${definition.name}`)
      },
      getContextOrder: () => 60,
    },
  }
  const ctx = {
    tools: services.tools,
    commands: services.commands,
    skills: services.skills,
    systemPrompt: services.systemPrompt,
    logger: {
      info: (message) => log.push(`info:${message}`),
      warn: (message) => log.push(`warn:${message}`),
      debug: (message) => log.push(`debug:${message}`),
    },
    get(name) {
      return services[name]
    },
    ...services,
  }
  return { ctx, tools, commands, skills, contexts, log, disposed, services }
}

/* ------------------------------------------------------------------ *
 * 导出形状（Loader 的硬要求）
 * ------------------------------------------------------------------ */

test('plugin：导出形状符合宿主 Loader 要求（命名导出、无 default、有 inject）', () => {
  assert.equal(plugin.name, 'project-compass')
  assert.deepEqual(plugin.inject, ['tools'], 'tools 是硬依赖')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(!Object.keys(plugin).includes('default'), '导出 default 会让 Loader 折叠模块并丢掉 inject')
  assert.equal(plugin.default, undefined)
})

test('plugin：cordis.patch.yml 的 id 与 name 能和入口对上', async () => {
  const { readFile } = await import('node:fs/promises')
  const yaml = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(yaml, /id:\s*project-compass/, 'patch 行 id 必须是 project-compass')
  assert.match(yaml, /name:\s*'dsh-project-compass'/, 'patch 行 name 必须是包名')
  assert.equal(plugin.name, 'project-compass', '入口的 name 必须与 patch 行 id 一致')
})

/* ------------------------------------------------------------------ *
 * 注册与卸载
 * ------------------------------------------------------------------ */

test('plugin：apply 注册 6 个工具、1 个命令、1 个技能，并返回可用的卸载函数', () => {
  const { ctx, tools, commands, skills, log, disposed } = fakeContext()
  const dispose = plugin.apply(ctx, {})

  assert.deepEqual(tools.map((definition) => definition.name), [
    'project_compass_scan',
    'project_compass_analyze',
    'project_compass_report',
    'project_compass_ask',
    'project_compass_update',
    'project_compass_status',
  ])
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'compass')
  assert.ok(commands[0].input?.hint.length > 0)
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, SKILL_NAME)
  assert.ok(skills[0].content.includes('项目罗盘'), '技能正文应来自 lib/SKILL.md')
  assert.ok(log.some((line) => line.startsWith('info:[project-compass] 已注册工具 6/6')))

  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(disposed.length, 8, `卸载应释放 6 工具 + 1 命令 + 1 技能，实际 ${disposed.length}`)
  // 注册顺序是 工具(6) → 技能 → 命令，卸载必须逆序：命令 → 技能 → 工具
  assert.equal(disposed[0], 'command:compass', '应按注册逆序释放')
  assert.equal(disposed[1], `skill:${SKILL_NAME}`)
  assert.equal(disposed[disposed.length - 1], 'tool:project_compass_scan')
})

test('plugin：宿主缺少 commands / skills 时仍能注册工具且不抛错', () => {
  const registered = []
  const ctx = {
    tools: { register: (definition) => { registered.push(definition.name); return () => {} } },
    logger: { info() {}, warn() {} },
    get: () => undefined,
  }
  const dispose = plugin.apply(ctx, {})
  assert.equal(registered.length, 6)
  assert.doesNotThrow(() => dispose())
})

test('plugin：注册失败被隔离，不阻断其它工具', () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        if (definition.name === 'project_compass_report') throw new Error('模拟冲突')
        registered.push(definition.name)
        return () => {}
      },
    },
    logger: { info() {}, warn() {} },
    get: () => undefined,
  }
  const dispose = plugin.apply(ctx, {})
  assert.equal(registered.length, 5, '其余 5 个工具必须注册成功')
  assert.doesNotThrow(() => dispose())
})

test('plugin：contextInjection 默认关闭，显式开启才注册运行时上下文', () => {
  const off = fakeContext()
  plugin.apply(off.ctx, {})
  assert.equal(off.contexts.length, 0, '默认不得注入系统提示')

  const on = fakeContext()
  plugin.apply(on.ctx, { contextInjection: true })
  assert.equal(on.contexts.length, 1)
  assert.equal(on.contexts[0].name, 'project-compass')
  assert.equal(typeof on.contexts[0].text, 'function')
  // 没有 initiator / 没有分析结果时必须返回空串，而不是报错或注入噪声
  assert.equal(on.contexts[0].text({}), '')
})

/* ------------------------------------------------------------------ *
 * 工具契约
 * ------------------------------------------------------------------ */

test('plugin：每个工具都有可用的 description / parameters / output.schema / execute', () => {
  const definitions = createToolDefinitions({}, {})
  for (const definition of definitions) {
    assert.equal(typeof definition.name, 'string')
    assert.ok(definition.description.length > 40, `${definition.name} 的描述太短，模型无法判断何时使用`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false, `${definition.name} 的入参应关闭额外属性`)
    assert.ok(definition.output !== undefined, `${definition.name} 应声明输出契约`)
    assert.equal(typeof definition.output.schema, 'object')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
    assert.ok(Array.isArray(definition.output.schema.required), `${definition.name} 应声明必需输出字段`)
  }
  // 每个工具都应描述"什么时候用"，否则模型不会主动调用
  const report = definitions.find((definition) => definition.name === 'project_compass_report')
  assert.match(report.description, /ONBOARDING\.md/)
  assert.match(report.description, /默认\*\*不调用 LLM\*\*/)
})

test('plugin：工具返回值满足 output.schema 的必需字段（宿主会据此校验）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compass-plugin-'))
  try {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'mini', version: '1.0.0', main: 'src/index.js' }))
    await writeFile(path.join(root, 'src', 'index.js'), `import { run } from './run.js'\n\nexport function main() {\n  return run()\n}\n`)
    await writeFile(path.join(root, 'src', 'run.js'), `export function run() {\n  return 42\n}\n`)

    const definitions = createToolDefinitions({ logger: { info() {}, warn() {} } }, {})
    const byName = new Map(definitions.map((definition) => [definition.name, definition]))
    const exec = { agent: { id: 't', session: { header: { cwd: root } } } }

    for (const [suffix, args] of [
      ['scan', {}],
      ['analyze', {}],
      ['report', { withIndex: false }],
      ['status', {}],
      ['ask', { question: 'run 做了什么' }],
      ['update', { withReport: false, withIndex: false }],
    ]) {
      const definition = byName.get(`project_compass_${suffix}`)
      const value = await definition.execute({ projectPath: root, ...args }, exec)
      for (const key of definition.output.schema.required) {
        assert.ok(value[key] !== undefined, `${suffix} 的返回值缺少必需字段 ${key}`)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * /compass 命令
 * ------------------------------------------------------------------ */

test('plugin：/compass 命令的 help 与错误分支', async () => {
  const { ctx, commands } = fakeContext()
  plugin.apply(ctx, {})
  const handler = commands[0].handler

  const help = await handler({ rawInput: '', agent: { id: 'a' }, signal: new AbortController().signal })
  assert.equal(help.kind, 'success')
  assert.match(help.text, /\/compass analyze/)

  const unknown = await handler({ rawInput: 'fly', agent: { id: 'a' }, signal: new AbortController().signal })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /未知子命令/)
})

test('plugin：/compass status 在真实目录上可用，analyze 能生成产物', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compass-cmd-'))
  try {
    await writeFile(path.join(root, 'index.js'), `export function hello() {\n  return 'hi'\n}\n`)
    const { ctx, commands } = fakeContext()
    plugin.apply(ctx, {})
    const handler = commands[0].handler
    const invocation = { agent: { id: 'a' }, signal: new AbortController().signal }

    const before = await handler({ ...invocation, rawInput: `status ${root}` })
    assert.equal(before.kind, 'success')
    assert.match(before.text, /尚未分析/)

    const analyzed = await handler({ ...invocation, rawInput: `analyze ${root}` })
    assert.equal(analyzed.kind, 'success')
    assert.match(analyzed.text, /符号|文件/)

    const after = await handler({ ...invocation, rawInput: `status ${root}` })
    assert.match(after.text, /已分析/)

    const bad = await handler({ ...invocation, rawInput: 'ask ' })
    assert.equal(bad.kind, 'error', 'ask 缺问题时命令必须给出可读错误，而不是静默成功')
    assert.match(bad.text, /question 必填|失败/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
