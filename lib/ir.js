/**
 * 统一中间表示（IR）装配：把各语言解析器的输出归一化成 Module/File/Symbol/Import/Call/Route。
 *
 * 四个必须守住的原则：
 *   1. **可追溯**：跨文件绑定只允许走显式 import 声明；其余一律 `unresolved`，
 *      宁可断边也不猜——报告里的每条依赖都必须能回答"凭什么这么连"；
 *   2. **幂等**：相同输入必须产出逐字节一致的 IR（稳定 id、集合排序、无 Map 迭序泄漏），
 *      否则增量缓存与文档 diff 都会抖；
 *   3. **纯函数**：本模块不读盘、不调 LLM、无模块级可变状态，可反复调用、可并发；
 *   4. **可降级**：解析器缺字段不影响装配，问题进 `warnings`。
 *
 * @module dsh-project-compass/ir
 */

import path from 'node:path'
import { extensionOf, toPosix, uniq, withoutExtension } from './util.js'
import { moduleIdOf } from './paths.js'

/** IR schema 版本；结构不兼容变化时必须递增。 */
export const IR_SCHEMA_VERSION = 1

/** 模块/文件 kind 的封闭枚举（报告层按它分组，不要随意加值）。 */
export const FILE_KINDS = ['source', 'test', 'config', 'docs', 'infra', 'asset', 'generated', 'mixed']

/* ------------------------------------------------------------------ *
 * 文件分类
 * ------------------------------------------------------------------ */

const TEST_PATH_PATTERNS = [
  /(^|\/)(test|tests|__tests__|spec|specs|e2e|testing)\//i,
  /\.(test|spec)\.[a-z]+$/i,
  /(^|\/)(test_|conftest)/,
  /_test\.[a-z]+$/i,
  /Tests?\.java$/,
]

const CONFIG_NAMES = [
  /^\.?env(\..*)?$/i, /^\.eslintrc/i, /^\.prettierrc/i, /^\.editorconfig$/i, /^\.babelrc/i,
  /^\.npmrc$/i, /^\.nvmrc$/i, /^tsconfig.*\.json$/i, /^jsconfig.*\.json$/i, /^jest\.config/i,
  /^vite\.config/i, /^webpack\.config/i, /^rollup\.config/i, /^next\.config/i, /^nuxt\.config/i,
  /^tailwind\.config/i, /^postcss\.config/i, /^babel\.config/i, /^eslint\.config/i,
  /^docker-compose.*\.ya?ml$/i, /^nginx\.conf$/i, /^ruff\.toml$/i, /^mypy\.ini$/i,
  /^\.flake8$/i, /^pytest\.ini$/i, /^tox\.ini$/i, /^\.coveragerc$/i, /^requirements.*\.txt$/i,
  /^package\.json$/i, /^pyproject\.toml$/i, /^setup\.(py|cfg)$/i, /^pom\.xml$/i,
  /^build\.gradle(\.kts)?$/i, /^go\.mod$/i, /^Cargo\.toml$/i, /^composer\.json$/i,
  /^Gemfile$/i, /.*\.csproj$/i, /^settings\.gradle$/i, /^Makefile$/i, /^CMakeLists\.txt$/i,
  /^\.compassignore$/i, /^\.gitignore$/i, /^\.dockerignore$/i, /^\.gitattributes$/i,
]

const INFRA_PATTERNS = [
  /(^|\/)(\.github\/workflows|\.gitlab-ci|\.circleci|\.azure|\.bitbucket)/i,
  /^Dockerfile/i, /^Jenkinsfile$/i, /\.tf(vars)?$/i, /^serverless\.ya?ml$/i,
  /(^|\/)(k8s|kubernetes|helm|charts|deploy|deployment|infra|terraform)\//i, /^Chart\.yaml$/i,
  /^playbook.*\.ya?ml$/i, /^ansible\.cfg$/i, /^Procfile$/i, /^fly\.toml$/i, /^vercel\.json$/i,
  /^\.github\/dependabot\.yml$/i,
]

const ASSET_EXTENSIONS = new Set([
  '.css', '.scss', '.sass', '.less', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.pdf', '.csv', '.parquet', '.ipynb',
])

const GENERATED_PATTERNS = [
  /\.pb\.go$/, /_pb2(_grpc)?\.py$/, /\.g\.dart$/, /\.min\.(js|css)$/, /\.map$/,
  /(^|\/)(dist|build|out|generated|__generated__|vendor)\//i, /\.designer\.cs$/, /\.generated\./i,
]

/**
 * 判定单个文件的 kind（报告层分组、模块聚合都用它）。
 * @param relFile 相对 posix 路径。
 * @param language 语言 id。
 * @returns FILE_KINDS 中的值。
 */
export function fileKindOf(relFile, language) {
  const rel = toPosix(relFile)
  const base = path.posix.basename(rel)
  const ext = extensionOf(base)

  if (GENERATED_PATTERNS.some((re) => re.test(rel))) return 'generated'
  if (INFRA_PATTERNS.some((re) => re.test(rel) || re.test(base))) return 'infra'
  if (TEST_PATH_PATTERNS.some((re) => re.test(rel))) return 'test'
  if (CONFIG_NAMES.some((re) => re.test(base))) return 'config'
  if (language === 'markdown' || /\.(md|mdx|rst|adoc)$/i.test(base)) return 'docs'
  if (ASSET_EXTENSIONS.has(ext)) return 'asset'
  if (language === 'json' || language === 'yaml') return 'config'
  if (language === 'text') return rel.startsWith('docs/') ? 'docs' : 'asset'
  return 'source'
}

/** 模块 kind：由成员文件的 kind 决定；真正的"主 kind"平票时记 mixed。 */
function moduleKindOf(fileKinds) {
  const meaningful = fileKinds.filter((kind) => kind !== 'test' && kind !== 'generated')
  const pool = meaningful.length > 0 ? meaningful : fileKinds
  const counts = new Map()
  for (const kind of pool) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  const ranked = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
  if (ranked.length === 0) return 'source'
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return 'mixed'
  return ranked[0][0]
}

/* ------------------------------------------------------------------ *
 * 导入解析
 * ------------------------------------------------------------------ */

const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.java', '.go', '.rs', '.rb', '.php', '.kt', '.kts', '.scala', '.swift', '.cs', '.vue', '.svelte',
]

const INDEX_STEMS = ['index', '__init__', 'mod', 'main']

/**
 * 宿主/语言内置名：记为 `global` 而不是 `unresolved`，否则噪声会淹没真实未解析调用。
 * 键一律小写（比较时对 callee 末段取小写）。
 */
const GLOBAL_CALLEES = new Set([
  // JS/TS 运行时
  'console', 'json', 'object', 'array', 'string', 'number', 'boolean', 'math', 'promise', 'date',
  'regexp', 'error', 'typeerror', 'rangeerror', 'map', 'set', 'weakmap', 'weakset', 'symbol',
  'bigint', 'proxy', 'reflect', 'parseint', 'parsefloat', 'isnan', 'isfinite', 'encodeuri',
  'decodeuri', 'encodeuricomponent', 'decodeuricomponent', 'structuredclone', 'fetch',
  'settimeout', 'setinterval', 'clearinterval', 'cleartimeout', 'queueMicrotask'.toLowerCase(),
  'requestanimationframe', 'require', 'import', 'usestate', 'useeffect', 'usememo', 'usecallback',
  'useref', 'usecontext', 'usereducer', 'definecomponent',
  // Python
  'print', 'len', 'range', 'str', 'int', 'float', 'bool', 'list', 'dict', 'tuple', 'set', 'frozenset',
  'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr', 'delattr', 'enumerate', 'zip',
  'sorted', 'reversed', 'sum', 'min', 'max', 'abs', 'open', 'format', 'repr', 'type', 'super', 'id',
  'iter', 'next', 'any', 'all', 'round', 'map', 'filter', 'vars', 'dir', 'hash', 'callable',
  'staticmethod', 'classmethod', 'property', 'globals', 'locals', 'input', 'exit',
  // Java/JVM
  'system', 'arrays', 'collections', 'objects', 'optional', 'stream', 'integer', 'long', 'double',
  'stringbuilder', 'thread', 'runtime', 'class', 'println', 'printf', 'valueof', 'getinstance',
  'requirenonnull', 'empty', 'oflist', 'tolist',
  // Go / Rust
  'fmt', 'make', 'append', 'copy', 'delete', 'panic', 'recover', 'vec', 'println', 'format', 'clone',
  'tostring', 'unwrap', 'expect', 'ok', 'err', 'new', 'len', 'cap', 'close',
  // Ruby / PHP
  'puts', 'p', 'gets', 'nil', 'self', 'dd', 'dump', 'var_dump', 'echo', 'empty', 'isset', 'unset',
  'printf', 'sprintf', 'implode', 'explode', 'array_map', 'function_exists',
])

/** 取点分/`::` 名字的最后一段。 */
function calleeTail(name) {
  const text = String(name ?? '')
  const parts = text.split(/[.:]+/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : text
}

/**
 * 外部包名：`@scope/pkg/sub` → `@scope/pkg`；`pkg/sub` → `pkg`；`a.b.c` → `a`。
 */
export function packageNameOf(specifier) {
  const raw = String(specifier ?? '').trim()
  if (raw.length === 0) return null
  if (raw.startsWith('@')) {
    const parts = raw.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : raw
  }
  const head = raw.split(/[/.]/)[0]
  return head.length > 0 ? head : null
}

/**
 * 导入目标解析器：把 specifier 映射到项目内文件，映射不上就明确判为外部依赖。
 *
 * 支持：相对路径（含扩展名省略与 index/__init__ 约定）、Python 绝对包路径、
 * Java/Kotlin/Scala 点分路径（含 `com.foo.*` 唯一命中）、绝对路径。
 *
 * @param files IR 的文件列表（只需 `id`）。
 */
export function createResolver(files) {
  const ids = files.map((file) => toPosix(file.id))
  const byId = new Set(ids)
  const lowerIndex = new Map(ids.map((id) => [id.toLowerCase(), id]))
  const basenameIndex = new Map()
  const dottedIndex = new Map()
  for (const id of ids) {
    const base = withoutExtension(path.posix.basename(id))
    const bucket = basenameIndex.get(base)
    if (bucket === undefined) basenameIndex.set(base, [id])
    else bucket.push(id)
    dottedIndex.set(withoutExtension(id).replace(/\//g, '.'), id)
  }

  const lookup = (candidate) => {
    if (byId.has(candidate)) return candidate
    return lowerIndex.get(candidate.toLowerCase())
  }

  const lookupMany = (candidates) => {
    for (const candidate of candidates) {
      const hit = lookup(candidate)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  const resolveRelative = (specifier, fromFileId) => {
    const fromDir = path.posix.dirname(fromFileId)
    const base = path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, specifier))
    const candidates = [base]
    for (const ext of CODE_EXTENSIONS) candidates.push(`${base}${ext}`)
    for (const stem of INDEX_STEMS) for (const ext of CODE_EXTENSIONS) candidates.push(`${base}/${stem}${ext}`)
    return lookupMany(candidates)
  }

  const resolveDotted = (specifier, language) => {
    const dotted = specifier.replace(/\.\*$/, '')
    const asPath = dotted.replace(/\./g, '/')
    const candidates = [asPath]
    for (const ext of CODE_EXTENSIONS) candidates.push(`${asPath}${ext}`)
    for (const stem of INDEX_STEMS) for (const ext of CODE_EXTENSIONS) candidates.push(`${asPath}/${stem}${ext}`)
    const direct = lookupMany(candidates)
    if (direct !== undefined) return direct

    const javaLike = language === 'java' || language === 'kotlin' || language === 'scala'
    if (javaLike) {
      const exact = dottedIndex.get(dotted)
      if (exact !== undefined) return exact
      const tail = `.${dotted}.`
      const matches = ids.filter((id) => `.${withoutExtension(id).replace(/\//g, '.')}.`.endsWith(tail))
      if (matches.length === 1) return matches[0]
    }
    if (language === 'python' && !dotted.includes('.')) {
      const bucket = basenameIndex.get(dotted) ?? []
      if (bucket.length === 1) return bucket[0]
    }
    return undefined
  }

  return {
    /**
     * 解析一条 import。
     * @returns { target, external, packageName, resolved, kind }
     */
    resolve(specifier, fromFileId, language) {
      const raw = String(specifier ?? '').trim()
      if (raw.length === 0) return { target: null, external: false, packageName: null, resolved: false, kind: 'empty' }
      if (raw.startsWith('./') || raw.startsWith('../') || raw === '.' || raw === '..') {
        const target = resolveRelative(raw, fromFileId)
        return { target: target ?? null, external: target === undefined, packageName: null, resolved: target !== undefined, kind: 'relative' }
      }
      if (raw.startsWith('/')) {
        const target = lookup(raw.slice(1))
        return { target: target ?? null, external: target === undefined, packageName: null, resolved: target !== undefined, kind: 'absolute' }
      }
      const internal = resolveDotted(raw, language)
      if (internal !== undefined) return { target: internal, external: false, packageName: null, resolved: true, kind: 'project' }
      return { target: null, external: true, packageName: packageNameOf(raw), resolved: false, kind: 'external' }
    },
  }
}

/* ------------------------------------------------------------------ *
 * IR 装配
 * ------------------------------------------------------------------ */

/**
 * 装配 IR。
 * @param input.root 项目根（绝对路径）。
 * @param input.name 项目名。
 * @param input.profile 扫描画像（`lib/scan.js` 产出）。
 * @param input.files 逐文件输入 `[{ id, language, kind?, loc, bytes, hash, parse, parsed, warnings }]`。
 * @param input.graph 已构建的图谱（可选，通常由 `lib/graph.js` 在装配后回填）。
 * @param input.budget 预算消耗统计。
 * @param input.generatedAt 生成时间（可注入，便于测试确定性）。
 * @param input.warnings 上层告警。
 * @returns IR（形状见 docs/INTERNAL-CONTRACTS.md §3）。
 */
export function buildIR(input) {
  const root = toPosix(input.root ?? '.')
  const warnings = [...(input.warnings ?? [])]
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const source = [...(input.files ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const modules = new Map()
  const files = []
  const fileById = new Map()
  const symbols = []
  const imports = []
  const calls = []
  const routes = []
  const symbolByFile = new Map()
  const importIndex = new Map()
  const parsedById = new Map()

  /* --- 第一遍：文件 / 符号 / 导入 / 路由 --- */
  for (const entry of source) {
    const fileId = toPosix(entry.id)
    const moduleId = moduleIdOf(fileId)
    const language = entry.language ?? 'text'
    const kind = entry.kind ?? fileKindOf(fileId, language)
    const parsed = entry.parsed ?? {}

    const fileSymbols = []
    for (const raw of parsed.symbols ?? []) {
      const name = String(raw?.name ?? '').trim()
      if (name.length === 0) continue
      const line = Number.isFinite(raw?.line) ? Math.max(1, Math.trunc(raw.line)) : 1
      const endLine = Number.isFinite(raw?.endLine) ? Math.max(line, Math.trunc(raw.endLine)) : line
      const symbol = {
        id: `${fileId}#${name}@${line}`,
        fileId,
        moduleId,
        name,
        kind: raw?.kind ?? 'function',
        line,
        endLine,
        exported: raw?.exported === true,
        parent: raw?.parent ?? null,
        signature: raw?.signature ?? null,
        doc: raw?.doc ?? null,
        loc: endLine - line + 1,
        fanIn: 0,
        fanOut: 0,
        risk: 'low',
      }
      symbols.push(symbol)
      fileSymbols.push(symbol)
    }
    symbolByFile.set(fileId, fileSymbols)

    const fileImports = []
    ;(parsed.imports ?? []).forEach((raw, index) => {
      const line = Number.isFinite(raw?.line) ? Math.max(1, Math.trunc(raw.line)) : index + 1
      const record = {
        id: `${fileId}:${line}:${String(raw?.specifier ?? '')}`,
        fileId,
        moduleId,
        specifier: String(raw?.specifier ?? ''),
        line,
        names: uniq((raw?.names ?? []).map((name) => String(name)).filter((name) => name.length > 0)),
        defaultName: raw?.defaultName ? String(raw.defaultName) : null,
        kind: raw?.kind ?? 'static',
        target: null,
        targetModule: null,
        external: false,
        packageName: null,
        resolved: false,
      }
      imports.push(record)
      fileImports.push(record)
    })
    const index = new Map()
    for (const record of fileImports) index.set(record.id, record)
    importIndex.set(fileId, index)

    const fileRoutes = []
    ;(parsed.routes ?? []).forEach((raw, index2) => {
      const method = String(raw?.method ?? 'GET').toUpperCase()
      const routePath = String(raw?.path ?? '/')
      const line = Number.isFinite(raw?.line) ? Math.max(1, Math.trunc(raw.line)) : index2 + 1
      const record = {
        id: `${method} ${routePath} [${fileId}:${line}]`,
        method,
        path: routePath,
        framework: raw?.framework ?? 'unknown',
        fileId,
        moduleId,
        line,
        handlerSymbolId: null,
        handlerName: raw?.handlerName ? String(raw.handlerName) : null,
        middlewares: (raw?.middlewares ?? []).map((name) => String(name)),
        kind: raw?.kind ?? 'http',
      }
      routes.push(record)
      fileRoutes.push(record)
    })

    const fileRecord = {
      id: fileId,
      moduleId,
      language,
      kind,
      loc: Number(entry.loc) || 0,
      bytes: Number(entry.bytes) || 0,
      hash: entry.hash ?? null,
      symbols: fileSymbols.map((symbol) => symbol.id),
      imports: fileImports.map((record) => record.id),
      calls: [],
      routes: fileRoutes.map((record) => record.id),
      exports: uniq((parsed.exports ?? []).map((name) => String(name))),
      todos: (parsed.todos ?? []).map((todo) => ({
        line: Number.isFinite(todo?.line) ? Math.max(1, Math.trunc(todo.line)) : 1,
        text: String(todo?.text ?? ''),
        kind: todo?.kind ?? 'todo',
      })),
      parse: entry.parse ?? 'deep',
      warnings: [...(entry.warnings ?? [])],
    }
    files.push(fileRecord)
    fileById.set(fileId, fileRecord)
    parsedById.set(fileId, parsed)

    let module = modules.get(moduleId)
    if (module === undefined) {
      module = {
        id: moduleId,
        // 标签用完整相对路径：嵌套模块只显示 basename 时（`lib/parse` 显示成 `parse`）
        // 在图与表格里会与其它同名模块混淆。
        name: moduleId === '.' ? (input.name ?? 'root') : moduleId,
        dir: moduleId,
        language,
        kind,
        files: [],
        loc: 0,
        symbolCount: 0,
        entrypoints: [],
        dependsOn: [],
        dependedOnBy: [],
        risk: 'low',
        notes: [],
      }
      modules.set(moduleId, module)
    }
    module.files.push(fileId)
    module.loc += fileRecord.loc
    module.symbolCount += fileSymbols.length
    if (module.language !== language) module.language = module.files.length > 1 ? 'mixed' : language
    module.notes.push(...(entry.warnings ?? []))
  }

  /* --- 第二遍：导入解析 + 本地名绑定表 --- */
  const resolver = createResolver(files)
  const bindings = new Map()
  for (const record of imports) {
    const language = fileById.get(record.fileId)?.language ?? 'text'
    const outcome = resolver.resolve(record.specifier, record.fileId, language)
    record.target = outcome.target
    record.external = outcome.external
    record.packageName = outcome.packageName
    record.resolved = outcome.resolved
    record.targetModule = outcome.target === null ? null : moduleIdOf(outcome.target)

    if (record.target !== null) {
      let map = bindings.get(record.fileId)
      if (map === undefined) {
        map = new Map()
        bindings.set(record.fileId, map)
      }
      for (const name of record.names) map.set(name, record.target)
      if (record.defaultName) map.set(record.defaultName, record.target)
    }
  }

  /* --- 第三遍：调用绑定 --- */
  for (const file of files) {
    const ownSymbols = symbolByFile.get(file.id) ?? []
    const ownByName = new Map()
    for (const symbol of ownSymbols) {
      const bucket = ownByName.get(symbol.name)
      if (bucket === undefined) ownByName.set(symbol.name, [symbol])
      else bucket.push(symbol)
    }
    const localBindings = bindings.get(file.id) ?? new Map()
    const externalPackages = new Set(
      (file.imports ?? [])
        .map((id) => importIndex.get(file.id)?.get(id))
        .filter((record) => record !== undefined && record.external)
        .map((record) => (record.names[0] ?? record.defaultName ?? packageNameOf(record.specifier)))
        .filter((name) => typeof name === 'string' && name.length > 0),
    )

    for (const raw of parsedById.get(file.id)?.calls ?? []) {
      const calleeName = String(raw?.calleeName ?? '').trim()
      if (calleeName.length === 0) continue
      const tail = calleeTail(calleeName)
      const line = Number.isFinite(raw?.line) ? Math.max(1, Math.trunc(raw.line)) : 1
      const fromSymbol = (ownByName.get(String(raw?.fromSymbolName ?? '')) ?? [])[0] ?? null

      let toSymbolId = null
      let resolution = 'unresolved'
      let external = false

      const bare = calleeName === tail
      const own = ownByName.get(tail) ?? []

      if (bare && own.length === 1) {
        toSymbolId = own[0].id
        resolution = 'same-file'
      } else if (bare) {
        const targetFile = localBindings.get(tail)
        if (targetFile !== undefined) {
          const candidates = (symbolByFile.get(targetFile) ?? []).filter((symbol) => symbol.name === tail)
          if (candidates.length === 1) {
            toSymbolId = candidates[0].id
            resolution = 'import'
          } else {
            // 绑定了文件但符号不唯一/不存在：仍记录为 import 解析，只是没有唯一目标
            resolution = 'import'
          }
        } else if (GLOBAL_CALLEES.has(tail.toLowerCase())) {
          resolution = 'global'
        } else if (externalPackages.has(tail)) {
          external = true
        }
      } else {
        const receiverRoot = String(raw?.receiver ?? calleeName.split(/[.:]+/)[0] ?? '')
        if (GLOBAL_CALLEES.has(receiverRoot.toLowerCase())) {
          resolution = 'global'
        } else if (externalPackages.has(receiverRoot)) {
          external = true
        } else {
          const targetFile = localBindings.get(receiverRoot)
          if (targetFile !== undefined) {
            const candidates = (symbolByFile.get(targetFile) ?? []).filter((symbol) => symbol.name === tail)
            if (candidates.length === 1) {
              toSymbolId = candidates[0].id
              resolution = 'import'
            } else {
              resolution = 'import'
            }
          }
        }
      }

      const record = {
        id: `${file.id}:${line}:${calleeName}`,
        fileId: file.id,
        moduleId: file.moduleId,
        line,
        calleeName,
        receiver: raw?.receiver ? String(raw.receiver) : null,
        kind: raw?.kind ?? 'call',
        fromSymbolId: fromSymbol === null ? null : fromSymbol.id,
        toSymbolId,
        resolution,
        external,
      }
      calls.push(record)
      file.calls.push(record.id)
    }
  }

  /* --- 第三遍补：把没有归属的调用挂到最内层的函数类符号上 --- */
  // 解析器对内联箭头函数（Express 里极常见：`app.post('/x', async (req) => {...})`）
  // 可能给不出 fromSymbolName，调用就会变成孤儿；这里按**行号区间**把它归给最内层的
  // 函数类符号，否则关键流程会在入口处断掉。只认函数类 kind：把调用挂到
  // `const order = ...` 这种变量符号上会输出误导性的调用链。
  const ATTRIBUTABLE_KINDS = new Set(['function', 'method', 'component', 'route-handler', 'module-init', 'class'])
  let attributedCalls = 0
  for (const call of calls) {
    if (call.fromSymbolId !== null) continue
    const candidates = (symbolByFile.get(call.fileId) ?? [])
      .filter((symbol) => ATTRIBUTABLE_KINDS.has(symbol.kind))
      .filter((symbol) => symbol.line <= call.line && call.line <= symbol.endLine)
      .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line) || b.line - a.line)
    if (candidates.length > 0) {
      call.fromSymbolId = candidates[0].id
      attributedCalls += 1
    }
  }

  /* --- 调用边计数与符号风险 --- */
  const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]))
  for (const call of calls) {
    if (call.toSymbolId === null) continue
    const target = symbolById.get(call.toSymbolId)
    if (target !== undefined) target.fanIn += 1
    if (call.fromSymbolId !== null) {
      const caller = symbolById.get(call.fromSymbolId)
      if (caller !== undefined) caller.fanOut += 1
    }
  }
  for (const symbol of symbols) {
    symbol.risk = symbol.fanIn >= 12 ? 'high' : symbol.fanIn >= 5 ? 'medium' : 'low'
  }

  /* --- 路由处理器绑定 --- */
  for (const route of routes) {
    if (route.handlerName) {
      const candidates = (symbolByFile.get(route.fileId) ?? []).filter((symbol) => symbol.name === route.handlerName)
      if (candidates.length === 1) route.handlerSymbolId = candidates[0].id
    }
    if (route.handlerSymbolId === null) {
      // 兜底：路由行之后最近的一个**函数类**符号（Express 内联箭头函数的情形）。
      // 必须排除变量/常量符号——否则会把处理器体内部的 `const order = ...`
      // 当成处理器，报告里就会出现指向错误符号的调用链。
      const near = (symbolByFile.get(route.fileId) ?? [])
        .filter((symbol) => ATTRIBUTABLE_KINDS.has(symbol.kind))
        .filter((symbol) => symbol.line >= route.line && symbol.line - route.line <= 8)
        .sort((a, b) => a.line - b.line)[0]
      if (near !== undefined) route.handlerSymbolId = near.id
    }
  }

  /* --- 模块聚合 --- */
  for (const file of files) {
    const module = modules.get(file.moduleId)
    if (module === undefined) continue
    for (const importId of file.imports) {
      const record = importIndex.get(file.id)?.get(importId)
      if (record === undefined || record.targetModule === null) continue
      if (record.targetModule !== module.id) module.dependsOn.push(record.targetModule)
    }
  }
  const entrypointPaths = new Set(
    (input.profile?.entrypoints ?? []).map((entry) => toPosix(typeof entry === 'string' ? entry : entry?.path ?? '')),
  )
  for (const module of modules.values()) {
    module.dependsOn = uniq(module.dependsOn).sort()
    const kinds = module.files.map((id) => fileById.get(id)?.kind ?? 'source')
    module.kind = moduleKindOf(kinds)
    module.notes = uniq(module.notes).slice(0, 20)
    const hasTest = module.files.some((id) => fileById.get(id)?.kind === 'test')
    if (!hasTest && module.kind !== 'test' && module.kind !== 'config') module.notes.push('该模块没有测试文件')
    for (const id of module.files) if (entrypointPaths.has(id)) module.entrypoints.push(id)
  }
  for (const module of modules.values()) {
    for (const dependency of module.dependsOn) {
      const target = modules.get(dependency)
      if (target !== undefined) target.dependedOnBy.push(module.id)
    }
  }
  for (const module of modules.values()) {
    module.dependedOnBy = uniq(module.dependedOnBy).sort()
    module.entrypoints = uniq(module.entrypoints).sort()
    module.risk = module.dependedOnBy.length >= 6 ? 'high' : module.dependedOnBy.length >= 3 ? 'medium' : 'low'
  }

  /* --- 统计 --- */
  const languages = new Map()
  for (const file of files) {
    const bucket = languages.get(file.language) ?? { name: file.language, files: 0, loc: 0, symbols: 0 }
    bucket.files += 1
    bucket.loc += file.loc
    bucket.symbols += file.symbols.length
    languages.set(file.language, bucket)
  }

  const moduleList = [...modules.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const sortedSymbols = [...symbols].sort(byId)

  return {
    schemaVersion: IR_SCHEMA_VERSION,
    root,
    name: input.name ?? path.posix.basename(root),
    generatedAt,
    profileSummary: summarizeProfile(input.profile),
    modules: moduleList,
    files: files.sort(byId),
    symbols: sortedSymbols,
    imports: imports.sort(byId),
    calls: calls.sort(byId),
    routes: routes.sort(byId),
    graph: input.graph ?? emptyGraph(),
    stats: {
      modules: moduleList.length,
      files: files.length,
      sourceFiles: files.filter((file) => file.kind === 'source').length,
      symbols: sortedSymbols.length,
      imports: imports.length,
      calls: calls.length,
      routes: routes.length,
      loc: files.reduce((total, file) => total + file.loc, 0),
      languages: [...languages.values()].sort((a, b) => b.loc - a.loc),
      unresolvedCalls: calls.filter((call) => call.resolution === 'unresolved').length,
      externalImports: imports.filter((record) => record.external).length,
      // 按行号区间归位的调用数（解析器给不出 fromSymbolName 时的兜底），
      // 用于让读者知道调用链里有多少步骤来自启发式归属，而不是解析器的精确结果。
      attributedCalls,
    },
    warnings: uniq(warnings),
    truncated: input.truncated === true || input.profile?.truncated === true,
    budget: input.budget ?? { filesAnalyzed: files.length, filesSkipped: 0, bytesRead: 0, durationMs: 0, llmCalls: 0 },
  }
}

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 空图谱：IR 装配阶段先占位，`lib/graph.js` 之后回填。 */
export function emptyGraph() {
  return {
    module: { nodes: [], edges: [], cycles: [] },
    file: { nodes: [], edges: [], cycles: [] },
    symbol: { nodes: [], edges: [], cycles: [] },
    metrics: { fanIn: {}, fanOut: {}, hubs: [], orphans: [], entryReach: {}, riskModules: [] },
    stats: { moduleNodes: 0, moduleEdges: 0, fileNodes: 0, fileEdges: 0, symbolNodes: 0, symbolEdges: 0, crossModuleEdges: 0, cycles: 0 },
  }
}

/** 画像摘要：IR 只保留报告需要的部分，避免体积翻倍。 */
export function summarizeProfile(profile) {
  if (profile === undefined || profile === null) return null
  return {
    name: profile.name ?? null,
    scannedAt: profile.scannedAt ?? null,
    kinds: profile.kinds ?? [],
    ecosystems: profile.ecosystems ?? [],
    commands: profile.commands ?? [],
    entrypoints: profile.entrypoints ?? [],
    tests: profile.tests ?? { frameworks: [], testFiles: [], testFileCount: 0, coverageConfig: [] },
    deps: profile.deps ?? { direct: [], dev: [], notable: [] },
    signals: profile.signals ?? { todoCount: 0, todos: [], debugStatementCount: 0, secretSuspects: [], largeFiles: [], generatedFiles: [] },
    sensitive: profile.sensitive ?? [],
    configs: profile.configs ?? [],
    docs: profile.docs ?? [],
    ci: profile.ci ?? [],
    containers: profile.containers ?? [],
    iac: profile.iac ?? [],
    size: profile.size ?? { files: 0, dirs: 0, bytes: 0, sourceFiles: 0, skipped: 0, truncated: false },
    gaps: profile.gaps ?? [],
    warnings: profile.warnings ?? [],
  }
}

/**
 * IR 自检：测试与 `status` 都用它，返回问题清单（空数组表示健康）。
 * @param ir 待校验 IR。
 */
export function validateIR(ir) {
  const problems = []
  if (ir === undefined || ir === null || typeof ir !== 'object') return ['IR 为空']
  if (ir.schemaVersion !== IR_SCHEMA_VERSION) problems.push(`schemaVersion 不匹配：${ir.schemaVersion}`)
  const fileIds = new Set((ir.files ?? []).map((file) => file.id))
  const symbolIds = new Set((ir.symbols ?? []).map((symbol) => symbol.id))
  const seen = new Set()
  for (const symbol of ir.symbols ?? []) {
    if (seen.has(symbol.id)) problems.push(`符号 id 重复：${symbol.id}`)
    seen.add(symbol.id)
    if (!fileIds.has(symbol.fileId)) problems.push(`符号指向不存在的文件：${symbol.id}`)
    if (!(symbol.line >= 1)) problems.push(`符号行号非法：${symbol.id}`)
    if (symbol.endLine < symbol.line) problems.push(`符号 endLine 小于 line：${symbol.id}`)
  }
  for (const file of ir.files ?? []) {
    for (const id of file.symbols ?? []) if (!symbolIds.has(id)) problems.push(`文件引用了不存在的符号：${file.id} -> ${id}`)
  }
  for (const call of ir.calls ?? []) {
    if (call.toSymbolId !== null && !symbolIds.has(call.toSymbolId)) problems.push(`调用指向不存在的符号：${call.id}`)
    if (call.toSymbolId !== null && call.resolution === 'unresolved') problems.push(`unresolved 调用却带绑定：${call.id}`)
  }
  for (const record of ir.imports ?? []) {
    if (record.target !== null && !fileIds.has(record.target)) problems.push(`导入指向不存在的文件：${record.id}`)
  }
  for (const route of ir.routes ?? []) {
    if (!fileIds.has(route.fileId)) problems.push(`路由指向不存在的文件：${route.id}`)
    if (route.handlerSymbolId !== null && !symbolIds.has(route.handlerSymbolId)) problems.push(`路由处理器不存在：${route.id}`)
  }
  return problems
}
