/**
 * 工具注册（模型可见面）：6 个 `project_compass_*` 工具。
 *
 * 为什么不 import 宿主的 `defineTool`：本插件坚持零外部依赖，直接构造宿主
 * `ToolDefinition`。代价是入参校验要自己做（宿主不校验 parameters），
 * 收益是安装时不存在依赖解析风险，也不会因为宿主包版本变化而加载失败。
 *
 * 三条宿主约束（踩过坑，写在这里）：
 *   1. `output.schema` 会被宿主用于校验返回值，校验失败即 INVALID_TOOL_OUTPUT，
 *      因此自由形态对象一律不写 `additionalProperties:false`；
 *   2. `parameters` 只是给模型看的 JSON Schema，**不会**被强制校验，
 *      所以每个 execute 内部必须自己校验入参；
 *   3. 返回值必须是**无损 JSON**（无 undefined / NaN / 函数 / 环），统一由 define() 出口清洗。
 *
 * @module dsh-project-compass/tools
 */

import path from 'node:path'
import { appendLine, dirStats, pathExists, readJsonFile, statSafe } from './store.js'
import { cacheDir, indexFile, irFile, qaLogFile, relPath, reportsDir, scanFile, stateFile } from './paths.js'
import { clip, jsonSafe, nowIso, toPosix } from './util.js'
import { scanProject } from './scan.js'
import { analyzeProject, DEFAULT_BUDGET } from './analyze.js'
import { diffFiles } from './cache.js'
import { ensureGraph, loadIR, loadState, recordRun, saveIR, saveProfile } from './project.js'
import { askQuestion, buildSearchIndex, describeReportResult, generateReports, reportFilePaths } from './pipeline.js'
import { createLlmClient } from './llm.js'
import { createValidator } from './validate.js'
import { indexStats } from './rag.js'
import { VERSION, DISPLAY_NAME, TOOL_PREFIX } from './version.js'

/* ------------------------------------------------------------------ *
 * JSON Schema 构造器（宿主支持的子集）
 * ------------------------------------------------------------------ */

const str = (description) => ({ type: 'string', description })
const bool = (description) => ({ type: 'boolean', description })
const int = (description) => ({ type: 'integer', description })
const strArray = (description) => ({ type: 'array', description, items: { type: 'string' } })
/** 自由形态对象：不声明 properties，也不关闭 additionalProperties。 */
const loose = (description) => ({ type: 'object', description })
const objectRoot = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
})

function textRender(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/** 包装工具：所有返回值在离开 execute 前清洗为无损 JSON。 */
function define(definition) {
  const inner = definition.execute
  return {
    ...definition,
    async execute(args, exec) {
      return jsonSafe(await inner(args, exec))
    },
  }
}

/* ------------------------------------------------------------------ *
 * 入参校验
 * ------------------------------------------------------------------ */

function fail(message) {
  throw new Error(message)
}

function asString(value, name, { required = false, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`参数 ${name} 必填`)
    return fallback
  }
  if (typeof value !== 'string') fail(`参数 ${name} 必须是字符串`)
  return value
}

function asStringArray(value, name) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail(`参数 ${name} 必须是字符串数组`)
  for (const entry of value) if (typeof entry !== 'string') fail(`参数 ${name} 的每一项必须是字符串`)
  return value
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asInt(value, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`参数 ${name} 必须是数字`)
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 解析项目路径：显式参数优先，其次会话工作目录，最后进程工作目录。 */
function resolveProject(args, exec) {
  const raw = asString(args?.projectPath, 'projectPath', { fallback: undefined })
  const sessionCwd = exec?.agent?.session?.header?.cwd
  const fallbackCwd = typeof sessionCwd === 'string' && sessionCwd.length > 0 ? sessionCwd : process.cwd()
  const resolved = raw === undefined ? fallbackCwd : path.isAbsolute(raw) ? raw : path.resolve(fallbackCwd, raw)
  return path.resolve(resolved)
}

/* ------------------------------------------------------------------ *
 * 共享装配
 * ------------------------------------------------------------------ */

/** 合并插件配置与调用参数，得到一次运行的有效设置。 */
function effectiveOptions(config, args) {
  const llmConfig = config?.llm ?? {}
  const budget = {
    maxFiles: asInt(args?.maxFiles, 'maxFiles', config?.budget?.maxFiles ?? DEFAULT_BUDGET.maxFiles, { min: 1 }),
    maxFileBytes: config?.budget?.maxFileBytes ?? DEFAULT_BUDGET.maxFileBytes,
    maxTotalBytes: config?.budget?.maxTotalBytes ?? DEFAULT_BUDGET.maxTotalBytes,
    maxDurationMs: config?.budget?.maxDurationMs ?? DEFAULT_BUDGET.maxDurationMs,
    maxChunks: config?.budget?.maxChunks ?? DEFAULT_BUDGET.maxChunks,
  }
  return {
    outputDir: asString(args?.outputDir, 'outputDir', { fallback: config?.outputDir }),
    concurrency: asInt(args?.concurrency, 'concurrency', config?.concurrency ?? 8, { min: 1, max: 64 }),
    ignore: [...(config?.ignore ?? []), ...asStringArray(args?.ignore, 'ignore')],
    include: [...(config?.include ?? []), ...asStringArray(args?.include, 'include')],
    budget,
    sensitive: { extraPatterns: config?.sensitive?.extraPatterns ?? [] },
    contextInjection: config?.contextInjection === true,
    llm: {
      enabled: llmConfig.enabled === true,
      provider: llmConfig.provider ?? null,
      model: llmConfig.model ?? null,
      maxCalls: llmConfig.maxCalls ?? 12,
      maxTokens: llmConfig.maxTokens ?? 1200,
    },
  }
}

/** 载入项目当前状态（IR/画像），必要时给出明确错误。 */
async function requireIR(root, { allowMissing = false } = {}) {
  const ir = await loadIR(root)
  if (ir === undefined && !allowMissing) {
    fail(`项目尚未分析：${root} 下缺少可用的 IR。请先调用 ${TOOL_PREFIX}analyze。`)
  }
  if (ir !== undefined) ensureGraph(ir)
  return ir
}

/** 从 IR 里挑出模块概览（工具返回值要克制体积）。 */
function moduleOverview(ir, limit = 30) {
  return [...(ir?.modules ?? [])]
    .sort((a, b) => (b.loc ?? 0) - (a.loc ?? 0))
    .slice(0, limit)
    .map((module) => ({
      id: module.id,
      kind: module.kind,
      language: module.language,
      files: module.files?.length ?? 0,
      loc: module.loc ?? 0,
      symbols: module.symbolCount ?? 0,
      dependsOn: module.dependsOn ?? [],
      risk: module.risk ?? 'low',
    }))
}

/** 日志器（宿主可能没挂 logger，因此全链路可选链）。 */
function logger(ctx) {
  return ctx?.logger ?? {}
}

/* ------------------------------------------------------------------ *
 * 工具定义（按 ctx/config 生成，因为要闭包住宿主服务）
 * ------------------------------------------------------------------ */

/**
 * 生成全部工具定义。
 * @param ctx 插件上下文（用于取 llm / logger；可为 undefined，CLI 场景）。
 * @param config 插件配置。
 */
export function createToolDefinitions(ctx, config = {}, hooks = {}) {
  const toolName = (suffix) => `${TOOL_PREFIX}${suffix}`

  /**
   * 解析项目根，并把"本会话最近操作的项目"告知宿主侧钩子
   * （可选的系统提示注入靠它定位项目；不传钩子时纯函数行为不变）。
   */
  const resolve = (args, exec) => {
    const root = resolveProject(args, exec)
    try {
      hooks.onProject?.(exec?.agent?.id, root)
    } catch {
      // 钩子是观察者，绝不能影响工具执行
    }
    return root
  }

  /* ---------------- 1. scan ---------------- */
  const scanTool = define({
    name: toolName('scan'),
    description: [
      `侦察项目并生成结构化"项目画像"（${DISPLAY_NAME}·第一步）：目录扫描、忽略规则、语言分布、技术栈与包管理器、可执行命令、入口点、配置/CI/容器/IaC、测试框架，以及**已能确定的工程缺口**。`,
      '结论全部来自磁盘证据（配置、脚本、文件统计与只读遍历），不含猜测；敏感文件只登记路径与类型，绝不读取内容。',
      `画像写入 <项目>/.project-compass/scan.json，供后续 ${TOOL_PREFIX}analyze 复用。`,
      '当用户要求"读懂/接手/梳理某个项目"时，先调用本工具。',
    ].join(' '),
    parameters: objectRoot({
      projectPath: str('目标项目根目录绝对路径；省略时使用当前会话工作目录。'),
      force: bool('为 true 时忽略既有画像重新扫描，默认 true。'),
      ignore: strArray('额外忽略规则（.gitignore 语法，支持 ! 取反），叠加在配置与项目 .gitignore 之上。'),
      include: strArray('强制包含的路径（命中则无视忽略规则，敏感文件仍不读内容）。'),
    }),
    output: {
      schema: objectRoot({
        projectPath: str('解析后的项目绝对路径。'),
        projectName: str('项目名。'),
        scanFile: str('画像文件路径。'),
        kinds: strArray('识别到的项目类型。'),
        ecosystems: strArray('技术栈（kind(manifest) 形式）。'),
        commands: strArray('可执行命令（preset: 命令行）。'),
        entrypoints: strArray('入口点（path (kind) 形式）。'),
        languages: strArray('语言分布（name: files 文件 / loc 行）。'),
        tests: loose('测试框架与测试文件统计。'),
        gaps: strArray('已确认的工程缺口（优先级 + 标题）。'),
        sensitive: strArray('敏感文件路径（未读取内容）。'),
        stats: loose('规模统计。'),
        summary: str('一句话结论与建议的下一步。'),
      }, ['projectPath', 'scanFile', 'summary']),
      render: textRender,
    },
    async execute(args, exec) {
      const projectPath = resolve(args, exec)
      if (!(await pathExists(projectPath))) fail(`项目路径不存在：${projectPath}`)
      const options = effectiveOptions(config, args)
      logger(ctx).info?.(`[project-compass] 开始扫描 ${projectPath}`)
      const profile = await scanProject(projectPath, {
        ignore: options.ignore,
        include: options.include,
        exclude: [relPath(projectPath, reportsDir(projectPath, options.outputDir))],
        maxFiles: options.budget.maxFiles,
        maxFileBytes: options.budget.maxFileBytes,
        maxTotalBytes: options.budget.maxTotalBytes,
        maxDurationMs: options.budget.maxDurationMs,
        extraSensitivePatterns: options.sensitive.extraPatterns,
      })
      await saveProfile(projectPath, profile)
      await recordRun(projectPath, 'scan', { budget: { durationMs: profile.durationMs } })

      const stack = (profile.ecosystems ?? []).map((entry) => `${entry.kind}(${entry.manifest})`)
      const commandLines = (profile.commands ?? []).map((entry) => `${entry.preset}: ${entry.argv.join(' ')}`)
      const gaps = (profile.gaps ?? []).map((gap) => `${gap.priority} ${gap.id ?? gap.title} ${gap.title}`)
      const critical = (profile.gaps ?? []).filter((gap) => gap.priority === 'P0' || gap.priority === 'P1').length

      return {
        projectPath,
        projectName: profile.name ?? path.basename(projectPath),
        scanFile: scanFile(projectPath),
        kinds: profile.kinds ?? [],
        ecosystems: stack,
        commands: commandLines,
        entrypoints: (profile.entrypoints ?? []).map((entry) => `${entry.path} (${entry.kind})`),
        languages: (profile.languages ?? []).slice(0, 8).map((entry) => `${entry.name}: ${entry.files} 文件 / ${entry.loc} 行`),
        tests: {
          frameworks: (profile.tests?.frameworks ?? []).map((entry) => entry.label ?? entry.id),
          testFiles: profile.tests?.testFileCount ?? 0,
          coverageConfig: profile.tests?.coverageConfig ?? [],
        },
        gaps,
        sensitive: (profile.sensitive ?? []).map((entry) => `${entry.path} (${entry.kind})`),
        stats: {
          files: profile.size?.files ?? 0,
          sourceFiles: profile.size?.sourceFiles ?? 0,
          dirs: profile.size?.dirs ?? 0,
          bytes: profile.size?.bytes ?? 0,
          skipped: profile.size?.skipped ?? 0,
          truncated: profile.size?.truncated === true,
          todoCount: profile.signals?.todoCount ?? 0,
          debugStatements: profile.signals?.debugStatementCount ?? 0,
          secretSuspects: (profile.signals?.secretSuspects ?? []).length,
          analyzableSources: (profile.sources ?? []).length,
          durationMs: profile.durationMs ?? 0,
        },
        summary: [
          `项目类型：${(profile.kinds ?? []).join('、') || '未识别'}`,
          `技术栈：${stack.join('、') || '未识别'}`,
          `可执行命令 ${commandLines.length} 条`,
          `测试框架：${(profile.tests?.frameworks ?? []).map((entry) => entry.label ?? entry.id).join('、') || '未识别'}`,
          `工程缺口 ${gaps.length} 项（P0/P1 ${critical} 项）`,
          `敏感文件 ${(profile.sensitive ?? []).length} 个（未读取内容）`,
          `下一步：调用 ${TOOL_PREFIX}analyze 解析代码、构建 IR 与依赖图谱。`,
        ].join('；'),
      }
    },
  })

  /* ---------------- 2. analyze ---------------- */
  const analyzeTool = define({
    name: toolName('analyze'),
    description: [
      `解析代码并构建统一中间表示（IR）与依赖知识图谱（${DISPLAY_NAME}·第二步）：多语言符号/导入/调用/路由抽取 → 模块·文件·符号三级依赖图 → 关键流程识别。`,
      '基于内容哈希做增量：未变更的文件直接复用上次解析结果，只有内容、语言或解析器版本变化才重新解析。',
      '跨文件绑定只走显式 import 声明，无法确定的一律标记为未解析——宁可断边也不猜，因此报告里的每条依赖都可追溯。',
      '产物写入 <项目>/.project-compass/ir.json；本步骤不调用 LLM。',
    ].join(' '),
    parameters: objectRoot({
      projectPath: str('目标项目根目录绝对路径；省略时使用当前会话工作目录。'),
      force: bool('为 true 时忽略解析缓存，强制重新解析全部文件（默认 false）。'),
      maxFiles: int('本次纳入分析的文件数上限（覆盖配置默认值）。'),
      concurrency: int('解析并发度（1-64，默认取配置值）。'),
      ignore: strArray('额外忽略规则（.gitignore 语法）。'),
      include: strArray('强制包含的路径。'),
    }),
    output: {
      schema: objectRoot({
        projectPath: str('项目绝对路径。'),
        irFile: str('IR 文件路径。'),
        modules: loose('模块概览列表。'),
        counts: loose('文件/符号/路由/流程等计数。'),
        graph: loose('图谱统计与枢纽。'),
        flows: loose('关键流程摘要。'),
        cache: loose('解析缓存命中统计。'),
        warnings: strArray('降级与截断说明。'),
        durationMs: int('本次分析耗时（毫秒）。'),
        summary: str('一句话结论与建议的下一步。'),
      }, ['projectPath', 'irFile', 'summary']),
      render: textRender,
    },
    async execute(args, exec) {
      const projectPath = resolve(args, exec)
      if (!(await pathExists(projectPath))) fail(`项目路径不存在：${projectPath}`)
      const options = effectiveOptions(config, args)
      logger(ctx).info?.(`[project-compass] 开始分析 ${projectPath}`)

      // 每次都重新扫描：画像只用于报告展示，**不能**当成"文件清单仍然有效"的依据，
      // 否则代码增删之后 IR 会一直沿用旧文件集合（实测踩过：新增文件永远进不了分析）。
      // 报告产物目录必须排除，否则每生成一次报告就会被下一次分析吃进去。
      const scanOptions = {
        ignore: options.ignore,
        include: options.include,
        exclude: [relPath(projectPath, reportsDir(projectPath, options.outputDir))],
        maxFiles: options.budget.maxFiles,
        maxFileBytes: options.budget.maxFileBytes,
        maxTotalBytes: options.budget.maxTotalBytes,
        maxDurationMs: options.budget.maxDurationMs,
        extraSensitivePatterns: options.sensitive.extraPatterns,
      }
      const profile = await scanProject(projectPath, scanOptions)
      await saveProfile(projectPath, profile)

      const previousIR = await loadIR(projectPath)
      const result = await analyzeProject(projectPath, {
        profile,
        force: asBool(args?.force, false),
        concurrency: options.concurrency,
        budget: options.budget,
        signal: exec?.signal,
        scanOptions,
        onProgress: (event) => logger(ctx).debug?.(`[project-compass] ${event.phase} ${event.done}/${event.total}`),
      })
      await saveIR(projectPath, result.ir)
      await recordRun(projectPath, 'analyze', { budget: result.ir.budget })

      const diff = previousIR === undefined ? null : diffFiles(previousIR, result.ir.files)

      return {
        projectPath,
        irFile: irFile(projectPath),
        modules: moduleOverview(result.ir),
        counts: {
          modules: result.ir.stats.modules,
          files: result.ir.stats.files,
          sourceFiles: result.ir.stats.sourceFiles,
          symbols: result.ir.stats.symbols,
          imports: result.ir.stats.imports,
          calls: result.ir.stats.calls,
          routes: result.ir.stats.routes,
          flows: result.flows.length,
          loc: result.ir.stats.loc,
          unresolvedCalls: result.ir.stats.unresolvedCalls,
          externalImports: result.ir.stats.externalImports,
        },
        graph: {
          stats: result.graph.stats,
          hubs: (result.graph.metrics.hubs ?? []).slice(0, 10),
          cycles: (result.graph.module.cycles ?? []).slice(0, 5),
          riskModules: (result.graph.metrics.riskModules ?? []).slice(0, 10),
        },
        flows: result.flows.slice(0, 10).map((flow) => ({
          id: flow.id,
          name: flow.name,
          kind: flow.kind,
          confidence: flow.confidence,
          entry: `${flow.entry.fileId}:${flow.entry.line}`,
          steps: flow.steps.length,
        })),
        cache: { ...result.cache.stats(), parserVersion: result.cache.parserVersion },
        changes: diff === null ? null : { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, unchanged: diff.unchanged.length },
        warnings: (result.warnings ?? []).slice(0, 20),
        durationMs: result.stats.durationMs,
        summary: [
          `解析 ${result.stats.analyzed}/${result.stats.candidates} 个文件（缓存命中 ${result.stats.cacheHits}，新解析 ${result.stats.cacheMisses}）`,
          `符号 ${result.ir.stats.symbols} 个、路由 ${result.ir.stats.routes} 条、关键流程 ${result.flows.length} 条`,
          `模块 ${result.ir.stats.modules} 个，其中高风险 ${(result.graph.metrics.riskModules ?? []).filter((entry) => entry.score >= 6).length} 个`,
          `未解析调用 ${result.ir.stats.unresolvedCalls}/${result.ir.stats.calls}`,
          diff === null ? '首次分析（无变更基线）' : `增量：新增 ${diff.added.length}、变更 ${diff.changed.length}、删除 ${diff.removed.length}`,
          `下一步：调用 ${TOOL_PREFIX}report 生成 6 份入门报告。`,
        ].join('；'),
      }
    },
  })

  /* ---------------- 3. report ---------------- */
  const reportTool = define({
    name: toolName('report'),
    description: [
      `生成面向开发者的入门报告（${DISPLAY_NAME}·第三步），输出 6 份产物到 docs/project-compass/：ONBOARDING.md、ARCHITECTURE.md、MODULE_MAP.md、KEY_FLOWS.md、GETTING_STARTED.md、project-compass.json。`,
      '报告包含 Mermaid 架构图与依赖图、关键调用链时序图、按角色（后端/前端/测试/运维/数据）的阅读路线，每条结论都附 `path:line` 证据。',
      `默认**不调用 LLM**：全部结论来自静态证据。传入 withLlm=true 才会用会话默认模型润色叙事，且每条 LLM 断言必须带引用并通过验证器，验证不通过的直接丢弃并计入元信息。`,
      '同时刷新本地检索索引，让后续 project_compass_ask 能立即带引用回答。',
    ].join(' '),
    parameters: objectRoot({
      projectPath: str('目标项目根目录绝对路径；省略时使用当前会话工作目录。'),
      outputDir: str('报告输出目录（相对项目根，默认 docs/project-compass）。'),
      withLlm: bool('是否调用 LLM 生成叙事（默认 false；需要用户明确同意消耗额度）。'),
      includeMermaid: bool('是否内嵌 Mermaid 图，默认 true。'),
      role: str('只渲染某个角色的阅读路线（backend/frontend/test/devops/data）。'),
      maxNodes: int('Mermaid 单图节点上限，默认 40。'),
      withIndex: bool('是否同时构建检索索引，默认 true。'),
    }),
    output: {
      schema: objectRoot({
        projectPath: str('项目绝对路径。'),
        reportDir: str('报告目录。'),
        files: loose('6 份产物的键与路径。'),
        counts: loose('报告统计（模块/文件/符号/路由/流程/风险）。'),
        llm: loose('LLM 使用情况与验证器丢弃统计。'),
        index: loose('检索索引统计（未构建时为 null）。'),
        warnings: strArray('渲染告警。'),
        summary: str('一句话结论与建议的下一步。'),
      }, ['projectPath', 'reportDir', 'summary']),
      render: textRender,
    },
    async execute(args, exec) {
      const projectPath = resolve(args, exec)
      const options = effectiveOptions(config, args)
      const ir = await requireIR(projectPath)
      const withLlm = asBool(args?.withLlm, false)
      if (withLlm && !options.llm.enabled) {
        logger(ctx).warn?.('[project-compass] withLlm=true 但配置未开启 llm.enabled，将尝试使用会话默认模型')
      }

      const llm = createLlmClient(ctx, { ...options.llm, enabled: withLlm || options.llm.enabled })
      const validator = createValidator(ir)

      const result = await generateReports(projectPath, {
        ir,
        profile: ir.profileSummary,
        llm,
        validator,
        withLlm,
        signal: exec?.signal,
        outputDir: options.outputDir,
        role: asString(args?.role, 'role', { fallback: undefined }),
        includeMermaid: asBool(args?.includeMermaid, true),
        maxNodes: asInt(args?.maxNodes, 'maxNodes', 40, { min: 5, max: 200 }),
      })

      let index = null
      if (asBool(args?.withIndex, true)) {
        const built = await buildSearchIndex(projectPath, ir, { maxChunks: options.budget.maxChunks, concurrency: options.concurrency })
        await recordRun(projectPath, 'index', { extra: { indexChunks: built.stats.chunks } })
        index = { ...built.stats, mode: built.mode, path: built.path }
      }

      await recordRun(projectPath, 'report', {
        outputs: result.paths,
        extra: { reportDir: result.reportDir, llmUsed: result.meta?.llm?.used === true },
      })

      return {
        projectPath,
        reportDir: result.reportDir,
        files: result.paths,
        counts: result.meta?.counts ?? {},
        llm: {
          used: result.meta?.llm?.used === true,
          provider: result.meta?.llm?.provider ?? null,
          model: result.meta?.llm?.model ?? null,
          reason: result.insights?.llm?.reason ?? null,
          droppedClaims: result.meta?.validation?.droppedCount ?? 0,
        },
        roleRoutes: (result.insights?.roles ?? []).length,
        index,
        warnings: (result.meta?.warnings ?? []).slice(0, 20),
        summary: [
          describeReportResult(result, ir),
          `下一步：可用 ${TOOL_PREFIX}ask 就该项目提问（带引用回答），或阅读 ${toPosix(path.join(result.reportDir, 'ONBOARDING.md'))}。`,
        ].join('；'),
      }
    },
  })

  /* ---------------- 4. ask ---------------- */
  const askTool = define({
    name: toolName('ask'),
    description: [
      `就项目提问并获得**带引用的答案**（${DISPLAY_NAME}）：本地 BM25 + 向量混合检索 → RRF 融合 → 重排，命中源码分块后给出结论与「path:line」证据。`,
      '默认抽取式回答，不联网、不调用 LLM：答案直接由命中片段组成，因此不可能凭空编造。',
      '设置 withLlm=true 时，才把检索到的片段作为唯一事实来源交给模型润色，并用验证器过滤无据声明。',
      '适合回答"某功能经过哪些模块""入口在哪""这个符号被谁调用""配置从哪读"这类需要落到代码的问题。',
    ].join(' '),
    parameters: objectRoot({
      projectPath: str('目标项目根目录绝对路径；省略时使用当前会话工作目录。'),
      question: str('要问的问题；建议包含具体功能名、符号名或文件名以提高召回质量。'),
      limit: int('返回的证据条数上限（默认 8）。'),
      withLlm: bool('是否用 LLM 润色答案（默认 false）。'),
      rebuildIndex: bool('为 true 时强制重建索引（默认 false，索引缺失才自动构建）。'),
    }),
    output: {
      schema: objectRoot({
        projectPath: str('项目绝对路径。'),
        question: str('原问题。'),
        answer: str('带引用的答案。'),
        confidence: str('置信度（high/medium/low）。'),
        mode: str('回答模式（extractive/hybrid/llm）。'),
        citations: loose('证据列表（path/line/symbol/why/score）。'),
        relatedSymbols: loose('相关符号。'),
        relatedFlows: loose('相关关键流程。'),
        notes: strArray('说明与降级原因。'),
        indexRebuilt: bool('本次是否顺带重建了索引。'),
        elapsedMs: int('检索与回答耗时。'),
      }, ['projectPath', 'question', 'answer', 'citations']),
      render: textRender,
    },
    async execute(args, exec) {
      const projectPath = resolve(args, exec)
      const question = asString(args?.question, 'question', { required: true })
      const options = effectiveOptions(config, args)
      const ir = await requireIR(projectPath)
      const llm = createLlmClient(ctx, { ...options.llm, enabled: asBool(args?.withLlm, false) || options.llm.enabled })
      const withLlm = asBool(args?.withLlm, false)

      const result = await askQuestion(projectPath, ir, question, {
        withLlm,
        limit: asInt(args?.limit, 'limit', 8, { min: 1, max: 50 }),
        llm,
        validator: createValidator(ir),
        maxChunks: options.budget.maxChunks,
        signal: exec?.signal,
        buildIfMissing: true,
      })

      if (asBool(args?.rebuildIndex, false)) {
        const built = await buildSearchIndex(projectPath, ir, { maxChunks: options.budget.maxChunks, concurrency: options.concurrency })
        const again = await askQuestion(projectPath, ir, question, {
          withLlm,
          limit: asInt(args?.limit, 'limit', 8, { min: 1, max: 50 }),
          llm,
          validator: createValidator(ir),
          index: built.index,
          signal: exec?.signal,
          buildIfMissing: false,
        })
        Object.assign(result, again, { indexRebuilt: true })
      }

      await recordRun(projectPath, 'ask', { extra: { answerCount: ((await loadState(projectPath)).answerCount ?? 0) + 1 } })
      try {
        await appendLine(qaLogFile(projectPath), JSON.stringify({
          at: nowIso(),
          question,
          mode: result.mode,
          confidence: result.confidence,
          citations: (result.citations ?? []).slice(0, 8).map((citation) => citation.text),
        }))
      } catch {
        // 留痕失败不影响回答
      }

      return {
        projectPath,
        question,
        answer: clip(String(result.answer ?? ''), 6000),
        confidence: result.confidence ?? 'low',
        mode: result.mode ?? 'extractive',
        citations: (result.citations ?? []).slice(0, 20).map((citation) => ({
          text: citation.text ?? `${citation.path}${citation.line ? `:${citation.line}` : ''}`,
          path: citation.path ?? null,
          line: citation.line ?? null,
          symbol: citation.symbol ?? null,
          why: clip(citation.why ?? '', 200),
          score: citation.score ?? null,
        })),
        relatedSymbols: (result.relatedSymbols ?? []).slice(0, 10),
        relatedFlows: (result.relatedFlows ?? []).slice(0, 5),
        notes: (result.notes ?? []).slice(0, 10),
        indexRebuilt: result.indexRebuilt === true,
        elapsedMs: result.elapsedMs ?? 0,
      }
    },
  })

  /* ---------------- 5. update ---------------- */
  const updateTool = define({
    name: toolName('update'),
    description: [
      `增量更新分析结果与报告（${DISPLAY_NAME}）：重新扫描 → 只重新解析变更文件 → 刷新 IR/图谱/流程 → 增量更新检索索引 → 重新生成报告。`,
      '返回本轮"新增/变更/删除"的文件清单，便于判断文档是否与代码同步。',
      '适合在拉取新代码、切换分支或完成一轮改动之后调用。',
    ].join(' '),
    parameters: objectRoot({
      projectPath: str('目标项目根目录绝对路径；省略时使用当前会话工作目录。'),
      outputDir: str('报告输出目录（相对项目根）。'),
      withLlm: bool('是否调用 LLM 生成叙事（默认 false）。'),
      withReport: bool('是否重新生成报告，默认 true；只想刷新 IR 时设 false。'),
      withIndex: bool('是否增量更新检索索引，默认 true。'),
    }),
    output: {
      schema: objectRoot({
        projectPath: str('项目绝对路径。'),
        changes: loose('新增/变更/删除/未变文件数。'),
        changedSample: strArray('变更文件示例（最多 20 个）。'),
        irFile: str('IR 文件路径。'),
        reports: loose('报告路径（未重新生成时为 null）。'),
        index: loose('索引统计（未更新时为 null）。'),
        durationMs: int('耗时（毫秒）。'),
        summary: str('一句话结论。'),
      }, ['projectPath', 'summary']),
      render: textRender,
    },
    async execute(args, exec) {
      const projectPath = resolve(args, exec)
      if (!(await pathExists(projectPath))) fail(`项目路径不存在：${projectPath}`)
      const options = effectiveOptions(config, args)
      const started = Date.now()

      const previousIR = await loadIR(projectPath)
      const scanOptions = {
        ignore: options.ignore,
        include: options.include,
        exclude: [relPath(projectPath, reportsDir(projectPath, options.outputDir))],
        maxFiles: options.budget.maxFiles,
        maxFileBytes: options.budget.maxFileBytes,
        maxTotalBytes: options.budget.maxTotalBytes,
        maxDurationMs: options.budget.maxDurationMs,
        extraSensitivePatterns: options.sensitive.extraPatterns,
      }
      const profile = await scanProject(projectPath, scanOptions)
      await saveProfile(projectPath, profile)

      const result = await analyzeProject(projectPath, {
        profile,
        concurrency: options.concurrency,
        budget: options.budget,
        signal: exec?.signal,
        scanOptions,
      })
      await saveIR(projectPath, result.ir)

      const diff = previousIR === undefined
        ? { changed: [], added: result.ir.files.map((file) => file.id), removed: [], unchanged: [] }
        : diffFiles(previousIR, result.ir.files)
      const touched = [...diff.added, ...diff.changed]

      let reports = null
      const withReport = asBool(args?.withReport, true)
      if (withReport) {
        const validator = createValidator(result.ir)
        const llm = createLlmClient(ctx, { ...options.llm, enabled: asBool(args?.withLlm, false) || options.llm.enabled })
        const generated = await generateReports(projectPath, {
          ir: result.ir,
          profile,
          graph: result.graph,
          flows: result.flows,
          llm,
          validator,
          withLlm: asBool(args?.withLlm, false),
          signal: exec?.signal,
          outputDir: options.outputDir,
        })
        reports = generated.paths
        await recordRun(projectPath, 'report', { outputs: generated.paths })
      }

      let index = null
      if (asBool(args?.withIndex, true)) {
        const built = await buildSearchIndex(projectPath, result.ir, {
          changedFiles: touched,
          maxChunks: options.budget.maxChunks,
          concurrency: options.concurrency,
        })
        index = { ...built.stats, mode: built.mode }
        await recordRun(projectPath, 'index', { extra: { indexChunks: built.stats.chunks } })
      }

      await recordRun(projectPath, 'analyze', { budget: result.ir.budget })

      return {
        projectPath,
        changes: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, unchanged: diff.unchanged.length },
        changedSample: touched.slice(0, 20),
        irFile: irFile(projectPath),
        reports,
        index,
        durationMs: Date.now() - started,
        summary: [
          previousIR === undefined
            ? '此前没有分析基线，本轮做了全量分析'
            : `增量更新：新增 ${diff.added.length}、变更 ${diff.changed.length}、删除 ${diff.removed.length}、未变 ${diff.unchanged.length}`,
          `缓存命中 ${result.stats.cacheHits}、新解析 ${result.stats.cacheMisses}`,
          withReport ? '报告已刷新' : '按参数跳过报告刷新',
          index === null ? '索引未更新' : `索引 ${index.mode === 'incremental' ? '增量' : '全量'}更新完成（${index.chunks} 块）`,
        ].join('；'),
      }
    },
  })

  /* ---------------- 6. status ---------------- */
  const statusTool = define({
    name: toolName('status'),
    description: [
      `查看当前项目的罗盘状态（${DISPLAY_NAME}）：是否已扫描/已分析、IR 规模、产物清单与体积、解析缓存与检索索引规模、上次运行的预算与耗时。`,
      '不知道"这个项目分析过没有""报告在哪"，先调用本工具。',
      '不修改任何文件。',
    ].join(' '),
    parameters: objectRoot({
      projectPath: str('目标项目根目录绝对路径；省略时使用当前会话工作目录。'),
      detail: str('详略程度：compact（默认）或 full。'),
    }),
    output: {
      schema: objectRoot({
        projectPath: str('项目绝对路径。'),
        analyzed: bool('是否已有可用 IR。'),
        hasScan: bool('是否有扫描画像。'),
        hasIndex: bool('是否有检索索引。'),
        files: loose('状态文件路径。'),
        artifacts: loose('报告产物存在性与体积。'),
        ir: loose('IR 规模摘要（未分析时为 null）。'),
        cache: loose('解析缓存统计。'),
        index: loose('检索索引统计。'),
        state: loose('运行状态（时间、预算、产物）。'),
        answerCount: int('累计问答次数。'),
        nextSteps: strArray('建议的下一步。'),
        summary: str('一句话结论。'),
      }, ['projectPath', 'analyzed', 'summary']),
      render: textRender,
    },
    async execute(args, exec) {
      const projectPath = resolve(args, exec)
      const detail = asString(args?.detail, 'detail', { fallback: 'compact' })
      const ir = await loadIR(projectPath)
      const paths = reportFilePaths(projectPath, effectiveOptions(config, args).outputDir)

      const artifacts = {}
      for (const [key, target] of Object.entries(paths)) {
        const info = await statSafe(target)
        artifacts[key] = { path: target, exists: info !== undefined, bytes: info?.size ?? null }
      }

      const reportsPresent = Object.values(artifacts).filter((entry) => entry.exists).length
      const cacheDirStats = await dirStats(cacheDir(projectPath)).catch(() => ({ files: 0, bytes: 0 }))
      const index = await readJsonFile(indexFile(projectPath), undefined)
      const state = await loadState(projectPath)

      const nextSteps = []
      if (ir === undefined) nextSteps.push(`调用 ${TOOL_PREFIX}analyze 解析项目并构建 IR`)
      if (reportsPresent === 0) nextSteps.push(`调用 ${TOOL_PREFIX}report 生成 6 份入门报告`)
      if (ir !== undefined && (index?.chunks?.length ?? 0) === 0) nextSteps.push(`调用 ${TOOL_PREFIX}ask 或 ${TOOL_PREFIX}report 构建检索索引`)
      if (ir !== undefined && reportsPresent > 0) nextSteps.push(`调用 ${TOOL_PREFIX}ask 就具体功能提问（带引用回答）`)
      if (reportsPresent > 0) nextSteps.push(`代码变更后调用 ${TOOL_PREFIX}update 增量刷新`)

      return {
        projectPath,
        analyzed: ir !== undefined,
        hasScan: await pathExists(scanFile(projectPath)),
        hasIndex: (index?.chunks?.length ?? 0) > 0,
        files: { scan: scanFile(projectPath), ir: irFile(projectPath), state: stateFile(projectPath), index: indexFile(projectPath) },
        artifacts,
        ir: ir === undefined ? null : {
          generatedAt: ir.generatedAt,
          stats: ir.stats,
          truncated: ir.truncated === true,
          budget: ir.budget,
          moduleCount: ir.modules?.length ?? 0,
          topModules: detail === 'full' ? moduleOverview(ir, 20) : moduleOverview(ir, 5),
        },
        cache: { files: cacheDirStats.files, bytes: cacheDirStats.bytes },
        index: (index?.chunks?.length ?? 0) === 0 ? null : indexStats(index),
        state,
        answerCount: state.answerCount ?? 0,
        nextSteps,
        summary: [
          ir === undefined ? '尚未分析该项目' : `已分析：${ir.stats.files} 文件 / ${ir.stats.symbols} 符号 / ${ir.stats.routes} 路由`,
          `报告产物 ${reportsPresent}/6 份`,
          `缓存 ${cacheDirStats.files} 个条目（${Math.round(cacheDirStats.bytes / 1024)} KB）`,
          (index?.chunks?.length ?? 0) > 0 ? `索引 ${index.chunks.length} 块` : '索引未构建',
          state.lastAnalyze ? `上次分析：${state.lastAnalyze}` : '从未分析',
        ].join('；'),
      }
    },
  })

  return [scanTool, analyzeTool, reportTool, askTool, updateTool, statusTool]
}

/** 工具名清单（`lib/index.js` 汇报用）。 */
export const TOOL_SUFFIXES = ['scan', 'analyze', 'report', 'ask', 'update', 'status']

/** 全部工具名。 */
export const TOOL_NAMES = TOOL_SUFFIXES.map((suffix) => `${TOOL_PREFIX}${suffix}`)

/** 插件版本（工具层透出，便于排查"报告是哪个版本生成的"）。 */
export const TOOL_VERSION = VERSION
