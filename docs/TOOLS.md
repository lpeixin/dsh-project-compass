# 工具参考 / TOOLS

本文件是 Project Compass（项目罗盘）**6 个模型可见工具**与 **`/compass` 命令**的完整参考。

> 工具的真实契约是 `lib/tools.js` 里注册的 JSON Schema 与实现。本文与实现不一致时，
> **按代码为准，并把它当成文档缺陷上报**。

- [调用约定](#调用约定)
- [project_compass_scan](#project_compass_scan)
- [project_compass_analyze](#project_compass_analyze)
- [project_compass_report](#project_compass_report)
- [project_compass_ask](#project_compass_ask)
- [project_compass_update](#project_compass_update)
- [project_compass_status](#project_compass_status)
- [典型调用序列](#典型调用序列)
- [AI Agent 如何用 project_compass_ask 获取项目上下文](#ai-agent-如何用-project_compass_ask-获取项目上下文)
- [错误与降级行为](#错误与降级行为)
- [`/compass` 命令](#compass-命令)
- [命令行自测通道](#命令行自测通道)

---

## 调用约定

| 约定 | 说明 |
| --- | --- |
| `projectPath` | 目标项目根目录；**所有工具都接受**，省略时使用当前会话工作目录。指向不存在或不是目录的路径属于入参非法，直接报错 |
| 路径格式 | 工具返回与产物中出现的路径一律是项目根相对 posix 路径（`src/api/orders.ts`）；行号一律 1-based |
| 参数的两种来源 | ① profile 里的 `config`（默认值的来源）；② 单次调用显式传入（覆盖默认）。单次参数会**叠加**在配置之上（`ignore` / `include` 是追加，不是替换） |
| 只读性 | 工具只读项目源码。写入只发生在该项目的 `.project-compass/`（机器状态）与报告输出目录（默认 `docs/project-compass/`） |
| 幂等 | 同一输入重复调用结果稳定；报告是确定性渲染，可安全 diff（开启 `withLlm` 的叙述文字除外） |
| 网络 | 任何工具都不会主动发起网络请求。`llm.enabled` 与 `withLlm` 同时为真时，叙事/润色走宿主 LLM 服务 |
| 预算 | `analyze` / `report` / `update` / `ask` 受配置的 `budget.*` 约束，触顶即截断并在 `warnings` 与 `summary` 中说明 |

多数工具只返回**摘要视图**（模块概览、计数、枢纽、流程清单等），完整数据落盘在 `ir.json`。
这样做的目的是让工具返回值保持小巧——需要细节时读产物，而不是把整个 IR 塞进上下文。

---

## project_compass_scan

**用途**：侦察项目并生成结构化「项目画像」（第一步）。目录扫描、忽略规则、语言分布、技术栈与
包管理器、可执行命令、入口点、配置 / CI / 容器 / IaC、测试框架，以及**已能确定的工程缺口**。

结论全部来自磁盘证据，不含猜测；敏感文件只登记路径与类型，**绝不读取内容**。

**参数**

| 名称 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `projectPath` | string | 否 | 当前工作目录 | 目标项目根目录 |
| `force` | boolean | 否 | `true` | 为 `true` 时忽略既有画像重新扫描 |
| `ignore` | string[] | 否 | `[]` | 额外忽略规则（`.gitignore` 语法，支持 `!` 取反），叠加在配置与项目 `.gitignore` 之上 |
| `include` | string[] | 否 | `[]` | 强制包含的路径（命中则无视忽略规则；**敏感文件仍不读内容**） |

**返回字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `projectPath` | string | 解析后的项目绝对路径 |
| `projectName` | string | 项目名 |
| `scanFile` | string | 画像文件路径 |
| `kinds` | string[] | 识别到的项目类型 |
| `ecosystems` | string[] | 技术栈（`kind(manifest)` 形式） |
| `commands` | string[] | 可执行命令（`preset: 命令行` 形式） |
| `entrypoints` | string[] | 入口点（`path (kind)` 形式） |
| `languages` | string[] | 语言分布（`name: N 文件 / M 行`，最多 8 项） |
| `tests` | object | `{ frameworks, testFiles, coverageConfig }` |
| `gaps` | string[] | 已确认的工程缺口（优先级 + 标题） |
| `sensitive` | string[] | 敏感文件路径与类型（**未读取内容**） |
| `stats` | object | `{ files, sourceFiles, dirs, bytes, skipped, truncated, todoCount, debugStatements, secretSuspects, analyzableSources, durationMs }` |
| `summary` | string | 一句话结论与建议的下一步 |

**产物**：`<项目>/.project-compass/scan.json`（完整 `Profile`，字段远多于上面的摘要）。

**备注**

- 敏感登记只出现在 `sensitive` 与 `stats.secretSuspects`（计数）里，**没有内容**；
- `commands` 只报告「发现」了什么命令，**不执行**任何命令；
- 单次 `scan` 不做深度解析，符号 / 导入 / 调用 / 路由属于 `analyze`。

---

## project_compass_analyze

**用途**：解析代码并构建统一中间表示（IR）与依赖知识图谱（第二步）：多语言符号 / 导入 / 调用 /
路由抽取 → 模块·文件·符号三级依赖图 → 关键流程识别。

基于内容哈希做增量：未变更的文件直接复用上次解析结果，只有内容、语言或解析器版本变化才重新解析。
跨文件绑定只走显式 import 声明，无法确定的一律标记为未解析——**宁可断边也不猜**。

**参数**

| 名称 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `projectPath` | string | 否 | 当前工作目录 | 目标项目根目录 |
| `force` | boolean | 否 | `false` | 忽略解析缓存，强制重新解析全部文件 |
| `maxFiles` | number | 否 | 配置的 `budget.maxFiles` | 本次纳入分析的文件数上限 |
| `concurrency` | number | 否 | 配置的 `concurrency`（默认 8） | 解析并发度（1–64） |
| `ignore` | string[] | 否 | `[]` | 额外忽略规则 |
| `include` | string[] | 否 | `[]` | 强制包含的路径 |

> 本工具**不接受** `withLlm`：分析阶段不调用 LLM，叙事增强属于 `report`。

**返回字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `projectPath` | string | 项目绝对路径 |
| `irFile` | string | IR 文件路径 |
| `modules` | array | 模块概览：`{ id, kind, language, files, loc, symbols, dependsOn, risk }`（最多 30 个） |
| `counts` | object | `{ modules, files, sourceFiles, symbols, imports, calls, routes, flows, loc, unresolvedCalls, externalImports }` |
| `graph` | object | `{ stats, hubs, cycles, riskModules }`（`hubs` / `riskModules` 各最多 10 项，`cycles` 最多 5 组） |
| `flows` | array | `[{ id, name, kind, confidence, entry, steps }]`（最多 10 条） |
| `cache` | object | 解析缓存命中统计与 `parserVersion` |
| `changes` | object \| null | `{ added, changed, removed, unchanged }`；首次分析为 `null` |
| `warnings` | string[] | 降级与截断说明（最多 20 条） |
| `durationMs` | number | 本次分析耗时 |
| `summary` | string | 一句话结论与建议的下一步 |

**产物**：`<项目>/.project-compass/ir.json`（完整 IR）+ `.project-compass/cache/`（解析缓存）。

**备注**

- 已有画像时直接复用（不重复扫描）；没有画像时先扫描一次并落盘；
- `warnings` 里可能出现「未解析调用占比过高」这类提示，此时应下调对图的信任度，
  并用 `ask` 补充验证。

---

## project_compass_report

**用途**：生成面向开发者的入门报告（第三步），输出 6 份产物：
`ONBOARDING.md`、`ARCHITECTURE.md`、`MODULE_MAP.md`、`KEY_FLOWS.md`、`GETTING_STARTED.md`、
`project-compass.json`。

报告包含 Mermaid 架构图与依赖图、关键调用链时序图、按角色（后端 / 前端 / 测试 / 运维 / 数据）
的阅读路线，每条结论都附 `path:line` 证据。**默认不调用 LLM**——全部结论来自静态证据。

**参数**

| 名称 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `projectPath` | string | 否 | 当前工作目录 | 目标项目根目录 |
| `outputDir` | string | 否 | 配置的 `outputDir`（默认 `docs/project-compass`） | 报告输出目录（相对项目根） |
| `withLlm` | boolean | 否 | `false` | 是否调用 LLM 生成叙事（需要用户明确同意消耗额度） |
| `includeMermaid` | boolean | 否 | `true` | 是否内嵌 Mermaid 图；`false` 时图的位置替换为说明文字 |
| `role` | string | 否 | 不限 | 只渲染某个角色的阅读路线：`backend` / `frontend` / `test` / `devops` / `data` |
| `maxNodes` | number | 否 | `40` | Mermaid 单图节点上限（5–200） |
| `withIndex` | boolean | 否 | `true` | 是否同时构建检索索引，让后续 `ask` 立即可用 |

**返回字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `projectPath` | string | 项目绝对路径 |
| `reportDir` | string | 报告目录 |
| `files` | object | 6 份产物的键与路径 |
| `counts` | object | 报告统计（模块 / 文件 / 符号 / 路由 / 流程 / 风险） |
| `llm` | object | `{ used, provider, model, reason, droppedClaims }` |
| `roleRoutes` | number | 生成的角色路线条数 |
| `index` | object \| null | 检索索引统计（`withIndex: false` 时为 `null`） |
| `warnings` | string[] | 渲染告警 |
| `summary` | string | 一句话结论与建议的下一步 |

**产物**：`<outputDir>/` 下 6 个文件（默认 `docs/project-compass/`）。结构与字段见
[OUTPUT-FORMAT.md](OUTPUT-FORMAT.md)。

**LLM 与验证器**：`withLlm: true` 时使用会话默认模型（或在配置里指定 provider/model）润色叙事，
并且**每一条 LLM 声明都必须带引用并通过验证器**（路径存在于 IR、行号落在 `1..loc` 内、
符号能在 IR 中找到）。验证不通过的声明**直接丢弃**，条数计入 `llm.droppedClaims` 与报告元信息。
如果配置里 `llm.enabled` 为 `false` 而调用方传了 `withLlm: true`，会记录一条 warning 并尝试使用
会话默认模型。

**前置条件**：需要已有 IR；没有会明确报错并提示先调用 `analyze`。

---

## project_compass_ask

**用途**：就项目提问并获得**带引用的答案**。本地 BM25 + 向量混合检索 → RRF 融合 → 重排，
命中源码分块后给出结论与 `path:line` 证据。默认抽取式回答，**不联网、不调用 LLM**。

**参数**

| 名称 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `projectPath` | string | 否 | 当前工作目录 | 目标项目根目录 |
| `question` | string | **是** | — | 问题；建议包含具体功能名、符号名或文件名以提高召回质量 |
| `limit` | number | 否 | `8` | 返回的证据条数上限（1–50） |
| `withLlm` | boolean | 否 | `false` | 是否用 LLM 润色答案（需要 `llm.enabled`） |
| `rebuildIndex` | boolean | 否 | `false` | 强制重建索引后重新回答（索引缺失时会自动构建） |

**返回字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `projectPath` | string | 项目绝对路径 |
| `question` | string | 原问题 |
| `answer` | string | 带引用的答案（截断到 6000 字符） |
| `confidence` | string | `high` / `medium` / `low` |
| `mode` | string | `extractive`（默认）/ `hybrid` / `llm` |
| `citations` | array | `[{ text, path, line, symbol, why, score }]`（最多 20 条；`why` 截断到 200 字符） |
| `relatedSymbols` | array | 相关符号（最多 10 条） |
| `relatedFlows` | array | 相关关键流程（最多 5 条） |
| `notes` | string[] | 说明与降级原因（最多 10 条） |
| `indexRebuilt` | boolean | 本次是否顺带重建了索引 |
| `elapsedMs` | number | 检索与回答耗时 |

**产物**：不留报告文件；问答留痕追加到 `<项目>/.project-compass/qa-log.jsonl`（留痕失败不影响回答）。

**前置条件**：需要已有 IR；没有会明确报错并提示先调用 `analyze`。

**隐私**：默认模式下提问内容与命中片段只在本机处理；`withLlm: true` 才会把检索到的片段作为
唯一事实来源交给模型润色。

---

## project_compass_update

**用途**：增量更新分析结果与报告（第四步）：重新扫描 → 只重新解析变更文件 →
刷新 IR / 图谱 / 流程 → 增量更新检索索引 → 重新生成报告。

**参数**

| 名称 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `projectPath` | string | 否 | 当前工作目录 | 目标项目根目录 |
| `outputDir` | string | 否 | 配置的 `outputDir` | 报告输出目录（相对项目根） |
| `withLlm` | boolean | 否 | `false` | 是否调用 LLM 生成叙事 |
| `withReport` | boolean | 否 | `true` | 是否重新生成报告；只想刷新 IR 时设 `false` |
| `withIndex` | boolean | 否 | `true` | 是否增量更新检索索引 |

**返回字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `projectPath` | string | 项目绝对路径 |
| `changes` | object | `{ added, changed, removed, unchanged }` 文件数 |
| `changedSample` | string[] | 变更文件示例（最多 20 个） |
| `irFile` | string | IR 文件路径 |
| `reports` | object \| null | 报告路径（`withReport: false` 时为 `null`） |
| `index` | object \| null | 索引统计（`withIndex: false` 时为 `null`） |
| `durationMs` | number | 耗时 |
| `summary` | string | 一句话结论 |

**产物**：刷新 `.project-compass/scan.json`、`ir.json`、`index.json`，并按需重写报告。

**边界**：如果**从未分析过**（没有 IR），`update` 不会报错，而是做一次全量分析并在 `summary`
里明确写出「此前没有分析基线，本轮做了全量分析」——全量与增量的成本差异必须让调用方知情。

---

## project_compass_status

**用途**：查看当前项目的罗盘状态。**不修改任何文件。** 适合回答「这个项目分析过没有」
「报告在哪」「结果是不是过时了」。

**参数**

| 名称 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `projectPath` | string | 否 | 当前工作目录 | 目标项目根目录 |
| `detail` | string | 否 | `compact` | `compact` 或 `full`；`full` 时 `ir.topModules` 给出 20 个模块（默认 5 个） |

**返回字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `projectPath` | string | 项目绝对路径 |
| `analyzed` | boolean | 是否已有可用 IR |
| `hasScan` | boolean | 是否有扫描画像 |
| `hasIndex` | boolean | 是否有检索索引 |
| `files` | object | `{ scan, ir, state, index }` 状态文件路径 |
| `artifacts` | object | 每份报告的 `{ path, exists, bytes }` |
| `ir` | object \| null | `{ generatedAt, stats, truncated, budget, moduleCount, topModules }` |
| `cache` | object | `{ files, bytes }` 解析缓存规模 |
| `index` | object \| null | 索引统计（`chunks` / `files` / `dim` / `builtAt`） |
| `state` | object | 运行状态：上次分析时间、预算、产物、问答计数 |
| `answerCount` | number | 累计问答次数 |
| `nextSteps` | string[] | 建议的下一步（按状态动态生成） |
| `summary` | string | 一句话结论 |

**典型返回（示意）**

```json
{
  "analyzed": true,
  "hasScan": true,
  "hasIndex": true,
  "artifacts": {
    "onboarding": { "path": "/repo/app/docs/project-compass/ONBOARDING.md", "exists": true, "bytes": 18240 }
  },
  "ir": { "stats": { "files": 213, "symbols": 1480, "routes": 26 }, "truncated": false },
  "cache": { "files": 131, "bytes": 4980736 },
  "index": { "chunks": 2140, "files": 198 },
  "nextSteps": ["调用 project_compass_ask 就具体功能提问（带引用回答）"],
  "summary": "已分析：213 文件 / 1480 符号 / 26 路由；报告产物 6/6 份；缓存 131 个条目（4864 KB）；索引 2140 块"
}
```

---

## 典型调用序列

### 场景 A：首次全面上手

```text
project_compass_status  { projectPath }              # 先确认状态，避免重复大分析
project_compass_scan    { projectPath }              # 快速看清这是什么项目（可选，analyze 会复用画像）
project_compass_analyze { projectPath }              # 解析 + IR + 图谱（首次可能较慢）
project_compass_report  { projectPath }              # 生成 6 份产物 + 检索索引
project_compass_ask     { projectPath, question: "认证流程经过哪些模块？" }
```

### 场景 B：改完代码

```text
project_compass_update  { projectPath }              # 只重算变更文件，刷新 IR/索引/报告
```

### 场景 C：只想快速定位一个问题

```text
project_compass_status  { projectPath }              # 有 IR 就直接问
project_compass_ask     { projectPath, question: "订单金额在哪里计算？" }
```

### 场景 D：怀疑结果过时或不全

```text
project_compass_status  { projectPath }                          # 看 artifacts 与 nextSteps
project_compass_analyze { projectPath }                          # 增量
project_compass_analyze { projectPath, force: true }             # 强制全量重算
project_compass_ask     { projectPath, question: "…", rebuildIndex: true }
```

---

## AI Agent 如何用 project_compass_ask 获取项目上下文

这一节写给「读这段文档的模型」：**在动手改代码之前，用 `ask` 换取有出处的上下文，
而不是靠猜或靠零散 grep。**

**推荐流程**

1. **先看状态，别急着重算**

   ```json
   { "projectPath": "/repo/app" }
   ```
   用 `project_compass_status` 确认是否已有 IR 与索引。`analyzed: false` 时先 `analyze`；
   已有 IR 但代码刚改过，就用 `update`。

2. **用具体问题换带引用的答案**

   ```json
   { "projectPath": "/repo/app", "question": "登录流程经过哪些模块？" }
   ```
   返回里的 `citations[]` 是硬通货：`path` + `line` 指向真实代码位置，`why` 说明它支撑了哪条结论。
   **只使用 `citations` 里出现过的路径与行号**去引用代码。

3. **校验后再引用**

   如果答案里出现了一个文件名，但 `citations` 里没有它，就**不要**把它写进回答或改动计划。
   这是本工具的核心承诺：验证器只放行能在 IR 中核对到的路径、行号与符号。

4. **读置信度决定后续动作**

   | `confidence` | 建议动作 |
   | --- | --- |
   | `high` | 可以直接据此规划；引用时带上 `path:line` |
   | `medium` | 顺着 `relatedSymbols` / `relatedFlows` 再读两三个文件确认边界 |
   | `low` | 当成线索而不是结论：换更具体的问法（带上模块名、函数名、报错信息），或用 `rebuildIndex: true` 重建索引后重试 |

5. **顺着结果继续追问，而不是重新开一轮**

   ```json
   { "projectPath": "/repo/app", "question": "createSession 被哪些地方调用？改动它的返回值会影响谁？" }
   ```
   `relatedFlows` 给出这条链路在 `KEY_FLOWS.md` 里的对应条目，可以对照报告一起看。

6. **要长期上下文就生成报告，而不是反复问**

   如果你需要的是「整个项目的地图」，一次 `project_compass_report` 产出的 6 份产物比十次问答更省上下文；
   之后把 Markdown 当资料读，只在具体问题上用 `ask`。

7. **一次问一个问题，并把答案里的引用当唯一事实来源**

   多个不相关问题混在一句里会让检索分散命中、置信度下降。拆分提问，并用 `limit` 控制证据条数
   （默认 8；要更宽的召回可以到 20–30，但要注意上下文成本）。

**提问技巧**

| 目标 | 好的问法 | 为什么 |
| --- | --- | --- |
| 找入口 | 「HTTP 请求进来后第一个业务函数是谁？」 | 指向入口点与路由，能命中路由 / 入口符号 |
| 找链路 | 「A 调用 B 之后数据去了哪里？」 | 指向调用关系，命中 `calls` 与 flows |
| 找影响面 | 「改 X 的签名会影响哪些模块？」 | 指向扇入与跨模块依赖 |
| 找约定 | 「错误是怎么统一处理的？有没有中间件？」 | 指向跨文件的同类符号 |
| 找数据 | 「这个表/模型在哪些地方被读写？」 | 指向导入与调用点 |
| 找配置 | 「这个服务从哪读配置？」 | 指向配置读取与清单文件 |

| 避免的问法 | 原因 |
| --- | --- |
| 「这个项目好不好？」 | 没有可检索的落点，只能给低置信度回答 |
| 「帮我重构 X」 | `ask` 是检索与引用，不做改写；请拿到上下文后自行规划并执行 |
| 一次塞五个不相关问题 | 检索会分散命中，置信度下降；拆成多次更准 |

---

## 错误与降级行为

### 会直接报错的情况（入参非法或前置条件缺失）

只有**入参非法**或**前置产物缺失**才抛错，其余一切情况都尽量返回可用结果：

| 情况 | 行为 |
| --- | --- |
| `projectPath` 指向不存在的路径 | 报错：`项目路径不存在：<path>` |
| `projectPath` 指向文件而非目录 | 报错（路径校验失败） |
| `question` 缺失或为空字符串 | 报错（必填参数校验） |
| 参数类型错误（例如 `maxFiles: "many"`） | 报错，由工具入口的参数校验负责 |
| `report` / `ask` 在未分析的项目上调用 | 报错：`项目尚未分析：… 请先调用 project_compass_analyze` |
| `concurrency` / `maxNodes` / `limit` 超出范围 | 报错（1–64 / 5–200 / 1–50） |

参数校验集中在 `lib/tools.js`——这是全插件唯一因为入参问题抛错的地方。

### 会降级并写 `warnings` / `notes` 的情况

| 情况 | 降级方式 |
| --- | --- |
| 单个文件不可读 / 权限不足 | 跳过该文件并记入画像与 `warnings`，分析继续 |
| 文件是二进制 | 不解析，仅登记元信息 |
| 文件超过 `budget.maxFileBytes` | 跳过解析，标记 `skipped`，计入统计 |
| 触顶 `budget.maxFiles` / `maxTotalBytes` / `maxDurationMs` / `maxChunks` | 停止扩大范围，`truncated: true`，`warnings` 说明触顶项 |
| 符号链接 | 默认不跟随（避免目录环与越界）；跳过并记 warning |
| 某语言解析器抛错 | 捕获后该文件降级为轻量或跳过，文件级 `warnings` 记录原因 |
| 语言无法判定 | 按 `text` 处理，只做轻量抽取 |
| 缓存条目损坏 / JSON 解析失败 | 视为未命中，重新解析该文件；不中断分析 |
| 解析器版本变化 | 缓存整体失效并重算（缓存条目带 `parserVersion`） |
| import specifier 无法解析到文件 | 记为外部依赖或未解析，不猜测目标 |
| 调用无法绑定 | `resolution: 'unresolved'`，`toSymbolId: null`；`counts.unresolvedCalls` 可见 |
| 图中存在循环 | 正常记录，不报错、不中断 |
| 报告节点数超过 `maxNodes` | 裁剪 Mermaid 图并在报告中标注 |
| 报告渲染某段失败 | 该段降级为「数据不足」段落，**整份报告仍然产出**（渲染层不抛错） |
| 索引缺失时 `ask` | 自动构建索引；构建失败则有限检索并在 `notes` 说明 |
| 问答留痕写盘失败 | 忽略（`try/catch`），回答照常返回 |
| `llm.enabled: false` 时调用 `withLlm` | `ask` / `update` 走确定性路径；`report` 记 warning 并尝试会话默认模型 |
| 宿主没有 LLM 服务 | `available() === false`，降级为确定性输出，**不报错** |
| LLM 输出含无法核对的声明 | 该声明被丢弃，计入 `llm.droppedClaims` 与报告元信息 |
| `.project-compass/` 不存在 | `status` 正常返回「尚未分析」；`update` 做全量并在 `summary` 说明 |

设计原则：**分析失败不应该让工具失败**。缓存损坏、单个文件畸形、缺 LLM 服务，都不应阻断
「拿到一份可用的项目画像」这件事。

---

## `/compass` 命令

面向人的命令入口，一个命令 + 子命令：

| 子命令 | 对应工具 | 说明 |
| --- | --- | --- |
| `/compass analyze` | `project_compass_analyze` | 全量或增量分析 |
| `/compass report` | `project_compass_report` | 生成 6 份产物 |
| `/compass ask <问题>` | `project_compass_ask` | 带引用问答 |
| `/compass update` | `project_compass_update` | 增量更新 |
| `/compass status` | `project_compass_status` | 查看状态与下一步建议 |
| `/compass help` | — | 用法速查 |

```text
/compass status
/compass analyze
/compass report
/compass ask 登录流程经过哪些模块？
```

---

## 命令行自测通道

不需要 DSH 宿主即可自测同样的链路：

```bash
node --test
node scripts/compass-cli.mjs analyze <项目路径>
node scripts/compass-cli.mjs report  <项目路径>
node scripts/compass-cli.mjs ask     <项目路径> "登录流程经过哪些模块？"
node scripts/compass-cli.mjs status  <项目路径>
```

CLI 与工具走同一条实现路径，因此可以放心用它做回归；区别是它不经过宿主，
因此 `llm.*` 相关能力不可用（按「宿主无 LLM 服务」降级）。
