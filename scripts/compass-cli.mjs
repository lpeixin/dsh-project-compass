#!/usr/bin/env node
/**
 * Project Compass 命令行入口。
 *
 * 存在的意义有三个：
 *   1. **不依赖 DSH 宿主**就能跑完整流水线——本仓库的自测与 CI 靠它做真项目冒烟；
 *   2. 与插件工具**走同一份实现**（同一个 createToolDefinitions），
 *      因此不会出现"命令行能跑、工具里跑不通"的双实现漂移；
 *   3. 让用户在没装插件时也能先试一次效果。
 *
 * 用法：
 *   node scripts/compass-cli.mjs status  <项目路径>
 *   node scripts/compass-cli.mjs scan    <项目路径>
 *   node scripts/compass-cli.mjs analyze <项目路径> [--force]
 *   node scripts/compass-cli.mjs report  <项目路径> [--llm] [--output docs/project-compass]
 *   node scripts/compass-cli.mjs ask     <项目路径> "订单创建经过哪些模块？" [--llm]
 *   node scripts/compass-cli.mjs update  <项目路径> [--llm]
 * 通用开关：--json（输出原始 JSON）、--quiet（只输出 summary）、--help
 *
 * @module scripts/compass-cli
 */

import path from 'node:path'
import process from 'node:process'
import { createToolDefinitions } from '../lib/tools.js'
import { DISPLAY_NAME, PACKAGE_NAME, VERSION } from '../lib/version.js'

const USAGE = `${DISPLAY_NAME}（${PACKAGE_NAME} v${VERSION}）命令行

用法：
  compass-cli.mjs status  <项目路径> [--json]
  compass-cli.mjs scan    <项目路径> [--json]
  compass-cli.mjs analyze <项目路径> [--force] [--json]
  compass-cli.mjs report  <项目路径> [--llm] [--output <目录>] [--json]
  compass-cli.mjs ask     <项目路径> "<问题>" [--llm] [--json]
  compass-cli.mjs update  <项目路径> [--llm] [--json]

说明：
  · 默认不调用任何 LLM；--llm 才会使用会话默认模型（CLI 下需要宿主环境，通常不可用）。
  · 所有产物：状态与缓存在 <项目>/.project-compass/，报告在 <项目>/docs/project-compass/。`

/** 极简参数解析：位置参数 + 少量布尔/取值开关。 */
function parseArgv(argv) {
  const flags = new Set()
  const values = new Map()
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--llm' || token === '--force' || token === '--json' || token === '--quiet' || token === '--help' || token === '-h') {
      flags.add(token === '-h' ? '--help' : token)
      continue
    }
    if (token === '--output' || token === '--max-files' || token === '--concurrency') {
      values.set(token, argv[index + 1])
      index += 1
      continue
    }
    positional.push(token)
  }
  return { flags, values, positional }
}

/** 控制台日志器：工具层只会用到 info/warn/debug。 */
function consoleLogger(quiet) {
  return {
    info: (message) => {
      if (!quiet) process.stderr.write(`${message}\n`)
    },
    warn: (message) => process.stderr.write(`${message}\n`),
    debug: () => {},
  }
}

async function main() {
  const { flags, values, positional } = parseArgv(process.argv.slice(2))
  if (flags.has('--help') || positional.length === 0) {
    process.stdout.write(`${USAGE}\n`)
    return positional.length === 0 ? 2 : 0
  }

  const command = positional[0]
  const known = new Set(['scan', 'analyze', 'report', 'ask', 'update', 'status'])
  if (!known.has(command)) {
    process.stderr.write(`未知命令：${command}\n\n${USAGE}\n`)
    return 2
  }

  const projectPath = path.resolve(positional[1] ?? process.cwd())
  const question = command === 'ask' ? positional.slice(2).filter((part) => !part.startsWith('--')).join(' ') : undefined
  if (command === 'ask' && (question === undefined || question.trim().length === 0)) {
    process.stderr.write(`ask 命令需要问题，例如：compass-cli.mjs ask . "登录流程经过哪些模块？"\n`)
    return 2
  }

  const quiet = flags.has('--quiet')
  const config = {
    outputDir: values.get('--output') ?? undefined,
    concurrency: values.get('--concurrency') === undefined ? undefined : Number(values.get('--concurrency')),
    llm: { enabled: flags.has('--llm') },
  }
  const definitions = createToolDefinitions({ logger: consoleLogger(quiet) }, config)
  const definition = definitions.find((candidate) => candidate.name === `project_compass_${command}`)
  if (definition === undefined) {
    process.stderr.write(`内部错误：未找到工具 project_compass_${command}\n`)
    return 1
  }

  const args = { projectPath }
  if (flags.has('--llm')) args.withLlm = true
  if (flags.has('--force')) args.force = true
  if (values.has('--max-files')) args.maxFiles = Number(values.get('--max-files'))
  if (values.has('--output')) args.outputDir = values.get('--output')
  if (command === 'ask') args.question = question

  const exec = { agent: { id: 'cli', session: { header: { cwd: projectPath } } } }
  const result = await definition.execute(args, exec)

  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else if (command === 'ask') {
    process.stdout.write(`${result.answer}\n`)
    if ((result.citations ?? []).length > 0) {
      process.stdout.write(`\n证据：\n`)
      for (const citation of result.citations) {
        process.stdout.write(`  - ${citation.text}${citation.why ? `：${citation.why}` : ''}\n`)
      }
    }
    process.stdout.write(`\n置信度：${result.confidence}｜模式：${result.mode}｜耗时：${result.elapsedMs}ms\n`)
    for (const note of result.notes ?? []) process.stdout.write(`说明：${note}\n`)
  } else {
    process.stdout.write(`${result.summary ?? JSON.stringify(result, null, 2)}\n`)
  }
  return 0
}

main()
  .then((code) => {
    process.exitCode = code ?? 0
  })
  .catch((error) => {
    process.stderr.write(`${DISPLAY_NAME} 执行失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
