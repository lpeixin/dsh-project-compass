/**
 * dsh-project-compass —— DeepSeek Harness 插件入口（项目罗盘 / Project Compass）。
 *
 * 插件形态：命名导出（name / inject / apply），**没有 default export**
 * ——导出 default 会让 Loader 的 `unwrapExports` 折叠模块并丢掉 `inject`。
 *
 * 依赖策略：零外部 import，只用 Node 内置模块。因此不需要 dependencies、
 * 不需要构建步骤，也不会因为宿主内 `@deepseek-ai/*` 包的解析方式或版本变化而加载失败。
 *
 * 注册面（宿主未挂载的能力一律静默跳过，缺失不影响插件可用）：
 *   - `ctx.tools`    6 个 project_compass_* 工具（硬依赖）；
 *   - `ctx.commands` 人类可用命令 `/compass`；
 *   - `ctx.skills`   方法论技能（正文在 lib/SKILL.md）；
 *   - `ctx.systemPrompt` 可选的运行时上下文注入（默认关闭，见 contextInjection）。
 *
 * @module dsh-project-compass
 */

import { readFileSync } from 'node:fs'
import { irFile } from './paths.js'
import { createToolDefinitions, TOOL_NAMES } from './tools.js'
import { registerSkill } from './skill.js'
import { DISPLAY_NAME, PACKAGE_NAME, VERSION } from './version.js'

/** Loader 行标识（与 cordis.patch.yml 中的 id 对应）。 */
export const name = 'project-compass'

/**
 * 需要的服务：`tools` 是硬依赖（插件主体就是注册工具）。
 * commands / skills / systemPrompt 都只是加分项——缺失时插件仍应完全可用，
 * 因此不写进 inject，而是在 apply 里做存在性判断。
 */
export const inject = ['tools']

/** 从 `ctx` 安全取服务（组合未挂载时返回 undefined）。 */
function service(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') {
      const found = ctx.get(key)
      if (found !== undefined && found !== null) return found
    }
  } catch {
    // 忽略：继续走属性兜底
  }
  return ctx?.[key] ?? undefined
}

/** 解析当前会话对应的项目根：会话工作目录优先，最后退到进程工作目录。 */
function currentProjectRoot(ctx, explicit, agent) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const fromAgent = agent?.session?.header?.cwd
  if (typeof fromAgent === 'string' && fromAgent.length > 0) return fromAgent
  try {
    const initiator = service(ctx, 'agents')?.currentInitiator?.()
    const session = initiator === undefined ? undefined : service(ctx, 'sessions')?.get?.(initiator.id)
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  } catch {
    // 拿不到就用进程工作目录
  }
  return process.cwd()
}

/* ------------------------------------------------------------------ *
 * 人类命令 /compass
 * ------------------------------------------------------------------ */

const COMMAND_HELP = [
  `${DISPLAY_NAME}（dsh-project-compass v${VERSION}）用法：`,
  '  /compass scan [路径]           侦察项目：技术栈、命令、入口、缺口',
  '  /compass analyze [路径]        解析代码并构建 IR 与依赖图谱',
  '  /compass report [路径] [--llm] 生成 6 份入门报告到 docs/project-compass/',
  '  /compass ask <问题>            就当前项目带引用提问',
  '  /compass update [路径]         增量刷新分析、索引与报告',
  '  /compass status [路径]         查看分析状态与产物',
  '  /compass help                  显示本帮助',
  '',
  '说明：不带路径时使用当前会话工作目录；--llm 才会调用模型（默认不联网）。',
].join('\n')

/** 把一条工具返回值渲染成人类可读的命令输出。 */
function renderCommandText(subcommand, value) {
  if (value === undefined || value === null) return '（没有返回内容）'
  if (subcommand === 'ask') {
    const lines = [String(value.answer ?? '（无回答）')]
    const citations = Array.isArray(value.citations) ? value.citations : []
    if (citations.length > 0) {
      lines.push('', '证据：')
      for (const citation of citations.slice(0, 8)) lines.push(`  - ${citation.text}${citation.why ? `：${citation.why}` : ''}`)
    }
    lines.push('', `置信度：${value.confidence ?? 'low'}｜模式：${value.mode ?? 'extractive'}`)
    for (const note of value.notes ?? []) lines.push(`说明：${note}`)
    return lines.join('\n')
  }
  return String(value.summary ?? JSON.stringify(value, null, 2))
}

/**
 * 注册 `/compass` 命令。
 * @returns 取消注册的函数，或 undefined（宿主没有命令注册表时）。
 */
function registerCommand(ctx, definitions, onFailure) {
  const commands = service(ctx, 'commands')
  if (commands === undefined || typeof commands.register !== 'function') return undefined

  const bySuffix = new Map()
  for (const definition of definitions) bySuffix.set(definition.name.replace('project_compass_', ''), definition)

  try {
    const dispose = commands.register({
      name: 'compass',
      description: `${DISPLAY_NAME}：扫描/解析项目、生成入门报告、带引用提问。子命令 scan|analyze|report|ask|update|status|help。`,
      input: { hint: 'scan | analyze | report [--llm] | ask <问题> | update | status | help' },
      async handler(invocation) {
        const raw = String(invocation?.rawInput ?? '').trim()
        const parts = raw.split(/\s+/).filter((part) => part.length > 0)
        const subcommand = (parts.shift() ?? 'help').toLowerCase()
        if (subcommand === 'help' || subcommand === '') {
          return { kind: 'success', text: COMMAND_HELP }
        }
        const definition = bySuffix.get(subcommand)
        if (definition === undefined) {
          return { kind: 'error', text: `未知子命令：${subcommand}\n\n${COMMAND_HELP}` }
        }
        const withLlm = parts.includes('--llm')
        const pathArg = parts.find((part) => !part.startsWith('--'))
        const question = subcommand === 'ask' ? parts.filter((part) => !part.startsWith('--')).join(' ') : undefined
        const projectPath = currentProjectRoot(ctx, subcommand === 'ask' ? undefined : pathArg, invocation?.agent)

        const args = { projectPath, withLlm }
        if (subcommand === 'ask') args.question = question

        try {
          const value = await definition.execute(args, { agent: invocation?.agent, signal: invocation?.signal })
          return { kind: 'success', text: renderCommandText(subcommand, value) }
        } catch (error) {
          return { kind: 'error', text: `${DISPLAY_NAME} ${subcommand} 失败：${error instanceof Error ? error.message : String(error)}` }
        }
      },
    })
    return typeof dispose === 'function' ? dispose : undefined
  } catch (error) {
    onFailure?.(`注册命令 /compass 失败：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * 可选的系统提示注入
 * ------------------------------------------------------------------ */

/** 会话 id → 最近一次操作的项目根（仅用于上下文注入的定位）。 */
const sessionProjects = new Map()

/** 记录一次调用涉及的项目（供上下文注入查找）。 */
export function rememberProject(agentId, root) {
  if (typeof agentId === 'string' && agentId.length > 0 && typeof root === 'string' && root.length > 0) {
    sessionProjects.set(agentId, root)
  }
}

/**
 * 注册运行时上下文：把当前项目的"一句话简报"注入每一步的提示，
 * 让 Agent 不必反复调用工具就能知道项目规模和报告位置。
 *
 * **默认关闭**（`config.contextInjection: true` 才注册）：注入会占用每一步的 token，
 * 应该由用户显式选择，而不是插件替他决定。
 */
function registerContext(ctx, config, onFailure) {
  if (config?.contextInjection !== true) return undefined
  const systemPrompt = service(ctx, 'systemPrompt')
  if (systemPrompt === undefined || typeof systemPrompt.context !== 'function') return undefined

  try {
    const dispose = systemPrompt.context({
      name: 'project-compass',
      order: 60,
      text: () => {
        try {
          const initiator = service(ctx, 'agents')?.currentInitiator?.()
          if (initiator === undefined) return ''
          const root = sessionProjects.get(initiator.id)
          if (root === undefined) return ''
          // 上下文提供者必须是同步函数：这里只读一个已经落盘的小文件，不做任何分析
          const ir = readJsonSync(irFile(root))
          if (ir === undefined) return ''
          const lines = [
            `[项目罗盘] 当前项目已分析：${ir.name ?? root}`,
            `规模：${ir.stats?.files ?? 0} 文件 / ${ir.stats?.loc ?? 0} 行 / ${ir.stats?.symbols ?? 0} 符号 / ${ir.stats?.routes ?? 0} 路由 / ${ir.modules?.length ?? 0} 模块`,
            '报告：docs/project-compass/（从 ONBOARDING.md 起读）；需要具体证据时调用 project_compass_ask。',
          ]
          return lines.join('\n')
        } catch {
          return ''
        }
      },
    })
    return typeof dispose === 'function' ? dispose : undefined
  } catch (error) {
    onFailure?.(`注册运行时上下文失败：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** 同步读取 JSON（上下文提供者必须是同步函数）；任何失败都返回 undefined。 */
function readJsonSync(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * apply
 * ------------------------------------------------------------------ */

/**
 * 注册工具、命令、技能与可选上下文。
 * @param ctx 插件上下文。
 * @param config 插件配置（`cordis.patch.yml` 的 config 段）。
 * @returns 卸载函数：按注册逆序释放全部 disposer。
 */
export function apply(ctx, config = {}) {
  const disposers = []
  const failures = []

  const definitions = createToolDefinitions(ctx, config, { onProject: rememberProject })
  let registered = 0
  for (const definition of definitions) {
    try {
      const dispose = ctx.tools.register(definition)
      if (typeof dispose === 'function') disposers.push(dispose)
      registered += 1
    } catch (error) {
      failures.push(`注册工具 ${definition.name} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    const dispose = registerSkill(ctx)
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (error) {
    failures.push(`注册技能失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const commandDispose = registerCommand(ctx, definitions, (message) => failures.push(message))
  if (typeof commandDispose === 'function') disposers.push(commandDispose)

  const contextDispose = registerContext(ctx, config, (message) => failures.push(message))
  if (typeof contextDispose === 'function') disposers.push(contextDispose)

  if (failures.length > 0) ctx.logger?.warn?.(`[project-compass] ${failures.join('；')}`)
  ctx.logger?.info?.(`[project-compass] 已注册工具 ${registered}/${definitions.length} 个：${TOOL_NAMES.join(', ')}`)

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        ctx.logger?.warn?.(`[project-compass] 卸载失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

export { PACKAGE_NAME, DISPLAY_NAME, VERSION }
