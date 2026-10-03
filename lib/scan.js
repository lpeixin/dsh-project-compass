/**
 * FR1 项目侦察层：把一个目录降级为结构化画像 `Profile`（内部契约 §4，形状冻结）。
 *
 * 设计要点：
 *   - **永不抛错**：I/O、权限、损坏 JSON、超长文件、符号链接循环全部降级为 `warnings`；
 *   - **迭代式 DFS**：显式栈，不做递归，深目录不会爆栈；默认 `followSymlinks=false`，
 *     跟随符号链接时用 `realpath` 做环路保护；
 *   - **安全红线**：命中敏感路径只 `stat` 取大小，绝不读取内容（连前 8KB 样本都不读），
 *     只在 `sensitive`（以及路径级的 `configs`）里出现路径与类型；
 *   - **预算**：`maxFiles` / `maxTotalBytes` / `maxDurationMs` 任一超限即 `truncated=true`
 *     并停止深入，同时写 `warnings`。
 *
 * 字段语义的取舍（契约未逐字定义处，按此实现并在报告里说明）：
 *   - `size.files/bytes`：已访问（visited）的文件数与字节数，含敏感文件与二进制文件；
 *   - `size.skipped`：被忽略规则 / 符号链接 / 非普通文件挡掉的条目数（文件+目录）；
 *     敏感文件记入 `sensitive`，不计入 `skipped`；
 *   - `size.dirs`：实际进入的目录数（含根目录）；
 *   - `size.sourceFiles`：已判定为文本且语言属于代码语言的已访问文件数；
 *   - `languages[].bytes/loc`：只统计非敏感、非二进制、且未超 `maxFileBytes` 的文本文件
 *     （超长文本只计 bytes、loc 记 0，并写 warning）；
 *   - `ignore.rules`：三层（内置 + `.gitignore` + `.compassignore`/`options.ignore`）
 *     拼接后的生效规则列表，后写覆盖前写；锁文件被内置规则忽略，但仍会通过目录列举
 *     记录“存在性”，用于工程缺口判定；
 *   - `sources`（契约 r2）：与 `size.files` 同一次遍历、同一套忽略规则产出的文件清单，
 *     长度恒等于 `size.files`；二进制 `binary=true`（loc 0），敏感文件 `sensitive=true`
 *     （只 stat 出 bytes，不读内容），超长未读文本 `loc=0` 并写 warning；按 path 升序；
 *   - 结构性排除（契约 r3）：`STATE_DIR`（`.project-compass`）与 `DEFAULT_OUTPUT_DIR`
 *     （`docs/project-compass`）恒定排除，另加 `options.exclude` 前缀；它优先于忽略规则与
 *     `include` 白名单，`.gitignore` 取反也无法把它们拉回来，只计 `size.skipped`；
 *   - 入口点（契约 r4）：`main` 只来自 `main`/`module`/`browser`/`exports["."]`，其它
 *     `exports` 子路径标 `export`；manifest 自身永不出现在 `entrypoints`；
 *   - 测试框架（契约 r4）：依赖 + 配置 + 清单 + 脚本命令 + 测试文件内容，
 *     evidence 精确到 `package.json:scripts.test` 或 `path:line`；
 *   - 疑似密钥（契约 r5）：必须同时满足"赋值给密钥名 + 右侧引号字面量/长数字 + 长度阈值"，
 *     密钥词须在标识符末节；测试文件里的条目记 `kind='test-fixture'`、`context='test'`，
 *     仍然绝不记录取值；
 *   - `configs`（契约 r5）：只收运行时配置与环境变量来源，vcs/编辑器/工具开关 dotfile 不入列；
 *   - `.env*` 按契约字面归入敏感（模板名给 kind `env-template`，同样不读取内容）。
 *
 * @module dsh-project-compass/scan
 */

import { constants } from 'node:fs'
import { open, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

// 文件 kind 与 IR 层用同一套取值（契约 r2），避免两处口径漂移
import { fileKindOf } from './ir.js'
import { IGNORE_FILE, DEFAULT_OUTPUT_DIR, STATE_DIR } from './paths.js'
import { listDir, pathExists, readTextFile, statSafe } from './store.js'
import {
  clip,
  countLines,
  decodeText,
  extensionOf,
  isBinarySample,
  matchGlob,
  matchIgnoreRules,
  splitIdentifier,
  stripExtension,
  toPosix,
  trimTrailingSlash,
  uniq,
} from './util.js'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 单文件只读前 8KB 做二进制判定（与 util.isBinarySample 口径一致）。 */
const SAMPLE_BYTES = 8192
/** `signals.largeFiles` 阈值。 */
const LARGE_FILE_BYTES = 512 * 1024
/** 工程缺口里“单文件超大”的阈值。 */
const HUGE_FILE_BYTES = 1024 * 1024
const MAX_TODOS = 500
const MAX_SECRETS = 200
const MAX_ENTRYPOINTS = 200
const MAX_WARNINGS = 200
const MAX_DECLARED_DEPTH = 6

/** command preset 的稳定顺序（契约 §4）。 */
const PRESET_ORDER = ['install', 'build', 'typecheck', 'lint', 'format', 'test', 'coverage', 'e2e', 'start', 'dev']

/** kinds 的稳定顺序（契约 §4）。 */
const KIND_ORDER = ['cli', 'library', 'web-app', 'api-service', 'monorepo', 'plugin', 'data', 'docs-only']

/** 锁文件（内置忽略规则会跳过它们，但存在性要用于缺口判定）。 */
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'poetry.lock',
  'pipfile.lock',
  'cargo.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
])

/** 扩展名 → 语言（与 lib/parse 的 SUPPORTED_LANGUAGES 保持同名）。 */
const LANGUAGE_BY_EXTENSION = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.tsx': 'tsx',
  '.jsx': 'jsx',
  '.py': 'python',
  '.pyi': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.swift': 'swift',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  '.sass': 'css',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.json': 'json',
  '.json5': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',
}

/** 计入 `size.sourceFiles` 的“代码”语言。 */
const CODE_LANGUAGES = new Set([
  'typescript', 'javascript', 'tsx', 'jsx', 'python', 'java', 'go', 'rust', 'c', 'cpp',
  'csharp', 'ruby', 'php', 'kotlin', 'scala', 'swift', 'shell', 'sql', 'vue', 'svelte', 'html', 'css',
])

/** 数据类扩展名（kinds= data 判定用）。 */
const DATA_EXTENSIONS = new Set(['.ipynb', '.sql', '.csv', '.tsv', '.parquet', '.arrow'])

/* ------------------------------------------------------------------ *
 * 忽略规则
 * ------------------------------------------------------------------ */

const DEFAULT_IGNORE_RULES = [
  // 依赖与包管理器产物
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.yarn',
  // 版本控制
  '.git',
  '.hg',
  '.svn',
  // 构建与产物
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.nyc_output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.angular',
  '.dart_tool',
  'DerivedData',
  'Pods',
  // 语言生态缓存
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.gradle',
  '.idea',
  '.vscode',
  '.terraform',
  '.serverless',
  '.fusebox',
  '.dynamodb',
  '.sass-cache',
  // 第三方代码
  'vendor',
  // 杂项
  '.DS_Store',
  '.eslintcache',
  // 本工具自身状态目录与报告输出目录：结构性排除（常量来自 paths.js，不硬编码）
  STATE_DIR,
  DEFAULT_OUTPUT_DIR,
  // 压缩 / 映射产物
  '*.min.js',
  '*.min.css',
  '*.map',
  // 锁文件与日志（锁文件不参与语言统计，存在性另行记录）
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '*.log',
  '*.snap',
]

/** 内置默认忽略规则（返回副本，调用方可安全修改）。 */
export function defaultIgnoreRules() {
  return [...DEFAULT_IGNORE_RULES]
}

/* ------------------------------------------------------------------ *
 * 敏感路径识别
 * ------------------------------------------------------------------ */

/** 环境变量“模板”文件名：仍按契约 `.env*` 归为敏感（不读取），但不会触发 P0 入库风险缺口。 */
const ENV_TEMPLATE_RE = /^\.env\.(?:example|sample|template|dist|example\.[a-z0-9]+)$/i

const SENSITIVE_RULES = [
  { pattern: '.env*', kind: 'env', reason: '环境变量文件，可能包含口令与令牌' },
  { pattern: '*.pem', kind: 'certificate', reason: 'PEM 证书/私钥文件' },
  { pattern: '*.key', kind: 'private-key', reason: '私钥文件' },
  { pattern: 'id_rsa*', kind: 'ssh-key', reason: 'SSH 私钥' },
  { pattern: 'id_dsa*', kind: 'ssh-key', reason: 'SSH 私钥' },
  { pattern: 'id_ecdsa*', kind: 'ssh-key', reason: 'SSH 私钥' },
  { pattern: 'id_ed25519*', kind: 'ssh-key', reason: 'SSH 私钥' },
  { pattern: 'credentials*', kind: 'credentials', reason: '凭据文件' },
  { pattern: 'credentials.json', kind: 'credentials', reason: '云凭据文件' },
  { pattern: 'secrets*', kind: 'secrets', reason: '密钥清单文件' },
  { pattern: '.npmrc', kind: 'registry-token', reason: 'npm registry 令牌' },
  { pattern: '.pypirc', kind: 'registry-token', reason: 'PyPI 上传令牌' },
  { pattern: '.netrc', kind: 'credentials', reason: 'netrc 凭据' },
  { pattern: '.git-credentials', kind: 'credentials', reason: 'git 明文凭据' },
  { pattern: '.htpasswd', kind: 'credentials', reason: 'HTTP 基本认证口令' },
  { pattern: '*.p12', kind: 'keystore', reason: 'PKCS#12 密钥库' },
  { pattern: '*.pfx', kind: 'keystore', reason: 'PKCS#12 密钥库' },
  { pattern: '*.jks', kind: 'keystore', reason: 'Java 密钥库' },
  { pattern: '*.keystore', kind: 'keystore', reason: 'Java 密钥库' },
  { pattern: '.aws/**', kind: 'cloud-credentials', reason: 'AWS 凭据目录' },
  { pattern: '.ssh/**', kind: 'ssh-config', reason: 'SSH 配置与私钥目录' },
  { pattern: '.docker/config.json', kind: 'docker-credentials', reason: 'Docker registry 凭据' },
  { pattern: 'serviceAccount*.json', kind: 'service-account', reason: 'GCP 服务账号密钥' },
  { pattern: 'service-account*.json', kind: 'service-account', reason: 'GCP 服务账号密钥' },
  { pattern: 'kubeconfig', kind: 'kubeconfig', reason: 'Kubernetes 集群凭据' },
  { pattern: '*.kubeconfig', kind: 'kubeconfig', reason: 'Kubernetes 集群凭据' },
  { pattern: '*.tfstate', kind: 'terraform-state', reason: 'Terraform state 常含明文密钥' },
  { pattern: 'terraform.tfstate*', kind: 'terraform-state', reason: 'Terraform state 常含明文密钥' },
]

/**
 * 判定相对路径是否命中敏感文件/目录。
 *
 * 只做路径匹配，**不触碰文件系统**；调用方命中后只能 `stat`，不得读取内容。
 * @param relPath 相对 posix 路径（也接受任意带分隔符的路径片段）。
 * @returns {{sensitive: boolean, kind: string|null, reason: string|null}}
 */
export function isSensitivePath(relPath) {
  const raw = trimTrailingSlash(toPosix(String(relPath ?? '')).replace(/^\.\//, ''))
  if (raw.length === 0) return { sensitive: false, kind: null, reason: null }

  const base = path.posix.basename(raw)
  if (ENV_TEMPLATE_RE.test(base)) {
    return {
      sensitive: true,
      kind: 'env-template',
      reason: '环境变量模板文件；按契约 `.env*` 归类为敏感，同样不读取内容',
    }
  }

  const candidates = uniq([raw, raw.toLowerCase()])
  for (const rule of SENSITIVE_RULES) {
    for (const candidate of candidates) {
      // 目录形态的规则（`.aws/**`）用 `/ _` 探针让目录本身也能命中
      if (matchGlob(rule.pattern, candidate) || matchGlob(rule.pattern, `${candidate}/_`)) {
        return { sensitive: true, kind: rule.kind, reason: rule.reason }
      }
    }
  }
  return { sensitive: false, kind: null, reason: null }
}

/** 叠加 `options.extraSensitivePatterns` 的敏感判定。 */
function detectSensitive(ctx, rel) {
  const base = isSensitivePath(rel)
  if (base.sensitive) return base
  for (const pattern of ctx.config.extraSensitivePatterns) {
    if (matchGlob(pattern, rel) || matchGlob(pattern, `${rel}/_`)) {
      return { sensitive: true, kind: 'custom', reason: `命中 extraSensitivePatterns: ${pattern}` }
    }
  }
  return base
}

/* ------------------------------------------------------------------ *
 * 选项与上下文
 * ------------------------------------------------------------------ */

function positiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.trunc(n))
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime()
  const n = Number(value)
  return Number.isFinite(n) ? n : Date.now()
}

function normalizeOptions(options) {
  const o = options && typeof options === 'object' ? options : {}
  return {
    ignore: Array.isArray(o.ignore) ? o.ignore.map((v) => String(v)) : [],
    include: Array.isArray(o.include) ? o.include.map((v) => String(v)) : [],
    followSymlinks: o.followSymlinks === true,
    maxFiles: positiveInt(o.maxFiles, 20000),
    maxFileBytes: positiveInt(o.maxFileBytes, 262144),
    maxTotalBytes: positiveInt(o.maxTotalBytes, 67108864),
    maxDurationMs: positiveInt(o.maxDurationMs, 600000),
    exclude: Array.isArray(o.exclude) ? o.exclude.map((v) => String(v)) : [],
    extraSensitivePatterns: Array.isArray(o.extraSensitivePatterns) ? o.extraSensitivePatterns.map((v) => String(v)) : [],
    now: typeof o.now === 'function' ? o.now : () => new Date(),
  }
}

/** 警告收集器：去重 + 上限，避免超大仓库把 warnings 撑爆。 */
function createWarningSink(limit = MAX_WARNINGS) {
  const seen = new Set()
  const list = []
  let dropped = 0
  return {
    list,
    add(message) {
      const text = clip(String(message ?? '').replace(/\s+/g, ' ').trim(), 300)
      if (text.length === 0 || seen.has(text)) return
      if (list.length >= limit) {
        dropped += 1
        return
      }
      seen.add(text)
      list.push(text)
    },
    finish() {
      if (dropped > 0) list.push(`另有 ${dropped} 条警告因数量上限被省略`)
      return list
    },
  }
}

function baseProfile(rootAbs, startedAtMs) {
  return {
    root: rootAbs,
    name: path.basename(rootAbs) || rootAbs,
    scannedAt: new Date(startedAtMs).toISOString(),
    durationMs: 0,
    size: { files: 0, dirs: 0, bytes: 0, sourceFiles: 0, skipped: 0, truncated: false },
    languages: [],
    kinds: [],
    ecosystems: [],
    commands: [],
    entrypoints: [],
    configs: [],
    docs: [],
    ci: [],
    containers: [],
    iac: [],
    tests: { frameworks: [], testFiles: [], testFileCount: 0, coverageConfig: [] },
    deps: { direct: [], dev: [], notable: [] },
    signals: {
      todoCount: 0,
      todos: [],
      debugStatementCount: 0,
      secretSuspects: [],
      largeFiles: [],
      generatedFiles: [],
    },
    sensitive: [],
    ignore: { rules: [], sources: [] },
    gaps: [],
    warnings: [],
    truncated: false,
    // 进入分析的文件清单（契约 r2）：与 size.files 同一次遍历、同一套忽略规则
    sources: [],
  }
}

function createContext(rootAbs, config) {
  const startedAtMs = toMillis(config.now())
  const excludeConfig = buildExcludeConfig(config)
  return {
    rootAbs,
    config,
    startedAtMs,
    profile: baseProfile(rootAbs, startedAtMs),
    sink: createWarningSink(),
    truncated: false,
    // 结构性排除（工具自身产物 + options.exclude）：不受 .gitignore 取反影响
    excludePrefixes: excludeConfig.prefixes,
    excludePatterns: excludeConfig.patterns,
    languages: new Map(),
    allPaths: new Set(),
    lockfiles: new Set(),
    sensitiveKeys: new Set(),
    configs: [],
    docs: new Set(),
    ci: [],
    containers: new Set(),
    iac: new Set(),
    testFiles: new Set(),
    generatedFiles: new Set(),
    ecosystems: [],
    entrypoints: [],
    entrypointKeys: new Set(),
    declaredEntrypoints: [],
    commandHints: [],
    coverageHints: [],
    frameworkEvidence: new Map(),
    depNames: new Set(),
    depVersions: new Map(),
    depDisplay: new Map(),
    depEvidence: new Map(),
    unpinned: [],
    debugSamples: [],
    secretKeys: new Set(),
    largeFileSizes: new Map(),
    dockerfileHealthcheck: new Set(),
    dataFiles: 0,
    todoCapped: false,
    entrypointCapped: false,
    ignoreRules: [],
    ignoreSources: [],
    projectName: undefined,
    rootScripts: undefined,
    rootPackageJson: undefined,
    packageManager: undefined,
    monorepo: false,
    hasBin: false,
    hasMainField: false,
    pluginHint: false,
    cliHint: false,
    warn(message) {
      this.sink.add(message)
    },
    /** 相对于 injected `now` 的已耗时（测试可注入假时钟）。 */
    elapsedMs() {
      return toMillis(this.config.now()) - this.startedAtMs
    },
    /** 是否已超出 maxDurationMs 预算。 */
    expired() {
      return this.elapsedMs() > this.config.maxDurationMs
    },
    truncate(message) {
      this.truncated = true
      this.sink.add(message)
    },
  }
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 扫描项目并产出契约 §4 的 `Profile`。
 * @param root 项目根目录（相对路径按进程工作目录解析）。
 * @param options 见模块注释与任务说明。
 * @returns {Promise<object>} Profile（永不抛错）。
 */
export async function scanProject(root, options = {}) {
  const config = normalizeOptions(options)
  const rootAbs = path.resolve(String(root ?? '.'))
  const ctx = createContext(rootAbs, config)

  try {
    const info = await statSafe(rootAbs)
    if (!info || !info.isDirectory()) {
      ctx.warn(`根路径不可扫描（不存在或不是目录），返回空画像：${rootAbs}`)
      return finalizeProfile(ctx)
    }

    const gitignore = await readIgnoreFile(ctx, path.join(rootAbs, '.gitignore'), '.gitignore')
    const assignore = await readIgnoreFile(ctx, path.join(rootAbs, IGNORE_FILE), IGNORE_FILE)
    ctx.ignoreRules = [
      ...defaultIgnoreRules(),
      ...gitignore.rules,
      ...assignore.rules,
      ...config.ignore.filter((rule) => rule.trim().length > 0),
    ]
    ctx.ignoreSources = [
      'builtin',
      ...(gitignore.found ? ['.gitignore'] : []),
      ...(assignore.found ? [IGNORE_FILE] : []),
      ...(config.ignore.length > 0 ? ['options.ignore'] : []),
      'exclude',
    ]

    await traverse(ctx)
  } catch (error) {
    // 兜底：任何未预期异常都不允许冒泡
    ctx.warn(`扫描过程中出现未预期错误，已降级：${error instanceof Error ? error.message : String(error)}`)
  }
  return finalizeProfile(ctx)
}

/** 读取忽略规则文件（软失败；存在但读不到时写 warning）。 */
async function readIgnoreFile(ctx, abs, label) {
  const exists = await pathExists(abs, constants.F_OK)
  if (!exists) return { found: false, rules: [] }
  const text = await readTextFile(abs, undefined)
  if (typeof text !== 'string') {
    ctx.warn(`忽略规则文件存在但读取失败，已忽略：${label}`)
    return { found: false, rules: [] }
  }
  const rules = text
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  return { found: true, rules }
}

function isIgnoredPath(ctx, rel) {
  return matchIgnoreRules(rel, ctx.ignoreRules)
}

function isForceIncluded(ctx, rel) {
  return ctx.config.include.some((pattern) => matchGlob(pattern, rel))
}

/** 取 include 模式里 glob 之前的字面前缀，用于判断“还要不要为了白名单往下走”。 */
function includeLiteralPrefix(pattern) {
  const clean = toPosix(String(pattern ?? '')).replace(/^!/, '').replace(/^\//, '')
  const parts = clean.split('/')
  const out = []
  for (const part of parts) {
    if (/[*?{[]/.test(part)) break
    out.push(part)
  }
  return out.join('/')
}

function couldContainInclude(ctx, rel) {
  if (ctx.config.include.length === 0) return false
  for (const pattern of ctx.config.include) {
    const prefix = includeLiteralPrefix(pattern)
    if (prefix.length === 0) return true
    if (prefix === rel || prefix.startsWith(`${rel}/`)) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * 结构性排除（契约 r3）
 * ------------------------------------------------------------------ */

/** 归一化排除前缀：posix、去 `./` 与尾斜杠；空/根/绝对/逃逸路径直接丢弃。 */
function normalizeExcludePrefix(value) {
  const raw = toPosix(String(value ?? ''))
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
  if (raw.length === 0 || raw === '.') return undefined
  if (path.posix.isAbsolute(raw)) return undefined
  const normalized = path.posix.normalize(raw)
  if (normalized === '.' || normalized.startsWith('..')) return undefined
  return normalized
}

/** 归一化 exclude 的 glob 形态：保留 `*`/`**`，只做 posix 化与去尾斜杠。 */
function normalizeExcludePattern(value) {
  const raw = toPosix(String(value ?? ''))
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
  if (raw.length === 0 || raw === '.') return undefined
  if (path.posix.isAbsolute(raw) || raw.startsWith('..')) return undefined
  return raw
}

/**
 * 恒定排除：本工具状态目录 + 报告输出目录（常量取自 paths.js），再叠加 options.exclude。
 * 这是"结构性排除"，与 .gitignore 无关：用户写 `!docs/project-compass` 也无法让产物被分析。
 * 每个条目同时按"相对路径前缀"与"忽略规则式 glob"两种口径命中，避免调用方写法差异。
 */
function buildExcludeConfig(config) {
  const sources = [STATE_DIR, DEFAULT_OUTPUT_DIR, ...config.exclude]
  return {
    prefixes: uniq(sources.map((value) => normalizeExcludePrefix(value)).filter((value) => value !== undefined)),
    patterns: uniq(sources.map((value) => normalizeExcludePattern(value)).filter((value) => value !== undefined)),
  }
}

/** 前缀或 glob 命中即排除；前缀语义天然覆盖整棵子树。 */
function isExcludedPath(ctx, rel) {
  for (const prefix of ctx.excludePrefixes) {
    if (rel === prefix || rel.startsWith(`${prefix}/`)) return true
  }
  for (const pattern of ctx.excludePatterns) {
    if (matchGlob(pattern, rel) || matchGlob(pattern, `${rel}/_`)) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * 遍历
 * ------------------------------------------------------------------ */

async function safeRealpath(target) {
  try {
    return await realpath(target)
  } catch {
    return undefined
  }
}

async function traverse(ctx) {
  const stack = [{ abs: ctx.rootAbs, rel: '.' }]
  const seenReal = new Set()
  const rootReal = await safeRealpath(ctx.rootAbs)
  if (rootReal) seenReal.add(rootReal)

  while (stack.length > 0) {
    if (ctx.truncated) break
    if (ctx.expired()) {
      ctx.truncate(`扫描耗时超过上限 ${ctx.config.maxDurationMs}ms，已截断`)
      break
    }
    const dir = stack.pop()
    const readable = await pathExists(dir.abs, constants.R_OK)
    if (!readable) {
      ctx.profile.size.skipped += 1
      ctx.warn(`目录不可读（权限或已消失），已跳过：${dir.rel}`)
      continue
    }
    ctx.profile.size.dirs += 1

    const entries = await listDir(dir.abs)
    const childDirs = []
    for (const entry of entries) {
      if (ctx.truncated) break
      const rel = dir.rel === '.' ? entry.name : `${dir.rel}/${entry.name}`
      const abs = path.join(dir.abs, entry.name)

      // 结构性排除优先于忽略规则与 include 白名单；只计 skipped，不进 sources
      if (isExcludedPath(ctx, rel)) {
        ctx.profile.size.skipped += 1
        continue
      }

      // 锁文件按名字记录存在性（它们被内置忽略规则挡住，不会被 visit）
      if (entry.file && LOCKFILE_NAMES.has(entry.name.toLowerCase())) {
        ctx.lockfiles.add(rel)
        if (entry.name.toLowerCase() === 'poetry.lock') {
          // 契约把 poetry.lock 列为 python 清单，但 *.lock 在默认忽略里：只记存在，不读内容
          ctx.ecosystems.push({ kind: 'python', manifest: rel, name: null, version: null, scripts: {} })
        }
      }

      if (entry.symlink) {
        if (!ctx.config.followSymlinks) {
          ctx.profile.size.skipped += 1
          ctx.warn(`跳过符号链接（followSymlinks=false）：${rel}`)
          continue
        }
        const info = await statSafe(abs)
        if (!info) {
          ctx.profile.size.skipped += 1
          ctx.warn(`符号链接目标不可访问，已跳过：${rel}`)
          continue
        }
        if (info.isDirectory()) {
          const real = await safeRealpath(abs)
          if (real && seenReal.has(real)) {
            ctx.profile.size.skipped += 1
            ctx.warn(`检测到符号链接循环，已跳过：${rel}`)
            continue
          }
          if (real) seenReal.add(real)
          if (!isForceIncluded(ctx, rel) && !couldContainInclude(ctx, rel) && isIgnoredPath(ctx, rel)) {
            ctx.profile.size.skipped += 1
            continue
          }
          childDirs.push({ abs, rel })
          continue
        }
        if (info.isFile()) {
          if (!isForceIncluded(ctx, rel) && isIgnoredPath(ctx, rel)) {
            ctx.profile.size.skipped += 1
            continue
          }
          await handleFile(ctx, rel, abs)
          continue
        }
        ctx.profile.size.skipped += 1
        ctx.warn(`跳过非普通文件：${rel}`)
        continue
      }

      if (entry.dir) {
        if (!isForceIncluded(ctx, rel) && !couldContainInclude(ctx, rel) && isIgnoredPath(ctx, rel)) {
          ctx.profile.size.skipped += 1
          continue
        }
        childDirs.push({ abs, rel })
        continue
      }

      if (!entry.file) {
        ctx.profile.size.skipped += 1
        ctx.warn(`跳过非普通文件：${rel}`)
        continue
      }

      if (!isForceIncluded(ctx, rel) && isIgnoredPath(ctx, rel)) {
        ctx.profile.size.skipped += 1
        continue
      }
      await handleFile(ctx, rel, abs)
    }

    // 逆序入栈，保证字母序 DFS
    for (let i = childDirs.length - 1; i >= 0; i -= 1) stack.push(childDirs[i])
  }
}

/* ------------------------------------------------------------------ *
 * 单文件处理
 * ------------------------------------------------------------------ */

async function handleFile(ctx, rel, abs) {
  if (ctx.truncated) return
  const info = await statSafe(abs)
  if (!info || !info.isFile()) {
    ctx.profile.size.skipped += 1
    ctx.warn(`无法读取文件信息，已跳过：${rel}`)
    return
  }
  const size = info.size

  if (ctx.profile.size.files >= ctx.config.maxFiles) {
    ctx.truncate(`文件数达到上限 ${ctx.config.maxFiles}，已截断扫描`)
    return
  }
  if (ctx.profile.size.bytes >= ctx.config.maxTotalBytes) {
    ctx.truncate(`累计字节达到上限 ${ctx.config.maxTotalBytes}，已截断扫描`)
    return
  }
  if (ctx.expired()) {
    ctx.truncate(`扫描耗时超过上限 ${ctx.config.maxDurationMs}ms，已截断`)
    return
  }

  ctx.profile.size.files += 1
  ctx.profile.size.bytes += size
  ctx.allPaths.add(rel)

  // 路径级分类：只依赖路径，不读内容
  classifyPath(ctx, rel)

  // sources：所有通过忽略规则的文件都在这里登记，后续就地补 loc / binary / sensitive
  const language = languageOfPath(rel)
  const source = {
    path: rel,
    language,
    bytes: size,
    loc: 0,
    binary: false,
    sensitive: false,
    kind: fileKindOf(rel, language),
  }
  ctx.profile.sources.push(source)

  // 安全红线：敏感路径只 stat（size 已拿到），绝不 open
  const sensitive = detectSensitive(ctx, rel)
  if (sensitive.sensitive) {
    source.sensitive = true
    if (!ctx.sensitiveKeys.has(rel)) {
      ctx.sensitiveKeys.add(rel)
      ctx.profile.sensitive.push({ path: rel, kind: sensitive.kind, reason: sensitive.reason })
    }
    return
  }

  if (size === 0) {
    addLanguage(ctx, language, 0, 0)
    return
  }

  // 先读 8KB 样本判二进制；超长文件也只读样本，不读全文
  const sample = await readPrefix(abs, Math.min(size, SAMPLE_BYTES))
  if (sample === undefined) {
    addLanguage(ctx, language, size, 0)
    ctx.warn(`文件读取失败（权限或 I/O），未做内容分析：${rel}`)
    return
  }
  if (isBinarySample(sample)) {
    // 二进制：只计 bytes，loc 保持 0，分析层据此跳过
    source.binary = true
    return
  }

  if (CODE_LANGUAGES.has(language)) ctx.profile.size.sourceFiles += 1
  if (size > LARGE_FILE_BYTES) {
    ctx.profile.signals.largeFiles.push(rel)
    ctx.largeFileSizes.set(rel, size)
  }

  if (size > ctx.config.maxFileBytes) {
    addLanguage(ctx, language, size, 0)
    ctx.warn(`文件超过单文件读取上限 ${ctx.config.maxFileBytes} 字节，只计 bytes 未统计 LOC 与信号：${rel}`)
    return
  }

  const content = await readTextSafe(abs)
  if (content === undefined) {
    addLanguage(ctx, language, size, 0)
    ctx.warn(`文件读取失败（权限或 I/O），未做内容分析：${rel}`)
    return
  }
  const loc = countLines(content)
  source.loc = loc
  addLanguage(ctx, language, size, loc)
  analyzeContent(ctx, rel, language, content)
}

/** 读取文件前 maxBytes 字节（软失败）。 */
async function readPrefix(abs, maxBytes) {
  let handle
  try {
    handle = await open(abs, 'r')
    const buffer = Buffer.allocUnsafe(Math.max(1, maxBytes))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } catch {
    return undefined
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/** 全量读文本（调用方已保证 size <= maxFileBytes）。 */
async function readTextSafe(abs) {
  try {
    return decodeText(await readFile(abs))
  } catch {
    return undefined
  }
}

function addLanguage(ctx, name, bytes, loc) {
  const key = typeof name === 'string' && name.length > 0 ? name : 'text'
  const bucket = ctx.languages.get(key) ?? { name: key, files: 0, loc: 0, bytes: 0 }
  bucket.files += 1
  bucket.loc += loc
  bucket.bytes += bytes
  ctx.languages.set(key, bucket)
}

function languageOfPath(rel) {
  const ext = extensionOf(path.posix.basename(rel))
  return LANGUAGE_BY_EXTENSION[ext] ?? 'text'
}

/* ------------------------------------------------------------------ *
 * 路径级分类
 * ------------------------------------------------------------------ */

/** 配置文件名 → kind。聚焦运行时配置与环境变量来源；vcs/编辑器/工具开关 dotfile 不收集。 */
const CONFIG_BASENAME_RULES = [
  [/^\.env(?:\.|$)/i, 'env'],
  [/^\.eslintrc(?:\.|$)/i, 'lint'],
  [/^eslint\.config\.[cm]?[jt]s$/i, 'lint'],
  [/^\.eslintignore$/i, 'lint'],
  [/^tsconfig(?:\..*)?\.json$/i, 'typescript'],
  [/^jsconfig\.json$/i, 'typescript'],
  [/^jest\.config\.[cm]?[jt]s$/i, 'test'],
  [/^vitest\.config\.[cm]?[jt]s$/i, 'test'],
  [/^playwright\.config\.[cm]?[jt]s$/i, 'test'],
  [/^cypress\.config\.[cm]?[jt]s$/i, 'test'],
  [/^vite\.config\.[cm]?[jt]s$/i, 'build'],
  [/^webpack\.config\.[cm]?[jt]s$/i, 'build'],
  [/^rollup\.config\.[cm]?[jt]s$/i, 'build'],
  [/^esbuild\.config\.[cm]?[jt]s$/i, 'build'],
  [/^babel\.config\.[cm]?[jt]s$/i, 'build'],
  [/^\.babelrc(?:\.|$)/i, 'build'],
  [/^docker-compose.*\.ya?ml$/i, 'container'],
  [/^compose\.ya?ml$/i, 'container'],
  [/^nginx\.conf$/i, 'server'],
  [/^\.prettierrc(?:\.|$)/i, 'format'],
  [/^prettier\.config\.[cm]?[jt]s$/i, 'format'],
  [/^\.prettierignore$/i, 'format'],
  [/^ruff\.toml$/i, 'lint'],
  [/^\.flake8$/i, 'lint'],
  [/^mypy\.ini$/i, 'typecheck'],
  [/^pytest\.ini$/i, 'test'],
  [/^tox\.ini$/i, 'test'],
  [/^setup\.cfg$/i, 'build'],
  [/^\.nycrc(?:\.|$)/i, 'coverage'],
  [/^codecov\.ya?ml$/i, 'coverage'],
  [/^\.codecov\.ya?ml$/i, 'coverage'],
  [/^sonar-project\.properties$/i, 'coverage'],
  [/^Makefile$/i, 'build'],
  [/^CMakeLists\.txt$/i, 'build'],
  // 运行时设置与环境相关配置（契约修订 r5）
  [/^cordis\.patch\.ya?ml$/i, 'plugin'],
  [/^settings\.[a-z0-9]+$/i, 'app'],
  [/^application(?:-[a-z0-9_-]+)?\.(?:ya?ml|properties)$/i, 'app'],
  [/^[^/]+\.config\.(?:[cm]?[jt]s|json5?|ya?ml|toml)$/i, 'app'],
  [/^pnpm-workspace\.ya?ml$/i, 'workspace'],
  [/^lerna\.json$/i, 'workspace'],
  [/^nx\.json$/i, 'workspace'],
  [/^turbo\.json$/i, 'workspace'],
  [/^rush\.json$/i, 'workspace'],
]

/** 目录形态的配置来源：`config/*`、`configs/*`、`conf/*`。 */
const CONFIG_PATH_RULES = [[/^(?:config|configs|conf)\//i, 'runtime']]

function configKindOf(base, rel) {
  for (const [regex, kind] of CONFIG_BASENAME_RULES) if (regex.test(base)) return kind
  for (const [regex, kind] of CONFIG_PATH_RULES) if (regex.test(rel)) return kind
  return undefined
}

function isDocPath(rel, base) {
  if (/^readme/i.test(base) || /^changelog/i.test(base) || /^contributing/i.test(base)) return true
  if (/(^|\/)(adr|docs?)\//i.test(rel) && /\.(?:md|mdx|markdown|txt|rst|adoc)$/i.test(base)) return true
  if (!rel.includes('/') && /\.(?:md|mdx|markdown|rst)$/i.test(base)) return true
  return false
}

const CI_RULES = [
  [/^\.github\/workflows\/.+\.ya?ml$/i, 'github-actions'],
  [/^\.gitlab-ci\.ya?ml$/i, 'gitlab-ci'],
  [/(^|\/)Jenkinsfile$/i, 'jenkins'],
  [/^\.circleci\/config\.ya?ml$/i, 'circleci'],
  [/^azure-pipelines\.ya?ml$/i, 'azure-pipelines'],
  [/^bitbucket-pipelines\.ya?ml$/i, 'bitbucket-pipelines'],
  [/^\.travis\.ya?ml$/i, 'travis'],
  [/^\.drone\.ya?ml$/i, 'drone'],
  [/^\.woodpecker\.ya?ml$/i, 'woodpecker'],
]

function ciIdOf(rel) {
  for (const [regex, id] of CI_RULES) if (regex.test(rel)) return id
  return undefined
}

function isContainerPath(base, rel) {
  if (/^Dockerfile(\..+)?$/i.test(base)) return true
  if (/\.dockerfile$/i.test(base)) return true
  if (/^docker-compose.*\.ya?ml$/i.test(base)) return true
  if (/^compose\.ya?ml$/i.test(base)) return true
  return false
}

function isIacPath(rel, base) {
  if (/\.tf(vars)?\.json$/i.test(base)) return true
  if (/\.tfvars$/i.test(base)) return true
  if (/\.tf$/i.test(base)) return true
  if (/^ansible\.cfg$/i.test(base)) return true
  if (/^playbook.*\.ya?ml$/i.test(base)) return true
  if (/(^|\/)(k8s|kubernetes|manifests)\//i.test(rel)) return true
  if (/(^|\/)helm\//i.test(rel)) return true
  if (/^Chart\.ya?ml$/i.test(base)) return true
  if (/^serverless\.ya?ml$/i.test(base)) return true
  if (/^pulumi/i.test(base)) return true
  return false
}

const TEST_FILE_RULES = [
  /(^|\/)(tests?|__tests__|spec|specs)\//i,
  /(^|\/)tests?\.[cm]?[jt]s$/i,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_.*\.py$/i,
  /(^|\/).*_test\.py$/i,
  /(^|\/)[^/]*(?:Test|Tests|IT)\.java$/,
  /(^|\/).*_test\.go$/i,
  /(^|\/).*_spec\.rb$/i,
  /(^|\/)[^/]*Test\.php$/i,
  /(^|\/)[^/]*Tests?\.cs$/i,
]

function isTestFilePath(rel) {
  return TEST_FILE_RULES.some((regex) => regex.test(rel))
}

const GENERATED_RULES = [
  /\.pb\.go$/i,
  /_pb2\.py$/i,
  /_pb2_grpc\.py$/i,
  /\.g\.dart$/i,
  /\.min\.(?:js|css|mjs)$/i,
  /\.generated\./i,
  /(^|\/)dist\//i,
  /(^|\/)generated\//i,
  /(^|\/)__generated__\//i,
]

function isGeneratedPath(rel) {
  return GENERATED_RULES.some((regex) => regex.test(rel))
}

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.py', '.go', '.rs',
  '.rb', '.php', '.java', '.kt', '.kts', '.swift', '.sh', '.bash', '.zsh', '.scala', '.cs',
])

/** 路径级入口点判定（无需读内容）。 */
function pathEntrypointKinds(rel) {
  const out = []
  const base = path.posix.basename(rel)
  const dir = path.posix.dirname(rel)
  const stem = stripExtension(base)
  const ext = extensionOf(base)

  if (base === '__main__.py') out.push({ kind: 'main', evidence: 'Python 包入口 __main__.py' })
  if (base === 'manage.py') out.push({ kind: 'cli', evidence: 'Django manage.py' })
  if (base === 'wsgi.py' || base === 'asgi.py') out.push({ kind: 'http-server', evidence: `Python 服务入口 ${base}` })

  if (!CODE_EXTENSIONS.has(ext)) return out

  const entryDirs = ['.', 'src', 'lib', 'app', 'cmd', 'bin']
  if ((stem === 'index' || stem === 'main') && entryDirs.includes(dir)) {
    out.push({ kind: 'main', evidence: `入口命名约定：${rel}` })
  } else if ((stem === 'server' || stem === 'app') && (dir === '.' || dir === 'src' || dir === 'app')) {
    out.push({ kind: 'http-server', evidence: `服务入口命名约定：${rel}` })
  } else if ((dir === 'bin' || dir.endsWith('/bin')) && stem !== 'index') {
    out.push({ kind: 'bin', evidence: `bin/ 目录下的可执行脚本：${rel}` })
  }
  if (/(^|\/)(worker|workers)(\/|$)/i.test(rel) || /^worker\.[cm]?[jt]s$/i.test(base)) {
    out.push({ kind: 'worker', evidence: `worker 命名约定：${rel}` })
  }
  if (/(^|\/)(tests?|__tests__)\/(?:index|setup|main)\.[cm]?[jt]s$/i.test(rel)) {
    out.push({ kind: 'test-entry', evidence: `测试入口：${rel}` })
  }
  return out
}

function classifyPath(ctx, rel) {
  const base = path.posix.basename(rel)

  const configKind = configKindOf(base, rel)
  if (configKind) ctx.configs.push({ path: rel, kind: configKind })

  if (isDocPath(rel, base)) ctx.docs.add(rel)

  const ciId = ciIdOf(rel)
  if (ciId) ctx.ci.push({ id: ciId, path: rel })

  if (isContainerPath(base, rel)) ctx.containers.add(rel)
  if (isIacPath(rel, base)) ctx.iac.add(rel)
  if (isTestFilePath(rel)) ctx.testFiles.add(rel)
  if (isGeneratedPath(rel)) ctx.generatedFiles.add(rel)
  if (DATA_EXTENSIONS.has(extensionOf(base))) ctx.dataFiles += 1

  for (const entry of pathEntrypointKinds(rel)) addEntrypoint(ctx, rel, entry.kind, entry.evidence)
}

function normalizeRel(value) {
  const raw = toPosix(String(value ?? '')).replace(/^\.\//, '')
  if (raw.length === 0) return undefined
  const normalized = path.posix.normalize(raw)
  if (normalized === '.' || normalized.startsWith('..')) return undefined
  return normalized
}

function addEntrypoint(ctx, relTarget, kind, evidence) {
  if (ctx.entrypoints.length >= MAX_ENTRYPOINTS) {
    if (!ctx.entrypointCapped) {
      ctx.entrypointCapped = true
      ctx.warn(`入口点数量超过 ${MAX_ENTRYPOINTS} 条，后续仅忽略`)
    }
    return
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(relTarget ?? ''))) return
  const rel = normalizeRel(relTarget)
  if (!rel) return
  // manifest 自身（package.json / pyproject.toml / pom.xml 等）永远不是入口点，它们已在 ecosystems 里
  if (isManifestPath(rel)) return
  const key = `${rel}|${kind}`
  if (ctx.entrypointKeys.has(key)) return
  ctx.entrypointKeys.add(key)
  ctx.entrypoints.push({ path: rel, kind, evidence: clip(String(evidence ?? ''), 200) })
}

/* ------------------------------------------------------------------ *
 * 内容分析：入口点 / 框架 / 测试 / 覆盖率 / 清单 / 信号
 * ------------------------------------------------------------------ */

const MANIFEST_BASENAMES = new Set([
  'package.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  'pipfile',
  'poetry.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'cargo.toml',
  'composer.json',
  'gemfile',
  'cmakelists.txt',
  'makefile',
  'pubspec.yaml',
  'package.swift',
])

function isManifestPath(rel) {
  const base = path.posix.basename(rel).toLowerCase()
  return MANIFEST_BASENAMES.has(base) || base.endsWith('.csproj') || base.endsWith('.sln')
}

function analyzeContent(ctx, rel, language, content) {
  const base = path.posix.basename(rel)
  const rootLevel = !rel.includes('/')

  collectContentEntrypoints(ctx, rel, language, content)
  collectConfigHints(ctx, rel, base, content, rootLevel)
  collectTestFileFrameworkHints(ctx, rel, content)
  collectCoverageHints(ctx, rel, base, content)
  if (isManifestPath(rel)) parseManifest(ctx, rel, content, rootLevel)
  scanLines(ctx, rel, content)
}

function lineAt(content, index) {
  let line = 1
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1
  }
  return line
}

/**
 * 等长去注释（`/* *\/` 与 `//`），只用于降低内容启发式的误报：
 * 长度不变，所以匹配下标仍可直接喂给 `lineAt(content, index)`。
 */
function stripComments(text) {
  return String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])(\/\/[^\n]*)/g, (match, prefix, comment) => prefix + ' '.repeat(comment.length))
}

function firstMatch(text, regex) {
  const m = regex.exec(text)
  return m && m[1] ? m[1].trim() : undefined
}

function collectContentEntrypoints(ctx, rel, language, content) {
  const base = path.posix.basename(rel)

  // 测试文件不是程序入口：里面的 express()/main() 调用只是夹具。
  // 测试入口由路径规则给出的 test-entry 表达。
  if (isTestFilePath(rel)) return

  if (language === 'python') {
    const guard = /^[ \t]*if\s+__name__\s*==\s*['"]__main__['"]\s*:/m.exec(content)
    if (guard) {
      addEntrypoint(ctx, rel, 'cli', `if __name__ == '__main__' (行 ${lineAt(content, guard.index)})`)
    }
    if (/^\s*(?:import|from)\s+argparse\b/m.test(content)) ctx.cliHint = true
    if (/^\s*(?:import|from)\s+(?:click|typer)\b/m.test(content)) ctx.cliHint = true
  }

  if (language === 'java') {
    const main = /public\s+static\s+void\s+main\s*\(/.exec(content)
    if (main) addEntrypoint(ctx, rel, 'main', `public static void main (行 ${lineAt(content, main.index)})`)
    const boot = /@SpringBootApplication/.exec(content)
    if (boot) {
      addEntrypoint(ctx, rel, 'http-server', `@SpringBootApplication (行 ${lineAt(content, boot.index)})`)
      ctx.depNames.add('spring-boot')
    }
    if (/@(?:RestController|Controller|RequestMapping|GetMapping|PostMapping)/.test(content)) {
      ctx.depNames.add('spring-boot')
    }
  }

  if (language === 'javascript' || language === 'typescript' || language === 'jsx' || language === 'tsx') {
    const firstLine = content.split('\n', 1)[0] ?? ''
    if (/^#!.*\b(?:node|deno|bun)\b/.test(firstLine)) {
      addEntrypoint(ctx, rel, 'bin', `shebang ${clip(firstLine, 80)}`)
      ctx.cliHint = true
    }
    // 去掉注释再匹配（等长替换，行号仍可用），并要求"创建服务 + 监听"两个信号同时出现
    const code = stripComments(content)
    const bootstrap = /\bexpress\s*\(|\bnew\s+Koa\s*\(|\bfastify\s*\(|\bcreateServer\s*\(|\bcreateApp\s*\(|\bNestFactory\.create\s*\(/.exec(code)
    const listens = /\.listen\s*\(|\bBun\.serve\s*\(/.test(code)
    if (bootstrap && listens) {
      addEntrypoint(ctx, rel, 'http-server', `HTTP 服务创建 + 监听调用 (行 ${lineAt(content, bootstrap.index)})`)
    }
    if (/require\(\s*['"](?:commander|yargs|oclif)['"]\s*\)|from\s+['"](?:commander|yargs|@oclif\/core)['"]/.test(code)) {
      ctx.cliHint = true
    }
  }

  if (language === 'go') {
    if (/\bfunc\s+main\s*\(\s*\)/.test(content) && /(^|\/)(?:main|cmd\/[^/]+)\//.test(`/${rel}`)) {
      addEntrypoint(ctx, rel, 'main', 'func main()')
    }
  }

  if (language === 'rust') {
    if (/\bfn\s+main\s*\(\s*\)/.test(content) && /(^|\/)(?:main\.rs|bin\/[^/]+\.rs)$/.test(rel)) {
      addEntrypoint(ctx, rel, 'main', 'fn main()')
    }
  }

  if (/^Dockerfile(\..+)?$/i.test(base) || /\.dockerfile$/i.test(base)) {
    const directive = /^[ \t]*(CMD|ENTRYPOINT)\b(.*)$/m.exec(content)
    if (directive) {
      addEntrypoint(ctx, rel, 'config', `Dockerfile ${directive[1]} (行 ${lineAt(content, directive.index)})`)
    }
    if (/^[ \t]*HEALTHCHECK\b/m.test(content)) ctx.dockerfileHealthcheck.add(rel)
  }
}

function collectConfigHints(ctx, rel, base, content, rootLevel) {
  if (base === 'pytest.ini' && rootLevel) ctx.commandHints.push({ preset: 'test', argv: ['pytest'], source: rel })
  if (base === 'tox.ini' && rootLevel) ctx.commandHints.push({ preset: 'test', argv: ['tox'], source: rel })
  if (base === 'mypy.ini' && rootLevel) ctx.commandHints.push({ preset: 'typecheck', argv: ['mypy', '.'], source: rel })
  if (base === '.flake8' && rootLevel) ctx.commandHints.push({ preset: 'lint', argv: ['flake8', '.'], source: rel })
}

/**
 * 测试框架判定（契约修订 r4）：除依赖清单外，还要看脚本命令与测试文件内容。
 * 这里只处理"测试文件内容"这一路；脚本与构建命令在 finalize 阶段统一处理。
 * 只看按命名约定识别出的测试文件，不做全仓 import 扫描。
 */
function collectTestFileFrameworkHints(ctx, rel, content) {
  if (!isTestFilePath(rel)) return
  for (const rule of TEST_CONTENT_FRAMEWORK_RULES) {
    const match = rule.re.exec(content)
    if (match) addFrameworkEvidence(ctx, rule.id, rule.label, `${rel}:${lineAt(content, match.index)}`)
  }
}

/** 汇总一条测试框架证据（去重、按 id 归并）。 */
function addFrameworkEvidence(ctx, id, label, evidence) {
  const bucket = ctx.frameworkEvidence.get(id) ?? { id, label, evidence: [] }
  if (evidence && !bucket.evidence.includes(evidence)) bucket.evidence.push(evidence)
  ctx.frameworkEvidence.set(id, bucket)
}

/** 从 package.json scripts 的脚本体判定框架，evidence 精确到 scripts.<name>。 */
function collectScriptFrameworkHints(ctx) {
  for (const name of Object.keys(ctx.rootScripts ?? {}).sort()) {
    const body = String(ctx.rootScripts[name] ?? '')
    const text = `${name} ${body}`
    for (const rule of COMMAND_FRAMEWORK_RULES) {
      if (rule.re.test(text)) addFrameworkEvidence(ctx, rule.id, rule.label, `package.json:scripts.${name}`)
    }
  }
}

/** 从构建命令（mvn/gradle/go/cargo/pytest/tox 等）判定框架，evidence 写清来源文件与命令。 */
function collectCommandFrameworkHints(ctx) {
  for (const hint of ctx.commandHints) {
    if (!['test', 'coverage', 'e2e'].includes(hint.preset)) continue
    const text = hint.argv.map(String).join(' ')
    for (const rule of COMMAND_FRAMEWORK_RULES) {
      if (rule.re.test(text)) addFrameworkEvidence(ctx, rule.id, rule.label, `${hint.source}（${text}）`)
    }
  }
}

function collectCoverageHints(ctx, rel, base, content) {
  if (/^\.nycrc(?:\.|$)/i.test(base) || /^codecov\.ya?ml$/i.test(base) || /^\.codecov\.ya?ml$/i.test(base)) {
    ctx.coverageHints.push(rel)
  }
  if (/^jest\.config\./i.test(base) && /collectCoverage/.test(content)) ctx.coverageHints.push(`${rel}: collectCoverage`)
  if (base === 'package.json' && /collectCoverage/.test(content)) ctx.coverageHints.push(`${rel}: collectCoverage`)
  if (/(?:^|\/)(?:pyproject\.toml|setup\.py|setup\.cfg|pytest\.ini|tox\.ini|requirements\.txt)$/i.test(rel)) {
    if (/pytest-cov|--cov|\[tool\.coverage/.test(content)) ctx.coverageHints.push(`${rel}: pytest --cov`)
  }
  if (/(?:^|\/)(?:pom\.xml|build\.gradle|build\.gradle\.kts)$/i.test(rel) && /jacoco/i.test(content)) {
    ctx.coverageHints.push(`${rel}: jacoco`)
  }
  if (base === '.gitlab-ci.yml' && /coverage/.test(content)) ctx.coverageHints.push(`${rel}: coverage 配置`)
}

/* ------------------------------------------------------------------ *
 * 信号扫描
 * ------------------------------------------------------------------ */

const TODO_RE = /\b(TODO|FIXME|HACK|XXX|NOTE)\b[ \t]*[:：\-]?[ \t]*(.*)$/i
const DEBUG_RE = /\bconsole\.(?:log|debug)\s*\(|\bdebugger\b|\bprint\s*\(|\bSystem\.out\.println\s*\(|\bvar_dump\s*\(|\bfmt\.Print(?:ln|f)?\s*\(/g

/**
 * 疑似硬编码密钥（契约修订 r5，只报位置与类型，绝不记录取值）。
 *
 * 判定必须同时满足：
 *   (a) 形态是"赋值给类密钥名"：`key = x` / `key := x` / `key: x` / `"key": x` / `KEY=x`；
 *   (b) 右侧是**引号字符串字面量或长数字**（`argv[i]`、函数调用、变量引用一律不算）；
 *   (c) 字符串 ≥ 12 字符，或数字 ≥ 16 位；
 * 并且排除比较/成员访问（`token === x`）、复数与派生名（`tokens`/`tokenizer`/`apiKeyName`/
 * `keyPath`/`keydown`/`keyCode`）、CLI flag 值、i18n/locale 语境。
 */
const SECRET_ASSIGNMENT_RE =
  /(?:^|[\s,;{(\[\]"'])(?:(?:const|let|var|final|val|public|private|protected|static|readonly|export|default|self|this|global|\$)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::=|:(?![=:])|=(?![=>]))[ \t]*(.+)$/

/** 类密钥名的最小词元集合（按 splitIdentifier 切词，避免 monkey/hockey 这类误命中）。 */
const SECRET_NAME_PARTS = new Set([
  'password', 'passwd', 'pwd', 'passphrase', 'secret', 'secrets', 'token', 'tokens', 'key', 'keys',
  'apikey', 'apisecret', 'accesstoken', 'authtoken', 'refreshtoken', 'privatekey', 'secretkey',
  'clientsecret', 'credential', 'credentials',
])

/** 复数形态：名字是 tokens/keys/secrets 这类集合，不是单个密钥。 */
const SECRET_PLURAL_PARTS = new Set([
  'tokens', 'keys', 'secrets', 'credentials', 'passwords', 'apikeys', 'accesstokens',
  'refreshtokens', 'authtokens', 'clientsecrets', 'credentiallist', 'keylist',
])

/** 派生名尾词：keydown / keyCode / keyPath / apiKeyName / tokenCount 这类都不是密钥本身。 */
const SECRET_DENY_LAST_PARTS = new Set([
  'count', 'counts', 'len', 'length', 'size', 'index', 'indices', 'name', 'names', 'type', 'types',
  'path', 'paths', 'pattern', 'regex', 'list', 'array', 'map', 'set', 'id', 'ids', 'flag', 'flags',
  'code', 'codes', 'down', 'up', 'press', 'word', 'words', 'frame', 'frames', 'store', 'chain',
  'ring', 'board', 'prefix', 'suffix', 'provider', 'factory', 'manager', 'helper', 'util', 'utils',
  'parser', 'reader', 'writer', 'source', 'options', 'config', 'header', 'headers', 'algorithm',
  'hash', 'format', 'version', 'expiry', 'expires', 'ttl', 'scope', 'scopes', 'issuer', 'audience',
  'subject', 'claims', 'payload', 'enabled', 'disabled', 'required', 'optional', 'refreshable',
  'of', 'value', 'values', 'alias', 'label', 'title', 'desc', 'description',
])

/** i18n / 本地化语境：这里的 key 是文案键，不是密钥。 */
const I18N_PATH_RE = /(?:^|\/)(?:i18n|locale|locales|lang|langs|translations?|messages?)(?:\/|\.|$)/i

function isI18nContext(rel, line, name) {
  if (I18N_PATH_RE.test(rel)) return true
  if (/i18n|locale|translat/i.test(String(name ?? ''))) return true
  return /\bi18n\b|\blocale\b|\btranslation/i.test(line) || /\$t\(/.test(line)
}

/**
 * 类密钥名判定：命中返回 kind，否则 undefined。
 *
 * 关键约束：**密钥词必须落在标识符的最后一节**（`apiKey`/`accessToken`/`db_password` 命中，
 * `keyFlows`/`keyPath`/`apiKeyName`/`tokenCount`/`keyCode` 不命中），
 * 这样派生命中（"key 作为定语"）不会再被当成密钥。
 */
function secretNameVerdict(name) {
  const parts = splitIdentifier(String(name ?? '')).map((part) => part.toLowerCase())
  if (parts.length === 0) return undefined
  const last = parts[parts.length - 1]
  if (!SECRET_NAME_PARTS.has(last)) return undefined
  if (SECRET_PLURAL_PARTS.has(last)) return undefined
  if (SECRET_DENY_LAST_PARTS.has(last)) return undefined
  const joined = parts.join('')
  if (/(?:ize|izer|izing|ized|ization|isation)$/.test(joined)) return undefined
  return secretKindOf(name)
}

/**
 * 取出赋值右侧的字面量：只接受引号字符串或长数字。
 * `argv[index]`、`getToken()`、`process.env.X`、`--flag` 全部返回 undefined。
 */
function extractSecretLiteral(rawValue) {
  const text = String(rawValue ?? '').trim()
  if (text.length === 0 || text.startsWith('-')) return undefined
  const quoted = /^(['"`])([^'"`\n]{0,400})\1/.exec(text)
  if (quoted) {
    const inner = quoted[2]
    if (/(?:process\.env|os\.environ|getenv|import\.meta\.env|System\.getenv|\bENV\[|\$\{|%[A-Z_]+%)/.test(inner)) {
      return undefined
    }
    if (inner.length < 12) return undefined
    if (isPlaceholderValue(inner)) return undefined
    return { type: 'string', length: inner.length }
  }
  const numeric = /^(\d{16,})\b/.exec(text)
  if (numeric) return { type: 'number', length: numeric[1].length }
  return undefined
}

/**
 * 命令/脚本体 → 测试框架（契约修订 r4）。
 * 覆盖 `node --test`、vitest/jest/mocha/playwright/cypress、pytest、go test、
 * mvn|gradle test→junit、rspec、phpunit、cargo test。
 */
const COMMAND_FRAMEWORK_RULES = [
  { id: 'node-test', label: 'node:test', re: /\bnode\s+--test\b|\bnode:test\b|--experimental-test\b/ },
  { id: 'vitest', label: 'Vitest', re: /\bvitest\b/ },
  { id: 'jest', label: 'Jest', re: /\bjest\b/ },
  { id: 'mocha', label: 'Mocha', re: /\bmocha\b/ },
  { id: 'ava', label: 'AVA', re: /\bava\b/ },
  { id: 'jasmine', label: 'Jasmine', re: /\bjasmine\b/ },
  { id: 'playwright', label: 'Playwright', re: /\bplaywright\b/ },
  { id: 'cypress', label: 'Cypress', re: /\bcypress\b/ },
  { id: 'pytest', label: 'pytest', re: /\bpytest\b/ },
  { id: 'go-test', label: 'go test', re: /\bgo\s+test\b/ },
  { id: 'junit', label: 'JUnit', re: /\bmvn\b|\bgradlew?\b/ },
  { id: 'rspec', label: 'RSpec', re: /\brspec\b/ },
  { id: 'phpunit', label: 'PHPUnit', re: /\bphpunit\b/ },
  { id: 'cargo-test', label: 'cargo test', re: /\bcargo\s+test\b/ },
]

/** 测试文件内容 → 测试框架；只对按命名约定识别出的测试文件生效。 */
const TEST_CONTENT_FRAMEWORK_RULES = [
  { id: 'node-test', label: 'node:test', re: /(?:from|require\()\s*['"]node:test['"]/ },
  { id: 'vitest', label: 'Vitest', re: /(?:from|require\()\s*['"]vitest['"]/ },
  { id: 'jest', label: 'Jest', re: /(?:from|require\()\s*['"]@jest\/globals['"]|\bjest\.(?:mock|fn|spyOn)\s*\(/ },
  { id: 'mocha', label: 'Mocha', re: /(?:from|require\()\s*['"]mocha['"]/ },
  { id: 'playwright', label: 'Playwright', re: /(?:from|require\()\s*['"]@playwright\/test['"]/ },
  { id: 'cypress', label: 'Cypress', re: /(?:from|require\()\s*['"]cypress['"]|\bcy\.[a-z]+\s*\(/ },
  { id: 'pytest', label: 'pytest', re: /^\s*(?:import|from)\s+pytest\b/m },
  { id: 'unittest', label: 'unittest', re: /^\s*(?:import|from)\s+unittest\b/m },
  { id: 'junit', label: 'JUnit', re: /^\s*import\s+org\.junit\./m },
  { id: 'testng', label: 'TestNG', re: /^\s*import\s+org\.testng\./m },
  { id: 'go-test', label: 'go test', re: /^\s*func\s+Test[A-Za-z0-9_]*\s*\(\s*\w+\s+\*testing\.T\s*\)/m },
  { id: 'rspec', label: 'RSpec', re: /^\s*require\s+['"]rspec['"]/m },
  { id: 'phpunit', label: 'PHPUnit', re: /\bextends\s+TestCase\b|PHPUnit\\Framework/ },
  { id: 'cargo-test', label: 'cargo test', re: /#\[(?:test|cfg\(test\))\]/ },
]

const PLACEHOLDER_RE =
  /^(?:changeme|change[_-]?me|your[_-]?\w*|placeholder|example|sample|dummy|fake|test|testing|none|null|nil|undefined|true|false|todo|xxx+|\*+|\.+|-+|_+|<[^>]*>|\$\{[^}]*\}|%[A-Z_]+%|redacted|removed|password|passwd|secret|token|string|value|foo|bar|baz)$/i

function isPlaceholderValue(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return true
  if (PLACEHOLDER_RE.test(text)) return true
  if (/(?:placeholder|example|sample|dummy|changeme|change[_-]?me|not[_-]?a[_-]?real|fake)/i.test(text)) return true
  if (/^[a-z]+[_-]?(?:here|goes|placeholder|value)$/i.test(text)) return true
  if (/^(?:sk-)?x{4,}$/i.test(text)) return true
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(text) && /(?:YOUR|MY|EXAMPLE|PLACEHOLDER|CHANGE|SECRET|TOKEN|PASSWORD|KEY)/.test(text)) {
    return true
  }
  return false
}

function secretKindOf(key) {
  const k = String(key ?? '').toLowerCase()
  if (/password|passwd|pwd|passphrase/.test(k)) return 'hardcoded-password'
  if (/token/.test(k)) return 'hardcoded-token'
  if (/secret/.test(k)) return 'hardcoded-secret'
  if (/key/.test(k)) return 'hardcoded-key'
  return 'hardcoded-credential'
}

function scanLines(ctx, rel, content) {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.length === 0) continue
    const lineNo = i + 1

    const todo = TODO_RE.exec(line)
    if (todo) {
      const keyword = todo[1].toUpperCase()
      const rawKeyword = line.slice(todo.index, todo.index + todo[1].length)
      const after = line.slice(todo.index + todo[1].length)
      const separated = /^[ \t]*[:：\-]/.test(after)
      // 普通英文 prose（"Note that ..."）不算 TODO，避免文档噪音
      if (!(keyword === 'NOTE' && rawKeyword !== 'NOTE' && !separated)) {
        ctx.profile.signals.todoCount += 1
        if (ctx.profile.signals.todos.length < MAX_TODOS) {
          ctx.profile.signals.todos.push({
            path: rel,
            line: lineNo,
            text: clip(todo[2] ?? '', 160),
            kind: keyword.toLowerCase(),
          })
        } else if (!ctx.todoCapped) {
          ctx.todoCapped = true
          ctx.warn(`TODO 条目超过 ${MAX_TODOS} 条，超出部分只计数不落盘`)
        }
      }
    }

    DEBUG_RE.lastIndex = 0
    const debug = line.match(DEBUG_RE)
    if (debug) {
      ctx.profile.signals.debugStatementCount += debug.length
      if (ctx.debugSamples.length < 5) ctx.debugSamples.push({ path: rel, line: lineNo })
    }

    if (ctx.profile.signals.secretSuspects.length < MAX_SECRETS) {
      const assignment = SECRET_ASSIGNMENT_RE.exec(line)
      if (assignment) {
        const kind = secretNameVerdict(assignment[1])
        const literal = kind && !isI18nContext(rel, line, assignment[1]) ? extractSecretLiteral(assignment[2]) : undefined
        if (kind && literal) {
          // 测试文件里的夹具单独标注，报告层据此降级展示
          const isTest = isTestFilePath(rel)
          const reportedKind = isTest ? 'test-fixture' : kind
          const key = `${rel}:${lineNo}:${reportedKind}`
          if (!ctx.secretKeys.has(key)) {
            ctx.secretKeys.add(key)
            // 只记录位置与类型，绝不记录疑似密钥值
            ctx.profile.signals.secretSuspects.push({
              path: rel,
              line: lineNo,
              kind: reportedKind,
              context: isTest ? 'test' : 'source',
            })
          }
        }
      }
    } else if (!ctx.secretCapped) {
      ctx.secretCapped = true
      ctx.warn(`疑似密钥数量超过 ${MAX_SECRETS} 条，超出部分只忽略`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 清单解析（生态 / 依赖 / 命令）
 * ------------------------------------------------------------------ */

function addDepName(ctx, name, version, evidenceRel) {
  const key = String(name ?? '').toLowerCase().trim()
  if (key.length === 0) return
  ctx.depNames.add(key)
  if (!ctx.depVersions.has(key)) ctx.depVersions.set(key, version === undefined ? null : version)
  if (!ctx.depDisplay.has(key)) ctx.depDisplay.set(key, String(name).trim())
  if (evidenceRel && !ctx.depEvidence.has(key)) ctx.depEvidence.set(key, evidenceRel)
}

function sortedObjectKeys(obj) {
  return Object.keys(obj ?? {}).sort()
}

function parseManifest(ctx, rel, content, rootLevel) {
  const base = path.posix.basename(rel)
  const lower = base.toLowerCase()
  if (base === 'package.json') return parseNodeManifest(ctx, rel, content, rootLevel)
  if (['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pipfile', 'poetry.lock'].includes(lower)) {
    return parsePythonManifest(ctx, rel, base, content, rootLevel)
  }
  if (['pom.xml', 'build.gradle', 'build.gradle.kts'].includes(lower)) {
    return parseJvmManifest(ctx, rel, base, content, rootLevel)
  }
  if (lower === 'go.mod') return parseGoManifest(ctx, rel, content, rootLevel)
  if (lower === 'cargo.toml') return parseRustManifest(ctx, rel, content, rootLevel)
  if (lower === 'composer.json') return parseComposerManifest(ctx, rel, content, rootLevel)
  if (lower === 'gemfile') return parseRubyManifest(ctx, rel, content, rootLevel)
  if (lower.endsWith('.csproj') || lower.endsWith('.sln')) return parseDotnetManifest(ctx, rel, base)
  if (base === 'CMakeLists.txt' || lower === 'makefile') return parseCMakeManifest(ctx, rel, base, content, rootLevel)
  if (lower === 'pubspec.yaml') return parseDartManifest(ctx, rel, content, rootLevel)
  if (base === 'Package.swift') return parseSwiftManifest(ctx, rel, content, rootLevel)
  return undefined
}

function pushEcosystem(ctx, entry) {
  const scripts = {}
  for (const key of sortedObjectKeys(entry.scripts)) scripts[key] = String(entry.scripts[key])
  ctx.ecosystems.push({
    kind: entry.kind,
    manifest: entry.manifest,
    name: entry.name === undefined ? null : entry.name,
    version: entry.version === undefined ? null : entry.version,
    scripts,
  })
}

function pushCommandHint(ctx, preset, argv, source) {
  ctx.commandHints.push({ preset, argv: argv.map(String), source })
}

function parseNodeManifest(ctx, rel, content, rootLevel) {
  let pkg
  try {
    pkg = JSON.parse(content)
  } catch {
    ctx.warn(`package.json 不是合法 JSON，已降级跳过：${rel}`)
    return
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    ctx.warn(`package.json 结构异常（非对象），已降级跳过：${rel}`)
    return
  }

  const scripts = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {}
  pushEcosystem(ctx, {
    kind: 'node',
    manifest: rel,
    name: typeof pkg.name === 'string' ? pkg.name : null,
    version: typeof pkg.version === 'string' ? pkg.version : null,
    scripts,
  })

  const dir = path.posix.dirname(rel)
  if (pkg.workspaces) ctx.monorepo = true
  if (pkg.dsh) ctx.pluginHint = true
  if (typeof pkg.name === 'string' && /plugin/i.test(pkg.name)) ctx.pluginHint = true

  const depGroups = [
    ['dependencies', pkg.dependencies],
    ['devDependencies', pkg.devDependencies],
    ['peerDependencies', pkg.peerDependencies],
  ]
  const peerKeys = sortedObjectKeys(pkg.peerDependencies)
  if (peerKeys.length > 0) ctx.pluginHint = true

  for (const [, group] of depGroups) {
    if (!group || typeof group !== 'object') continue
    for (const name of sortedObjectKeys(group)) {
      const version = typeof group[name] === 'string' ? group[name] : null
      addDepName(ctx, name, version, rel)
    }
  }

  if (rootLevel) {
    ctx.profile.deps.direct = uniq(sortedObjectKeys(pkg.dependencies))
    ctx.profile.deps.dev = uniq(sortedObjectKeys(pkg.devDependencies))
    ctx.rootPackageJson = pkg
    ctx.rootScripts = {}
    for (const key of sortedObjectKeys(scripts)) ctx.rootScripts[key] = String(scripts[key])
    if (typeof pkg.name === 'string' && pkg.name.trim().length > 0) ctx.projectName = pkg.name.trim()
    if (typeof pkg.packageManager === 'string' && pkg.packageManager.trim().length > 0) {
      ctx.packageManager = pkg.packageManager.trim().split('@')[0]
    }
    for (const [group, bag] of [['dependencies', pkg.dependencies], ['devDependencies', pkg.devDependencies]]) {
      if (!bag || typeof bag !== 'object') continue
      for (const name of sortedObjectKeys(bag)) {
        const version = typeof bag[name] === 'string' ? bag[name] : ''
        if (isUnpinnedVersion(version)) {
          ctx.unpinned.push({ name, group, version, line: findJsonKeyLine(content, name) })
        }
      }
    }
  }

  // 声明的入口点（最终只保留真实存在的文件；manifest 自身会被 addEntrypoint 挡掉）
  const declared = (value, kind, evidence) => {
    const joined = joinRelative(dir, value)
    if (joined) ctx.declaredEntrypoints.push({ path: joined, kind, evidence })
  }
  // main / module / browser / exports["."] 才是"程序入口"；exports 的其它子路径单独标 export
  if (typeof pkg.main === 'string') declared(pkg.main, 'main', `${rel} main`)
  if (typeof pkg.module === 'string') declared(pkg.module, 'main', `${rel} module`)
  if (typeof pkg.browser === 'string') declared(pkg.browser, 'main', `${rel} browser`)
  if (typeof pkg.types === 'string') declared(pkg.types, 'config', `${rel} types`)
  const exportTargets = splitExportTargets(pkg.exports)
  for (const value of exportTargets.main) declared(value, 'main', `${rel} exports["."]`)
  for (const value of exportTargets.export) declared(value, 'export', `${rel} exports 子路径`)
  if (typeof pkg.bin === 'string') {
    declared(pkg.bin, 'bin', `${rel} bin`)
    ctx.hasBin = true
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const name of sortedObjectKeys(pkg.bin)) {
      declared(pkg.bin[name], 'bin', `${rel} bin.${name}`)
    }
    if (sortedObjectKeys(pkg.bin).length > 0) ctx.hasBin = true
  }
  if (pkg.main || pkg.module || pkg.browser || pkg.exports) ctx.hasMainField = true
}

/**
 * 拆解 package.json 的 `exports`：
 *   - 字符串值、或"纯条件对象"（没有任何 `.` 前缀键）→ 描述的是包根 `.`，归入 main；
 *   - 子路径映射：`.` 键归 main，其它 `./xxx` 键归 export（契约修订 r4）。
 * @returns {{main: string[], export: string[]}}
 */
function splitExportTargets(value) {
  const out = { main: [], export: [] }
  if (typeof value === 'string') {
    out.main.push(value)
    return out
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  const keys = Object.keys(value)
  if (!keys.some((key) => key.startsWith('.'))) {
    collectStringLeaves(value, out.main)
    return out
  }
  for (const key of keys) {
    collectStringLeaves(value[key], key === '.' ? out.main : out.export)
  }
  return out
}

/** 递归收集对象/数组里的字符串叶子（exports 条件对象用）。 */
function collectStringLeaves(value, out, depth = 0) {
  if (depth > MAX_DECLARED_DEPTH || value === null || value === undefined) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectStringLeaves(item, out, depth + 1)
  }
}

function joinRelative(dir, value) {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('#')) return undefined
  if (path.posix.isAbsolute(raw)) return undefined
  const joined = dir === '.' ? raw : `${dir}/${raw}`
  return normalizeRel(joined)
}

function isUnpinnedVersion(version) {
  const v = String(version ?? '').trim()
  if (v.length === 0) return true
  if (v === '*' || v === 'latest' || v === 'x' || v === 'next') return true
  if (/^(?:workspace|file|link|portal):/.test(v)) return false
  return false
}

function findJsonKeyLine(content, key) {
  const needle = `"${key}"`
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const index = lines[i].indexOf(needle)
    if (index < 0) continue
    const after = lines[i].slice(index + needle.length).trimStart()
    if (after.startsWith(':')) return i + 1
  }
  return undefined
}

function parsePythonManifest(ctx, rel, base, content, rootLevel) {
  const lower = base.toLowerCase()
  const name = firstMatch(content, /^\s*name\s*=\s*["']([^"']+)["']/m)
  const version = firstMatch(content, /^\s*version\s*=\s*["']([^"']+)["']/m)
  pushEcosystem(ctx, { kind: 'python', manifest: rel, name: name ?? null, version: version ?? null, scripts: {} })
  if (rootLevel && name && !ctx.projectName) ctx.projectName = name

  collectPythonDeps(ctx, rel, lower, content)

  if (rootLevel) {
    if (/\[tool\.pytest/m.test(content) || lower === 'setup.py' || lower === 'setup.cfg') {
      pushCommandHint(ctx, 'test', ['pytest'], rel)
    }
    if (/\[tool\.ruff/m.test(content)) pushCommandHint(ctx, 'lint', ['ruff', 'check', '.'], rel)
    if (/\[tool\.mypy/m.test(content)) pushCommandHint(ctx, 'typecheck', ['mypy', '.'], rel)
    if (/\[tool\.coverage|pytest-cov|--cov/m.test(content)) pushCommandHint(ctx, 'coverage', ['pytest', '--cov'], rel)
    if (lower === 'requirements.txt') pushCommandHint(ctx, 'install', ['pip', 'install', '-r', 'requirements.txt'], rel)
    if (lower === 'pipfile') pushCommandHint(ctx, 'install', ['pipenv', 'install'], rel)
    if (lower === 'setup.py') pushCommandHint(ctx, 'install', ['pip', 'install', '-e', '.'], rel)
    if (lower === 'poetry.lock') pushCommandHint(ctx, 'install', ['poetry', 'install'], rel)
  }
}

function collectPythonDeps(ctx, rel, lowerBase, content) {
  const names = new Set()
  if (lowerBase === 'requirements.txt' || lowerBase === 'pipfile') {
    for (const line of content.split('\n')) {
      const text = line.trim()
      if (text.length === 0 || text.startsWith('#') || text.startsWith('[')) continue
      const m = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(text)
      if (m) names.add(m[1].toLowerCase())
    }
  } else {
    for (const m of content.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*[<>=!~][^"']*)?["']/g)) {
      names.add(m[1].toLowerCase())
    }
    const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(content)
    if (poetry) {
      for (const m of poetry[1].matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm)) names.add(m[1].toLowerCase())
    }
  }
  for (const name of names) addDepName(ctx, name, null, rel)
}

function parseJvmManifest(ctx, rel, base, content, rootLevel) {
  const lower = base.toLowerCase()
  if (lower === 'pom.xml') {
    const artifact = firstMatch(content, /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/)
    const version = firstMatch(content, /<version>\s*([^<\s]+)\s*<\/version>/)
    pushEcosystem(ctx, { kind: 'java', manifest: rel, name: artifact ?? null, version: version ?? null, scripts: {} })
    for (const m of content.matchAll(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g)) addDepName(ctx, m[1], null, rel)
    if (rootLevel) {
      pushCommandHint(ctx, 'test', ['mvn', 'test'], rel)
      pushCommandHint(ctx, 'build', ['mvn', 'package'], rel)
      pushCommandHint(ctx, 'install', ['mvn', 'install'], rel)
    }
    return
  }
  pushEcosystem(ctx, { kind: 'java', manifest: rel, name: null, version: null, scripts: {} })
  for (const m of content.matchAll(/^\s*(?:implementation|api|testImplementation|compile|classpath)\s*[( ]\s*['"]([^:'"]+):([^:'"]+)/gm)) {
    addDepName(ctx, `${m[1]}:${m[2]}`, null, rel)
    addDepName(ctx, m[2], null, rel)
  }
  if (rootLevel) {
    const gradle = ctx.allPaths.has('gradlew') ? './gradlew' : 'gradle'
    pushCommandHint(ctx, 'test', [gradle, 'test'], rel)
    pushCommandHint(ctx, 'build', [gradle, 'build'], rel)
  }
}

function parseGoManifest(ctx, rel, content, rootLevel) {
  const name = firstMatch(content, /^\s*module\s+(\S+)/m)
  const version = firstMatch(content, /^\s*go\s+(\S+)/m)
  pushEcosystem(ctx, { kind: 'go', manifest: rel, name: name ?? null, version: version ?? null, scripts: {} })
  for (const line of content.split('\n')) {
    const m = /^\s*(?:require\s+)?([A-Za-z0-9][A-Za-z0-9./_-]*)\s+v[0-9]/.exec(line)
    if (m) addDepName(ctx, m[1], null, rel)
  }
  if (rootLevel) {
    pushCommandHint(ctx, 'test', ['go', 'test', './...'], rel)
    pushCommandHint(ctx, 'build', ['go', 'build', './...'], rel)
  }
}

function parseRustManifest(ctx, rel, content, rootLevel) {
  const name = firstMatch(content, /^\s*name\s*=\s*["']([^"']+)["']/m)
  const version = firstMatch(content, /^\s*version\s*=\s*["']([^"']+)["']/m)
  pushEcosystem(ctx, { kind: 'rust', manifest: rel, name: name ?? null, version: version ?? null, scripts: {} })
  if (rootLevel && name && !ctx.projectName) ctx.projectName = name

  let section = ''
  for (const line of content.split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(line)
    if (header) {
      section = header[1].trim().toLowerCase()
      continue
    }
    if (section !== 'dependencies' && section !== 'dev-dependencies' && section !== 'build-dependencies') continue
    const dep = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)
    if (dep) addDepName(ctx, dep[1], null, rel)
  }
  if (rootLevel) {
    pushCommandHint(ctx, 'test', ['cargo', 'test'], rel)
    pushCommandHint(ctx, 'build', ['cargo', 'build'], rel)
  }
}

function parseComposerManifest(ctx, rel, content, rootLevel) {
  let json
  try {
    json = JSON.parse(content)
  } catch {
    ctx.warn(`composer.json 不是合法 JSON，已降级跳过：${rel}`)
    return
  }
  if (!json || typeof json !== 'object') {
    ctx.warn(`composer.json 结构异常，已降级跳过：${rel}`)
    return
  }
  const scripts = json.scripts && typeof json.scripts === 'object' ? json.scripts : {}
  pushEcosystem(ctx, {
    kind: 'php',
    manifest: rel,
    name: typeof json.name === 'string' ? json.name : null,
    version: typeof json.version === 'string' ? json.version : null,
    scripts,
  })
  if (rootLevel && typeof json.name === 'string' && !ctx.projectName) ctx.projectName = json.name
  for (const group of [json.require, json['require-dev']]) {
    if (!group || typeof group !== 'object') continue
    for (const dep of sortedObjectKeys(group)) addDepName(ctx, dep, null, rel)
  }
  if (rootLevel) {
    pushCommandHint(ctx, 'install', ['composer', 'install'], rel)
    for (const key of sortedObjectKeys(scripts)) {
      const preset = presetForScriptName(key)
      if (preset && preset !== 'install') pushCommandHint(ctx, preset, ['composer', 'run-script', key], rel)
    }
  }
}

function parseRubyManifest(ctx, rel, content, rootLevel) {
  pushEcosystem(ctx, { kind: 'ruby', manifest: rel, name: null, version: null, scripts: {} })
  for (const m of content.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) addDepName(ctx, m[1], null, rel)
  if (rootLevel) {
    pushCommandHint(ctx, 'install', ['bundle', 'install'], rel)
    if (/\brspec\b/.test(content)) pushCommandHint(ctx, 'test', ['bundle', 'exec', 'rspec'], rel)
  }
}

function parseDotnetManifest(ctx, rel, base) {
  const name = stripExtension(base)
  pushEcosystem(ctx, { kind: 'dotnet', manifest: rel, name, version: null, scripts: {} })
}

function parseCMakeManifest(ctx, rel, base, content, rootLevel) {
  if (base === 'CMakeLists.txt') {
    const project = /project\s*\(\s*([A-Za-z0-9_.-]+)/.exec(content)
    const version = /VERSION\s+([0-9][0-9.]*)/.exec(content)
    pushEcosystem(ctx, {
      kind: 'cpp',
      manifest: rel,
      name: project ? project[1] : null,
      version: version ? version[1] : null,
      scripts: {},
    })
    if (rootLevel) pushCommandHint(ctx, 'build', ['cmake', '-S', '.', '-B', 'build'], rel)
    return
  }
  // Makefile 与 CMakeLists 同属 cpp/c 家族（契约 §4 生态清单）
  pushEcosystem(ctx, { kind: 'c', manifest: rel, name: null, version: null, scripts: {} })
  if (rootLevel) {
    for (const m of content.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/gm)) {
      const target = m[1]
      if (target.startsWith('.')) continue
      const preset = presetForScriptName(target)
      if (preset) pushCommandHint(ctx, preset, ['make', target], rel)
    }
  }
}

function parseDartManifest(ctx, rel, content, rootLevel) {
  const name = firstMatch(content, /^\s*name\s*:\s*([^\s#]+)/m)
  const version = firstMatch(content, /^\s*version\s*:\s*([^\s#]+)/m)
  pushEcosystem(ctx, { kind: 'dart', manifest: rel, name: name ?? null, version: version ?? null, scripts: {} })
  if (rootLevel && name && !ctx.projectName) ctx.projectName = name
  let section = ''
  for (const line of content.split('\n')) {
    const header = /^([A-Za-z_]+)\s*:/.exec(line)
    if (header) {
      section = header[1].toLowerCase()
      continue
    }
    if (section !== 'dependencies' && section !== 'dev_dependencies') continue
    const dep = /^\s{2,}([A-Za-z0-9_]+)\s*:/.exec(line)
    if (dep) addDepName(ctx, dep[1], null, rel)
  }
  if (rootLevel) {
    const flutter = /(^|\n)flutter\s*:/.test(content)
    pushCommandHint(ctx, 'test', flutter ? ['flutter', 'test'] : ['dart', 'test'], rel)
    pushCommandHint(ctx, 'install', flutter ? ['flutter', 'pub', 'get'] : ['dart', 'pub', 'get'], rel)
  }
}

function parseSwiftManifest(ctx, rel, content, rootLevel) {
  const name = firstMatch(content, /name\s*:\s*"([^"]+)"/)
  pushEcosystem(ctx, { kind: 'swift', manifest: rel, name: name ?? null, version: null, scripts: {} })
  for (const m of content.matchAll(/\.package\s*\(([^)]*)\)/g)) {
    const named = /name\s*:\s*"([^"]+)"/.exec(m[1])
    const url = /url\s*:\s*"([^"]+)"/.exec(m[1])
    if (named) addDepName(ctx, named[1], null, rel)
    else if (url) {
      const tail = url[1].replace(/\.git$/, '').split('/').pop()
      if (tail) addDepName(ctx, tail, null, rel)
    }
  }
  if (rootLevel) {
    pushCommandHint(ctx, 'test', ['swift', 'test'], rel)
    pushCommandHint(ctx, 'build', ['swift', 'build'], rel)
  }
}

/* ------------------------------------------------------------------ *
 * 命令构建
 * ------------------------------------------------------------------ */

function presetForScriptName(name) {
  const n = String(name ?? '').toLowerCase().trim()
  if (n.length === 0) return undefined
  if (/^(?:e2e|cypress|playwright)(?:[:.\-_].*)?$/.test(n) || /(?:[:.\-_])(?:e2e|cypress|playwright|integration)$/.test(n)) {
    return 'e2e'
  }
  if (/(?:^|[:.\-_])cov(?:erage)?(?:[:.\-_]|$)/.test(n)) return 'coverage'
  if (/^typecheck|^type-check|^tsc(?:[:.\-_]|$)|^types(?:[:.\-_]|$)/.test(n)) return 'typecheck'
  if (/^format|^prettier|^fmt(?:[:.\-_]|$)/.test(n)) return 'format'
  if (/^lint|^eslint|^stylelint/.test(n)) return 'lint'
  if (/^build|^compile|^bundle/.test(n)) return 'build'
  if (/^dev(?:[:.\-_]|$)|^watch(?:[:.\-_]|$)/.test(n)) return 'dev'
  if (/^start(?:[:.\-_]|$)|^serve(?:[:.\-_]|$)/.test(n)) return 'start'
  if (/^test(?:[:.\-_]|$)/.test(n)) return 'test'
  if (/^install(?:[:.\-_]|$)/.test(n)) return 'install'
  return undefined
}

function detectPackageManager(ctx) {
  if (ctx.packageManager) return ctx.packageManager
  for (const lock of ctx.lockfiles) {
    const base = path.posix.basename(lock).toLowerCase()
    if (base === 'pnpm-lock.yaml') return 'pnpm'
    if (base === 'yarn.lock') return 'yarn'
    if (base === 'bun.lockb') return 'bun'
  }
  return 'npm'
}

function buildCommands(ctx) {
  const out = []
  const seen = new Set()
  const add = (preset, argv, source) => {
    if (!PRESET_ORDER.includes(preset)) return
    const args = (argv ?? []).map(String).filter((a) => a.length > 0)
    if (args.length === 0) return
    const key = `${preset}\u0000${args.join(' ')}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ preset, argv: args, source: String(source ?? '') })
  }

  if (ctx.rootScripts) {
    const pm = detectPackageManager(ctx)
    add('install', [pm, 'install'], 'package.json')
    for (const name of Object.keys(ctx.rootScripts).sort()) {
      const preset = presetForScriptName(name)
      if (preset && preset !== 'install') add(preset, [pm, 'run', name], 'package.json')
    }
  }
  for (const hint of ctx.commandHints) add(hint.preset, hint.argv, hint.source)

  return out.sort((a, b) => {
    const byPreset = PRESET_ORDER.indexOf(a.preset) - PRESET_ORDER.indexOf(b.preset)
    if (byPreset !== 0) return byPreset
    const ka = a.argv.join(' ')
    const kb = b.argv.join(' ')
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

/* ------------------------------------------------------------------ *
 * 测试 / 依赖 / kinds
 * ------------------------------------------------------------------ */

const TEST_FRAMEWORK_RULES = [
  { id: 'jest', label: 'Jest', deps: ['jest'], configs: [/^jest\.config\./i, /^\.jestrc/i] },
  { id: 'vitest', label: 'Vitest', deps: ['vitest'], configs: [/^vitest\.config\./i] },
  { id: 'mocha', label: 'Mocha', deps: ['mocha'], configs: [/^\.mocharc/i, /^mocha\.config\./i] },
  { id: 'ava', label: 'AVA', deps: ['ava'], configs: [/^ava\.config\./i] },
  { id: 'jasmine', label: 'Jasmine', deps: ['jasmine', 'jasmine-core'], configs: [/^jasmine\.json$/i] },
  { id: 'node-test', label: 'node:test', deps: [], configs: [] },
  { id: 'playwright', label: 'Playwright', deps: ['@playwright/test', 'playwright'], configs: [/^playwright\.config\./i] },
  { id: 'cypress', label: 'Cypress', deps: ['cypress'], configs: [/^cypress\.config\./i, /^cypress\.json$/i] },
  { id: 'pytest', label: 'pytest', deps: ['pytest'], configs: [/^pytest\.ini$/i, /^tox\.ini$/i] },
  { id: 'unittest', label: 'unittest', deps: [], configs: [] },
  { id: 'nose', label: 'nose', deps: ['nose', 'nose2'], configs: [] },
  { id: 'junit', label: 'JUnit', deps: ['junit', 'junit-jupiter', 'junit:junit'], configs: [] },
  { id: 'testng', label: 'TestNG', deps: ['testng'], configs: [] },
  { id: 'rspec', label: 'RSpec', deps: ['rspec', 'rspec-rails'], configs: [/(^|\/)\.rspec$/i] },
  { id: 'phpunit', label: 'PHPUnit', deps: ['phpunit', 'phpunit/phpunit'], configs: [/^phpunit\.xml/i] },
  { id: 'go-test', label: 'go test', deps: [], manifests: ['go.mod'] },
  { id: 'cargo-test', label: 'cargo test', deps: [], manifests: ['Cargo.toml'] },
]

function hasDep(ctx, needle) {
  const n = String(needle ?? '').toLowerCase()
  if (n.length === 0) return false
  for (const dep of ctx.depNames) {
    if (dep === n) return true
    if (n.length >= 4 && dep.includes(n)) return true
  }
  return false
}

/**
 * 测试框架画像（契约修订 r4）：依赖清单 + 配置文件 + manifest + 脚本命令 + 测试文件内容。
 * 每条都给 `{id, label, evidence}`，evidence 指明来源（文件、`package.json:scripts.test`、`path:line`）。
 */
function buildTestFrameworks(ctx) {
  collectScriptFrameworkHints(ctx)
  collectCommandFrameworkHints(ctx)

  const found = new Map()
  const put = (id, label, evidence) => {
    const bucket = found.get(id) ?? { id, label, evidence: [] }
    if (evidence && !bucket.evidence.includes(evidence)) bucket.evidence.push(evidence)
    found.set(id, bucket)
  }

  // 1) 依赖与配置文件
  for (const rule of TEST_FRAMEWORK_RULES) {
    for (const dep of rule.deps ?? []) {
      if (ctx.depNames.has(dep) || hasDep(ctx, dep)) {
        put(rule.id, rule.label, `${ctx.depEvidence.get(dep) ?? 'manifest'} 依赖 ${dep}`)
      }
    }
    for (const regex of rule.configs ?? []) {
      for (const cfg of ctx.configs) {
        if (regex.test(path.posix.basename(cfg.path))) put(rule.id, rule.label, cfg.path)
      }
    }
    for (const manifest of rule.manifests ?? []) {
      if (ctx.allPaths.has(manifest)) put(rule.id, rule.label, manifest)
    }
  }

  // 2) 脚本命令 / 构建命令 / 测试文件内容
  for (const entry of ctx.frameworkEvidence.values()) {
    for (const evidence of entry.evidence) put(entry.id, entry.label, evidence)
  }

  return [...found.values()]
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      evidence: clip(entry.evidence.join('；'), 240),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** 框架级 notable 依赖 → 分类。 */
const NOTABLE_DEP_KINDS = new Map([
  ['react', 'frontend'],
  ['react-dom', 'frontend'],
  ['vue', 'frontend'],
  ['svelte', 'frontend'],
  ['next', 'frontend'],
  ['nuxt', 'frontend'],
  ['@angular/core', 'frontend'],
  ['solid-js', 'frontend'],
  ['astro', 'frontend'],
  ['preact', 'frontend'],
  ['gatsby', 'frontend'],
  ['tailwindcss', 'frontend'],
  ['bootstrap', 'frontend'],
  ['antd', 'frontend'],
  ['@mui/material', 'frontend'],
  ['redux', 'frontend'],
  ['zustand', 'frontend'],
  ['mobx', 'frontend'],
  ['express', 'backend'],
  ['koa', 'backend'],
  ['fastify', 'backend'],
  ['@nestjs/core', 'backend'],
  ['hapi', 'backend'],
  ['restify', 'backend'],
  ['socket.io', 'backend'],
  ['graphql', 'backend'],
  ['django', 'backend'],
  ['flask', 'backend'],
  ['fastapi', 'backend'],
  ['starlette', 'backend'],
  ['aiohttp', 'backend'],
  ['tornado', 'backend'],
  ['rails', 'backend'],
  ['sinatra', 'backend'],
  ['laravel', 'backend'],
  ['symfony', 'backend'],
  ['spring-boot', 'backend'],
  ['spring', 'backend'],
  ['gin', 'backend'],
  ['echo', 'backend'],
  ['fiber', 'backend'],
  ['actix-web', 'backend'],
  ['axum', 'backend'],
  ['rocket', 'backend'],
  ['prisma', 'database'],
  ['typeorm', 'database'],
  ['sequelize', 'database'],
  ['mongoose', 'database'],
  ['drizzle-orm', 'database'],
  ['redis', 'database'],
  ['sqlalchemy', 'database'],
  ['tokio', 'runtime'],
  ['typescript', 'language'],
  ['vite', 'build'],
  ['webpack', 'build'],
  ['esbuild', 'build'],
  ['rollup', 'build'],
  ['babel', 'build'],
  ['jest', 'testing'],
  ['vitest', 'testing'],
  ['mocha', 'testing'],
  ['playwright', 'testing'],
  ['cypress', 'testing'],
  ['pytest', 'testing'],
  ['electron', 'desktop'],
  ['react-native', 'mobile'],
  ['flutter', 'mobile'],
  ['zod', 'validation'],
  ['axios', 'http'],
  ['three', 'graphics'],
  ['dsh', 'plugin'],
])

const NOTABLE_SUBSTRINGS = [
  ['spring', 'backend'],
  ['nestjs', 'backend'],
  ['django', 'backend'],
  ['flask', 'backend'],
  ['fastapi', 'backend'],
  ['rails', 'backend'],
  ['laravel', 'backend'],
  ['actix', 'backend'],
  ['tokio', 'runtime'],
  ['playwright', 'testing'],
  ['cypress', 'testing'],
  ['jest', 'testing'],
  ['vitest', 'testing'],
  ['pytest', 'testing'],
  ['react-native', 'mobile'],
  ['angular', 'frontend'],
  ['tailwind', 'frontend'],
  ['react', 'frontend'],
  ['vue', 'frontend'],
  ['svelte', 'frontend'],
]

function notableKind(name) {
  const key = String(name ?? '').toLowerCase()
  if (NOTABLE_DEP_KINDS.has(key)) return NOTABLE_DEP_KINDS.get(key)
  for (const [needle, kind] of NOTABLE_SUBSTRINGS) {
    if (key.length >= 4 && key.includes(needle)) return kind
  }
  return undefined
}

function buildNotable(ctx) {
  const out = []
  for (const [key, version] of ctx.depVersions) {
    const kind = notableKind(key)
    if (!kind) continue
    out.push({ name: ctx.depDisplay.get(key) ?? key, version: version ?? null, kind })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

const FRONTEND_NEEDLES = ['react', 'vue', 'svelte', 'next', 'nuxt', 'angular', 'astro', 'solid-js', 'preact', 'gatsby', 'tailwind']
const BACKEND_NEEDLES = [
  'express', 'koa', 'fastify', 'nestjs', 'hapi', 'restify', 'django', 'flask', 'fastapi',
  'starlette', 'rails', 'sinatra', 'laravel', 'symfony', 'spring-boot', 'gin-gonic', 'labstack/echo',
  'gofiber', 'actix-web', 'axum', 'quarkus', 'micronaut',
]

/** monorepo 标记文件（根级）与子包路径约定。 */
const MONOREPO_MARKERS = ['pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json']
const MONOREPO_PACKAGE_RE = /^(?:packages|apps|libs|modules|plugins)\/[^/]+\/package\.json$/

/** 是否 monorepo：workspaces 字段 / 工作区标记文件 / 子包目录下的 package.json。 */
function detectMonorepo(ctx) {
  if (ctx.monorepo) return true
  if (MONOREPO_MARKERS.some((marker) => ctx.allPaths.has(marker))) return true
  for (const visited of ctx.allPaths) if (MONOREPO_PACKAGE_RE.test(visited)) return true
  return false
}

function detectKinds(ctx) {
  const flags = new Set()
  const frontend = FRONTEND_NEEDLES.some((needle) => hasDep(ctx, needle))
  const backend = BACKEND_NEEDLES.some((needle) => hasDep(ctx, needle))

  if (ctx.hasBin || ctx.cliHint || ctx.entrypoints.some((e) => e.kind === 'bin' || e.kind === 'cli')) flags.add('cli')
  if (ctx.hasMainField && !ctx.hasBin) flags.add('library')
  if (frontend) flags.add('web-app')
  if (backend) flags.add('api-service')
  if (detectMonorepo(ctx)) flags.add('monorepo')
  if (ctx.pluginHint || ctx.allPaths.has('cordis.patch.yml')) flags.add('plugin')
  if (ctx.dataFiles > 0 && ctx.dataFiles > ctx.profile.size.sourceFiles) flags.add('data')
  if (ctx.profile.size.sourceFiles === 0 && ctx.docs.size > 0) flags.add('docs-only')
  return KIND_ORDER.filter((kind) => flags.has(kind))
}

/* ------------------------------------------------------------------ *
 * 工程缺口
 * ------------------------------------------------------------------ */

function firstExisting(ctx, candidates) {
  for (const candidate of candidates) if (ctx.allPaths.has(candidate)) return candidate
  return undefined
}

function buildGaps(ctx) {
  const gaps = []
  const p = ctx.profile
  const anchor =
    firstExisting(ctx, [
      'package.json',
      'pyproject.toml',
      'requirements.txt',
      'Cargo.toml',
      'go.mod',
      'pom.xml',
      'build.gradle',
      'composer.json',
      'Gemfile',
      'README.md',
    ]) ?? '.'

  const add = (id, priority, title, detail, evidence) => {
    gaps.push({
      id,
      priority,
      title,
      detail: clip(detail, 400),
      evidence: uniq((evidence ?? []).filter((item) => typeof item === 'string' && item.length > 0)),
    })
  }

  // P0：敏感文件入库风险（模板文件不算风险，但仍记录在 sensitive 里）
  const risky = p.sensitive.filter((item) => item.kind !== 'env-template')
  if (risky.length > 0) {
    add(
      'sensitive-files-present',
      'P0',
      '仓库内存在敏感文件',
      `命中 ${risky.length} 个敏感文件（类型：${uniq(risky.map((s) => s.kind)).join('/')}），其内容未被读取；需确认是否应入库并从版本历史中清理。`,
      risky.slice(0, 5).map((item) => item.path),
    )
  }

  // P1：缺少依赖锁定文件
  const dependencyEcosystems = p.ecosystems.filter((e) =>
    ['node', 'python', 'ruby', 'php', 'rust', 'go', 'java'].includes(e.kind),
  )
  if (dependencyEcosystems.length > 0 && ctx.lockfiles.size === 0) {
    add(
      'no-lockfile',
      'P1',
      '缺少依赖锁定文件',
      '未发现 package-lock.json / pnpm-lock.yaml / poetry.lock / Cargo.lock 等锁定文件，构建不可复现。',
      [dependencyEcosystems[0].manifest],
    )
  }

  // P1：没有任何测试
  if (p.tests.testFileCount === 0) {
    add('no-tests', 'P1', '没有任何测试文件', '未按命名约定发现测试文件，回归风险不可控。', [anchor])
  }

  // P1：缺少 .gitignore
  if (!ctx.allPaths.has('.gitignore')) {
    add('no-gitignore', 'P1', '缺少 .gitignore', '未发现 .gitignore，构建产物与本地文件容易误入库。', [anchor])
  }

  // P1：依赖版本未固定
  if (ctx.unpinned.length > 0) {
    const names = uniq(ctx.unpinned.map((item) => item.name)).slice(0, 6)
    add(
      'unpinned-deps',
      'P1',
      '依赖版本未固定',
      `${ctx.unpinned.length} 处依赖使用 * / latest 等浮动版本：${names.join(', ')}。`,
      ctx.unpinned.slice(0, 5).map((item) => (item.line ? `package.json:${item.line}` : 'package.json')),
    )
  }

  // P2：缺少 README
  const hasReadme = p.docs.some((doc) => /^readme/i.test(path.posix.basename(doc)))
  if (!hasReadme) {
    add('no-readme', 'P2', '缺少 README', '未发现 README，新人无法快速了解项目用途与启动方式。', [anchor])
  }

  // P2：缺少 CI
  if (p.ci.length === 0) {
    add('no-ci', 'P2', '缺少持续集成配置', '未发现 CI 工作流（GitHub Actions / GitLab CI 等），提交缺少自动化校验。', [anchor])
  }

  // P2：缺少 lint / format 配置
  const hasLint = p.configs.some((c) => c.kind === 'lint' || c.kind === 'format')
  const hasLintCommand = p.commands.some((c) => c.preset === 'lint' || c.preset === 'format')
  if (!hasLint && !hasLintCommand) {
    add('no-lint-format', 'P2', '缺少 lint / format 配置', '未发现 ESLint / Prettier / Ruff 等静态风格配置与命令。', [anchor])
  }

  // P2：缺少类型检查
  const hasTypecheck =
    p.configs.some((c) => c.kind === 'typescript' || c.kind === 'typecheck') ||
    p.commands.some((c) => c.preset === 'typecheck') ||
    hasDep(ctx, 'typescript') ||
    hasDep(ctx, 'mypy') ||
    hasDep(ctx, 'pyright')
  if (p.size.sourceFiles > 0 && !hasTypecheck) {
    add('no-typecheck', 'P2', '缺少类型检查', '未发现 TypeScript / mypy / pyright 等类型检查配置或命令。', [anchor])
  }

  // P2：单文件超大
  const huge = p.signals.largeFiles.filter((file) => (ctx.largeFileSizes.get(file) ?? 0) > HUGE_FILE_BYTES)
  if (huge.length > 0) {
    add('oversized-file', 'P2', '存在超大单文件', `以下文件超过 1MB，建议拆分或移出仓库：${huge.slice(0, 3).join(', ')}。`, huge.slice(0, 3))
  }

  // P3：TODO 堆积
  if (p.signals.todoCount >= 10) {
    add(
      'todo-backlog',
      'P3',
      'TODO 堆积',
      `共 ${p.signals.todoCount} 条 TODO/FIXME 等待处理。`,
      p.signals.todos.slice(0, 3).map((item) => `${item.path}:${item.line}`),
    )
  }

  // P3：调试语句残留
  if (p.signals.debugStatementCount > 0) {
    add(
      'debug-leftovers',
      'P3',
      '存在调试语句残留',
      `共 ${p.signals.debugStatementCount} 处 console.log / debugger / print 等调试语句。`,
      ctx.debugSamples.slice(0, 3).map((item) => `${item.path}:${item.line}`),
    )
  }

  // P3：容器缺少健康检查
  const dockerfiles = [...ctx.containers].filter((file) => /(^|\/)Dockerfile/i.test(file) || /\.dockerfile$/i.test(file))
  const unhealthy = dockerfiles.filter((file) => !ctx.dockerfileHealthcheck.has(file))
  if (unhealthy.length > 0) {
    add('container-no-healthcheck', 'P3', '容器缺少健康检查', `Dockerfile 未声明 HEALTHCHECK：${unhealthy.join(', ')}。`, unhealthy.slice(0, 3))
  }

  return gaps
}

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

function uniqByPath(items, keyOf) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function finalizeProfile(ctx) {
  const p = ctx.profile
  p.durationMs = Math.max(0, ctx.elapsedMs())
  p.scannedAt = new Date(ctx.startedAtMs).toISOString()
  p.name = ctx.projectName || path.basename(ctx.rootAbs) || ctx.rootAbs
  p.truncated = ctx.truncated
  p.size.truncated = ctx.truncated

  p.languages = [...ctx.languages.values()]
    .map((entry) => ({ name: entry.name, files: entry.files, loc: entry.loc, bytes: entry.bytes }))
    .sort((a, b) => b.loc - a.loc || b.files - a.files || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  p.kinds = detectKinds(ctx)
  p.ecosystems = uniqByPath(
    ctx.ecosystems,
    (entry) => `${entry.kind}\u0000${entry.manifest}\u0000${entry.name ?? ''}`,
  ).sort((a, b) => (a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : 0))
  p.commands = buildCommands(ctx)

  // 入口点：路径/内容级 + 清单声明（声明必须真实存在）
  for (const declared of ctx.declaredEntrypoints) {
    if (ctx.allPaths.has(declared.path)) addEntrypoint(ctx, declared.path, declared.kind, declared.evidence)
  }
  p.entrypoints = ctx.entrypoints
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : 1))

  p.configs = uniqByPath(ctx.configs, (item) => item.path).sort((a, b) => (a.path < b.path ? -1 : 1))
  p.docs = [...ctx.docs].sort()
  p.ci = uniqByPath(ctx.ci, (item) => `${item.id}\u0000${item.path}`).sort((a, b) => (a.path < b.path ? -1 : 1))
  p.containers = [...ctx.containers].sort()
  p.iac = [...ctx.iac].sort()

  p.tests = {
    frameworks: buildTestFrameworks(ctx),
    testFiles: [...ctx.testFiles].sort(),
    testFileCount: ctx.testFiles.size,
    coverageConfig: uniq(ctx.coverageHints).sort(),
  }

  p.deps = {
    direct: uniq(p.deps.direct).sort(),
    dev: uniq(p.deps.dev).sort(),
    notable: buildNotable(ctx),
  }

  p.signals = {
    todoCount: p.signals.todoCount,
    todos: p.signals.todos.slice().sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1)),
    debugStatementCount: p.signals.debugStatementCount,
    secretSuspects: p.signals.secretSuspects.slice().sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1)),
    largeFiles: uniq(p.signals.largeFiles).sort(),
    generatedFiles: [...ctx.generatedFiles].sort(),
  }

  p.sensitive = uniqByPath(p.sensitive, (item) => item.path).sort((a, b) => (a.path < b.path ? -1 : 1))
  p.ignore = { rules: ctx.ignoreRules, sources: ctx.ignoreSources }
  p.gaps = buildGaps(ctx)
  p.warnings = ctx.sink.finish()

  // sources 与 size.files 同源同序：按 path 升序，保证可复现
  p.sources = p.sources.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return p
}
