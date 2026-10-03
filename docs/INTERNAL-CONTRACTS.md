# Project Compass 内部契约（冻结版）

> 本文件是**并行开发的唯一接口真相**。任何模块都必须严格按这里的形状收发数据；
> 需要改契约时先改本文件，再改代码。
>
> 版本：v1（冻结于脚手架阶段）

---

## 0. 工程硬约束

1. **零外部依赖**：只允许 `node:*` 内置模块。不得 import npm 包（包括 `tree-sitter`、
   `@deepseek-ai/*`）。宿主侧只通过 `ctx` 对象访问服务，不 import 宿主代码。
2. **ESM**：`"type": "module"`，所有相对 import 必须带 `.js` 后缀。
3. **无 default export**（插件入口）：Loader 的 `unwrapExports` 会折叠 default 并丢掉
   `inject`。入口只允许命名导出 `name` / `inject` / `apply`。
4. **容错优先**：解析器、检索器、报告渲染器对畸形输入**不得抛错**，应降级并写 `warnings`。
   只有工具入参非法才抛错（由 `lib/tools.js` 负责）。
5. **纯函数优先**：`lib/util.js` 无 import、无 I/O；解析器除入参外无 I/O；
   I/O 只出现在 `lib/store.js`、`lib/scan.js`、`lib/cache.js`、`lib/rag.js`、`lib/tools.js`。
6. **行号 1-based**，路径统一 posix 相对路径（`toPosix`），模块 id 为目录相对路径（根为 `.`）。
7. **中文注释 / 中文输出**：面向中文用户，报告与工具描述用中文；标识符与字段名用英文。
8. **测试**：`node:test` + `node:assert/strict`，文件放 `test/*.test.js`，
   `node --test` 必须全绿。测试不得联网、不得依赖 DSH 宿主。

---

## 1. 共享 API（已实现，直接用）

### `lib/util.js`（纯函数，零依赖）

```
nowIso() clip(v,n) normalizeText(t) decodeText(bytes) countLines(t)
isBinarySample(bytes) formatBytes(n) toPosix(p) trimTrailingSlash(p)
slugify(v,fallback) stripExtension(n) extensionOf(n) withoutExtension(p)
uniq(a) compact(a) groupBy(a,fn) countBy(a,fn) sortBy(a,fn,dir) sum(a) percentile(a,p)
chunk(a,size) mapLimit(values,limit,worker,onError) -> Promise<Array>
splitIdentifier(name) isStopWord(w) tokenize(text) -> string[]
compileGlob(pattern) matchGlob(pattern,relPath) matchIgnoreRules(relPath,patterns)
hashContent(text) -> 16位hex   stableStringify(v)   jsonSafe(v)
cite(relPath,{line,symbol,note}) -> {path,line,symbol,text}
mermaidSafe(text,max)
```

### `lib/paths.js`

```
STATE_DIR='.project-compass'  DEFAULT_OUTPUT_DIR='docs/project-compass'
IGNORE_FILE='.compassignore'  REPORT_FILES  REPORT_ORDER
stateDir(root) cacheDir(root) cacheEntryFile(root,key) scanFile(root) irFile(root)
stateFile(root) indexFile(root) qaLogFile(root)
reportsDir(root,outputDir) reportPaths(root,outputDir) -> {onboarding,architecture,moduleMap,keyFlows,gettingStarted,json}
relPath(root,abs) absPath(root,rel) isInside(root,target) moduleIdOf(relFile)
```

### `lib/store.js`

```
pathExists(p) statSafe(p) isDirectory(p) isFile(p) ensureDir(dir)
readTextFile(f,fallback) readJsonFile(f,fallback)
writeTextFile(f,text) -> path        // 原子写
writeJsonFile(f,value) -> path       // 原子写
appendLine(f,line) listDir(dir) -> [{name,dir,file,symlink}]
removeFile(f) removeDir(dir) dirStats(dir) -> {files,bytes}
```

---

## 2. 解析器契约（`lib/parse/`）

### `lib/parse/index.js`

```js
export const SUPPORTED_LANGUAGES = ['typescript','javascript','tsx','jsx','python','java','go','rust','c','cpp','csharp','ruby','php','kotlin','scala','swift','shell','sql','vue','svelte','html','css','yaml','json','markdown','text']

/** 按路径判定语言；无法判定返回 'text'。 */
export function detectLanguage(relPath) -> string

/** 是否为"深度解析"语言（typescript/javascript/tsx/jsx/python/java）。 */
export function isDeepLanguage(language) -> boolean

/**
 * 统一入口：按语言分派。永不抛错。
 * @param input {relPath, content, language, fileId, moduleId}
 * @returns ParsedFile
 */
export function parseFile(input) -> ParsedFile
```

### `ParsedFile`

```js
{
  language: string,
  symbols: Symbol[],        // 见 §3
  imports: RawImport[],
  calls: RawCall[],
  routes: RawRoute[],
  exports: string[],        // 导出的符号名
  todos: Todo[],
  notes: string[],          // 降级/异常说明
}
RawImport { specifier, line, names: string[], kind: 'static'|'dynamic'|'require'|'side-effect'|'export-from' }
RawCall   { calleeName, line, fromSymbolName|null, kind: 'call'|'new'|'await' , receiver?: string }
RawRoute  { method, path, line, handlerName|null, framework, middlewares?: string[] }
Todo      { line, text, kind: 'todo'|'fixme'|'hack'|'xxx'|'note' }
```

解析器**只做词法/结构抽取，不做跨文件解析**：`specifier` 原样保留，由 IR 层解析成 fileId。

### 各语言最低要求（FR2）

| 语言 | 必须抽出 |
|---|---|
| TS/JS/TSX/JSX | 函数/箭头函数/类/方法/接口/类型/枚举/常量；import/export（含 `from`、`require`、动态 `import()`）；顶层与类内调用；Express/Koa/Fastify/NestJS 路由；React 组件 |
| Python | `def`/`async def`/`class`；`import`/`from ... import`；装饰器（`@app.route`/`@router.get`/FastAPI/Flask/Django）；调用表达式；`__all__` |
| Java | 类/接口/枚举/注解类型/记录；方法（含构造器）；`package`/`import`；注解路由（Spring `@GetMapping` 等）；方法调用 |
| 其它（generic） | 轻量抽取：顶层声明（`func`/`fn`/`class`/`def`/`sub`/`function`）、import/use/include、TODO。产出可与深度语言同构，但允许 `symbols` 稀疏 |

**定位算法**：行扫描 + 括号/缩进配平，**必须**给出正确的 `line`（1-based）与 `endLine`；
嵌套符号用 `parent`（父符号名）表达。宁可少报也不要错报行号。

---

## 3. 统一 IR（FR3）

```js
IR {
  schemaVersion: 1,
  root, name, generatedAt,
  profileSummary: { kinds, ecosystems, commands, entrypoints, tests, signals },
  modules: Module[], files: File[], symbols: Symbol[], imports: Import[], calls: Call[], routes: Route[],
  graph: GraphBundle,        // §5 graph.js 产出
  stats: { modules, files, sourceFiles, symbols, imports, calls, routes, loc, languages },
  warnings: string[],        // 降级与截断说明
  truncated: boolean,
  budget: { filesAnalyzed, filesSkipped, bytesRead, durationMs, llmCalls },
}
```

```js
Module { id, name, dir, language, kind:'source'|'test'|'config'|'docs'|'infra'|'asset'|'generated'|'mixed',
         files: fileId[], loc, symbolCount, entrypoints: fileId[],
         dependsOn: moduleId[], dependedOnBy: moduleId[], risk: 'low'|'medium'|'high', notes: string[] }

File   { id: relPath, moduleId, abs? (不落盘), language, kind, loc, bytes, hash,
         symbols: symbolId[], imports: importId[], calls: callId[], routes: routeId[],
         exports: string[], todos: Todo[], parse: 'deep'|'light'|'skipped', warnings: string[] }

Symbol { id: `${fileId}#${name}@${line}`, fileId, moduleId, name, kind:
         'function'|'method'|'class'|'interface'|'type'|'enum'|'const'|'variable'|'component'|'route-handler'|'module-init',
         line, endLine, exported, parent|null, signature|null, doc|null, loc,
         fanIn, fanOut, risk }

Import { id: `${fileId}:${line}`, fileId, moduleId, specifier, line, names: string[],
         kind, target: fileId|null, targetModule: moduleId|null, external: boolean, packageName|null, resolved: boolean }

Call   { id: `${fileId}:${line}:${calleeName}`, fileId, moduleId, line, calleeName, receiver|null,
         kind, fromSymbolId: symbolId|null, toSymbolId: symbolId|null,
         resolution: 'same-file'|'import'|'global'|'unresolved', external: boolean }

Route  { id: `${method} ${path}`, method, path, framework, fileId, moduleId, line,
         handlerSymbolId: symbolId|null, handlerName|null, middlewares: string[], kind: 'http'|'cli'|'event' }
```

**调用解析（唯一允许的猜测，必须记录 `resolution`）**：
1. `same-file`：同名符号在本文件内唯一 → 直接绑定；
2. `import`：本文件 import 的 `names` 中含该名，且目标文件内同名符号唯一 → 绑定；
3. `global`：内置/宿主全局（如 `console.log`、`JSON.parse`、`print`、`len`）→ `toSymbolId=null`；
4. 其余为 `unresolved`（`toSymbolId=null`），**不得**猜测。

**修订 r4（内联处理器）**：路由的处理器若写成内联函数/箭头函数
（`app.post('/x', async (req, res) => {...})`），解析器**必须**为其产出一个
`kind: 'route-handler'` 的符号（`line` 为函数起始行、`endLine` 为函数体闭合行），
并把 `RawRoute.handlerName` 设为该符号名；箭头体内的调用其 `fromSymbolName` 必须指向它。
否则关键流程会在入口处断掉——Express 里这是最常见的写法。

**修订 r5（孤儿调用归属）**：IR 装配会把 `fromSymbolId === null` 的调用挂到**最内层的函数类符号**
（`function|method|component|route-handler|module-init|class`，按行号区间包含关系）上。
只认函数类 kind：把调用挂到 `const order = ...` 这类变量符号上会输出误导性调用链。
路由的兜底绑定同样只考虑函数类符号。

---

## 4. 扫描画像（FR1，`lib/scan.js`）

```js
export async function scanProject(root, options = {}) -> Profile
export function defaultIgnoreRules() -> string[]
export function isSensitivePath(relPath) -> { sensitive: boolean, kind: string|null, reason: string|null }
```

`options`：`{ ignore, include, exclude, maxFiles, maxFileBytes, maxTotalBytes, maxDurationMs, extraSensitivePatterns, followSymlinks, now }`。

**修订 r3**：
- `exclude: string[]` 是**结构性排除**（相对路径前缀），与本工具自身产物有关，**优先于一切 ignore/include 规则**：即使 `.gitignore` 写了 `!docs/project-compass`，产物也不得被分析。始终排除 `STATE_DIR`（`.project-compass`）与 `DEFAULT_OUTPUT_DIR`（`docs/project-compass`，两者都从 `lib/paths.js` 取常量）；被排除的路径不进 `sources`、不计入 `languages`/`size.sourceFiles`，但计入 `size.skipped`，并在 `ignore.sources` 里加 `'exclude'` 标记。
- `entrypoints[].kind` 取值扩展为 `main|bin|http-server|cli|worker|test-entry|config|export`：`main` **只**来自 `main`/`module`/`browser`/`exports["."]`；其它 `exports` 目标的 `kind` 用 `export`；**manifest 自身（package.json 等）永远不得出现在 entrypoints 里**。
- `tests.frameworks` 的判定除依赖清单外，还必须看**脚本命令与测试目录内的 import**：`node --test`/`node:test` → `node-test`，并覆盖 vitest/jest/mocha/pytest/go-test/junit/rspec/phpunit/cargo-test/playwright/cypress。
- `sources`（r2）是必需字段，见下。

```js
Profile {
  root, name, scannedAt, durationMs,
  size: { files, dirs, bytes, sourceFiles, skipped, truncated },
  languages: [{ name, files, loc, bytes }],
  kinds: string[],                  // 'cli'|'library'|'web-app'|'api-service'|'monorepo'|'plugin'|'data'|'docs-only'
  ecosystems: [{ kind, manifest, name, version, scripts: {name:cmd} }],
  commands: [{ preset, argv: string[], source }],   // preset: install|build|typecheck|lint|format|test|coverage|e2e|start|dev
  entrypoints: [{ path, kind, evidence }],          // kind: main|bin|http-server|cli|worker|test-entry|config
  configs: [{ path, kind }],
  docs: string[], ci: [{ id, path }], containers: string[], iac: string[],
  tests: { frameworks: [{ id, label, evidence }], testFiles: string[], testFileCount, coverageConfig: string[] },
  deps: { direct: string[], dev: string[], notable: [{ name, version, kind }] },
  signals: { todoCount, todos: Todo[], debugStatementCount, secretSuspects: [{ path, line, kind }], largeFiles: string[], generatedFiles: string[] },
  sensitive: [{ path, kind, reason }],   // 只记存在，绝不读内容
  ignore: { rules: string[], sources: string[] },
  gaps: [{ id, priority:'P0'|'P1'|'P2'|'P3', title, detail, evidence: string[] }],
  warnings: string[], truncated: boolean,
  /**
   * 进入分析的文件清单（分析层唯一的输入来源）。
   * 只包含"通过忽略规则"的文件；二进制也列出但 binary=true（分析层会跳过）。
   * **敏感文件必须列出**（供报告提示风险），但 sensitive=true，分析层绝不允许读取其内容。
   */
  sources: [{ path, language, bytes, loc, binary, sensitive, kind }],
}
```

**修订 r2**：`sources` 是后加的必需字段（分析层需要文件清单才能做增量缓存与解析）。
来源必须是同一次遍历的结果，不能与 `size`/`languages` 的统计口径打架（同一批文件、同一套忽略规则）。

**安全红线**：`sensitive` 命中路径**不得读取内容**，只允许 `stat`；报告中只出现路径与类型。

---

## 5. 图与流程

### `lib/graph.js`

```js
export function buildGraphs(ir, options = {}) -> GraphBundle
export function detectCycles(nodes, edges, limit) -> string[][]
```
```js
GraphBundle {
  module: { nodes: [{id,label,loc,files,symbolCount,kind}], edges: [{from,to,weight,external:false}], cycles: string[][] },
  file:   { nodes: [...], edges: [...], cycles: string[][] },
  symbol: { nodes: [...], edges: [...], cycles: string[][] },
  metrics: {
    fanIn: Record<id, number>, fanOut: Record<id, number>,
    hubs: [{ id, fanIn, fanOut }],          // 枢纽：被依赖最多
    orphans: string[],                       // 无入无出（排除入口/测试）
    entryReach: Record<fileId, boolean>,     // 从入口可达
    riskModules: [{ id, score, reasons: string[] }],
  },
  stats: { moduleNodes, moduleEdges, fileNodes, fileEdges, symbolNodes, symbolEdges, crossModuleEdges, cycles },
}
```

### `lib/flows.js`

```js
export function detectFlows(ir, options = {}) -> Flow[]
export function flowDiagram(flow, options = {}) -> string   // Mermaid sequenceDiagram
```
```js
Flow { id, name, kind:'http'|'cli'|'event'|'library'|'data',
       entry: { fileId, line, symbolId|null, symbolName|null, label },
       steps: [{ order, fileId, line, symbolId|null, symbolName|null, kind:'entry'|'call'|'data'|'side-effect'|'response', via }],
       evidence: string[],         // 'path:line' 形式
       confidence: 'high'|'medium'|'low', notes: string[] }
```

---

## 6. RAG（FR7，`lib/rag.js` + `lib/embed.js`）

```js
// lib/embed.js —— 确定性本地向量（无网络、无模型文件）
export function embed(text, dim = 256) -> Float64Array   // 哈希词向量 + 字符三元组，L2 归一化
export function cosine(a, b) -> number
export function EMBED_DIM
export function embedDerived(text) -> { dim, values: number[] }   // 可 JSON 落盘

// lib/chunk.js
export function chunkFile(irFile, symbols, options) -> Chunk[]
export function chunkIR(ir, options) -> Chunk[]
Chunk { id, fileId, moduleId, startLine, endLine, symbolId, symbolName, symbolKind, kind:'symbol'|'file-header'|'config'|'doc', text, tokens: string[], hash }

// lib/rag.js
export async function buildIndex(root, ir, options = {}) -> Index
export async function loadIndex(root) -> Index | undefined
export function searchIndex(index, query, options = {}) -> Hit[]        // 纯函数，可单测
export async function answer(root, ir, question, options = {}) -> Answer
export function indexStats(index) -> {...}
```
```js
Index { schemaVersion: 1, builtAt, dim, chunks: Chunk[], vectors: number[][], df: Record<token,number>,
        avgLen, files: Record<fileId,{ hash, chunkIds: string[] }>, stats: { chunks, tokens, files } }
Hit { chunkId, fileId, symbolId, symbolName, startLine, endLine, text, scores: { bm25, vector, fused, rerank } }
Answer { question, answer, citations: [{ path, line, symbol, text, score, why }],
         confidence: 'high'|'medium'|'low', mode: 'extractive'|'hybrid'|'llm',
         relatedSymbols: [{ id, name, fileId, line }], relatedFlows: [{ id, name, confidence }],
         evidence: string[], notes: string[], elapsedMs }
```
检索 = BM25 + 向量余弦 → RRF 融合 → 重排（符号名精确/前缀命中、路径命中、kind 权重）。
`answer()` 默认**抽取式**（不调 LLM）：由命中片段拼装带引用的答案；`options.withLlm` 时才走 LLM。

---

## 7. LLM 与验证器（FR6）

```js
// lib/llm.js
export function createLlmClient(ctx, config) -> LlmClient
LlmClient {
  available(): boolean,
  describe(): { available, provider, model, reason },
  async complete({ system, prompt, maxTokens, temperature, signal }) -> { text, provider, model, usage, elapsedMs },
}
```
- provider/model 来源：`config.provider`/`config.model` → `ctx.get('agentDefaultModel').currentSelection()` → 不可用。
- `ctx.get('llm')` 缺失即 `available() === false`，所有调用方必须降级为确定性输出。

```js
// lib/validate.js
export function createValidator(ir) -> Validator
Validator {
  hasFile(fileId), hasSymbol(symbolId), findSymbolByName(name), hasRoute(method, path),
  /** 校验一段自然语言：抽出 `path:line` / `path#symbol` / 反引号符号名，逐个核对。 */
  checkText(text) -> { ok, total, valid, dropped: [{ claim, reason }], unknownPaths: string[], unknownSymbols: string[], unknownLines: [{path,line}] },
  /** 校验结构化断言（对象的 citations/claims 字段）。 */
  checkClaims(claims) -> { kept, dropped },
}
```
判定规则：路径必须存在于 IR；行号必须落在该文件 `1..loc`；符号名必须能在 IR 中找到
（同名多义视为合法但标注 `ambiguous`）。**验证不通过的声明必须被丢弃**，并在报告里记录丢弃条数。

---

## 8. 报告（FR8/FR11，`lib/report.js` + `lib/mermaid.js`）

```js
// lib/report.js
export function renderReports(model, options = {}) -> { files: Record<key, string|object>, meta }
export function renderRoleRoutes(model, options) -> RoleRoute[]
export function roleCatalogue() -> [{ id, label, focus }]

// lib/mermaid.js
export function moduleGraphDiagram(graph, options) -> string
export function fileGraphDiagram(graph, options) -> string
export function flowDiagram(flow, options) -> string
export function architectureDiagram(model, options) -> string
export function sequenceForFlow(flow) -> string
```
```js
model = { ir, profile, graph, flows, insights: { narratives, risks, roles, readingOrder }, meta: { generatedAt, version, llm: {...}, validation: {...} } }
options = { projectName, includeMermaid: true, maxNodes: 40, role: null|undefined, locale: 'zh' }
files keys = REPORT_ORDER 中的 6 个：5 个 Markdown 字符串 + `json` 对象（IR 摘要视图，非全量 IR）
RoleRoute { role, label, focus, order: [{ step, target, path, line, why }], checklist: string[] }
```
Markdown 硬性要求：每份报告顶部有"生成时间 / 项目 / 工具版本 / 证据口径"元信息块；
架构与模块图用 Mermaid；每条结论后附证据（`path:line`）；无证据的推断必须显式标注"未验证"。

---

## 9. 文件归属（并行开发不重叠）

| 负责人 | 文件 |
|---|---|
| 契约方（主） | `package.json`、`cordis.patch.yml`、`lib/version.js`、`lib/util.js`、`lib/paths.js`、`lib/store.js`、`lib/ir.js`、`lib/cache.js`、`lib/graph.js`、`lib/flows.js`、`lib/llm.js`、`lib/validate.js`、`lib/insights.js`、`lib/project.js`、`lib/analyze.js`、`lib/pipeline.js`、`lib/tools.js`、`lib/index.js`、`lib/skill.js`、`lib/SKILL.md`、`scripts/*`、`test/core.test.js`、`test/e2e.test.js`、`test/plugin.test.js`、本文件 |
| 解析器 | `lib/parse/index.js`、`lib/parse/js-ts.js`、`lib/parse/python.js`、`lib/parse/java.js`、`lib/parse/generic.js`、`test/parse.test.js` |
| 侦察 | `lib/scan.js`、`test/scan.test.js` |
| 检索 | `lib/embed.js`、`lib/chunk.js`、`lib/rag.js`、`test/rag.test.js` |
| 报告 | `lib/mermaid.js`、`lib/report.js`、`test/report.test.js` |
| 文档 | `README.md`、`README.zh-CN.md`、`docs/*.md`（除本文件）、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、`.gitignore`、`.github/workflows/ci.yml`、`assets/*` |

**禁止**：改别人的文件；改本契约（改契约先提出来）；引入依赖；写 default export。

---

## 10. 验收

```bash
node --test                 # 全绿
node scripts/compass-cli.mjs analyze <项目>   # 真项目冒烟
node scripts/compass-cli.mjs report <项目>
node scripts/compass-cli.mjs ask <项目> "订单创建经过哪些模块？"
```
