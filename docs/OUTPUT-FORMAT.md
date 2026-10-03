# 产物格式 / OUTPUT-FORMAT

本文件说明 Project Compass（项目罗盘）产出的全部文件：机器状态与人类产物分别放在哪里、
每份报告有哪些章节、证据引用怎么写、`project-compass.json` 的字段与版本策略、
以及怎么在自己的 CI 里消费它。

- [两类产物，两个目录](#两类产物两个目录)
- [完整产物清单](#完整产物清单)
- [Markdown 报告的公共约定](#markdown-报告的公共约定)
- [证据引用格式](#证据引用格式)
- [逐份报告的结构](#逐份报告的结构)
- [project-compass.json 字段表](#project-compassjson-字段表)
- [schemaVersion 策略](#schemaversion-策略)
- [在自己的 CI 里消费 JSON](#在自己的-ci-里消费-json)
- [稳定性承诺](#稳定性承诺)

---

## 两类产物，两个目录

| 类别 | 位置 | 性质 | 是否进版本库 |
| --- | --- | --- | --- |
| **机器状态** | `<项目>/.project-compass/` | 扫描快照、IR、缓存、索引、运行状态、问答留痕 | 否（默认忽略） |
| **人类产物** | `<项目>/docs/project-compass/` | 6 份报告 | **是**（供评审、diff、交接） |

分离的理由：机器状态是**可重建的派生数据**（删了只是下次慢一点），人类产物是**团队资产**
（应该跟着代码走、在 PR 里被 review）。混在一起会导致「清缓存顺手删掉了文档」或者
「文档被当成缓存反复覆盖却没人看」。

---

## 完整产物清单

### 机器状态：`.project-compass/`

```text
<项目>/.project-compass/
├── .gitignore         # 插件自动写入，内容为 `*`（见下方「自我忽略」）
├── scan.json          # project_compass_scan 的画像快照
├── ir.json            # 统一 IR（模块/文件/符号/导入/调用/路由/图谱/流程）
├── state.json         # 运行状态：上次运行时间、预算消耗、产物清单
├── index.json         # 检索索引：分块 + 向量 + 词频统计
├── qa-log.jsonl       # 问答留痕（每行一条，便于复现「当时为什么这么答」）
└── cache/
    ├── 5f/
    │   └── 5f3a9c1b2d4e6f80.json   # 单文件解析结果（按内容哈希分片存放）
    └── a1/
        └── a17c0e9b3d5f2a44.json
```

| 文件 | 写入者 | 内容 |
| --- | --- | --- |
| `scan.json` | `scan` / `analyze` | 画像（Profile）：语言、类型、生态、命令、入口、配置、测试、依赖、信号、敏感登记、缺口、忽略规则、警告 |
| `ir.json` | `analyze` / `update` | 完整 IR：`schemaVersion` / 模块 / 文件 / 符号 / 导入 / 调用 / 路由 / 图谱 / 流程 / 统计 / 警告 / 预算 |
| `state.json` | 所有会写盘的工具 | 上次运行时间与触发方式、预算消耗、产物清单（供 `status` 读取） |
| `index.json` | `analyze` / `update` / `ask`（首次需要时） | 检索索引：分块、向量、文档频率、文件哈希映射 |
| `qa-log.jsonl` | `ask` | 每次问答的问题、命中、引用与耗时 |
| `cache/*.json` | `analyze` / `update` | 单文件解析结果，键为内容哈希（16 位十六进制） |

**所有写入都是原子的**：先写同目录临时文件再 `rename`，因此中断不会留下半截 JSON。
读取一律软失败——缓存损坏会被当成「未命中」重新解析，而不是让分析失败。

#### 自我忽略：`.project-compass/.gitignore`

`scan.json` / `ir.json` / `state.json` 都会记录**项目根的绝对路径**（例如 `/Users/<你的用户名>/…`
或 `C:\Users\<你的用户名>\…`）——那是本机目录结构。为了让用户 `git add .` 时不会把自己的
文件系统布局一起提交，插件在首次写入状态目录时会放一个自我忽略文件：

```gitignore
# 由 Project Compass 自动生成：本目录是机器状态（含本机绝对路径），请勿提交。
*
```

行为约定：

- **只在缺失时写入**，绝不覆盖用户已有的 `.project-compass/.gitignore`；
- 与用户项目根的 `.gitignore` 无关：即使用户没配任何忽略规则，状态目录也不会被提交；
- 反过来，用户若**确实**想提交状态（例如做基准对比），删掉这个文件即可。

### 人类产物：`docs/project-compass/`（可配置 `outputDir`）

```text
<项目>/docs/project-compass/
├── ONBOARDING.md
├── ARCHITECTURE.md
├── MODULE_MAP.md
├── KEY_FLOWS.md
├── GETTING_STARTED.md
└── project-compass.json
```

| 文件 | 逻辑名 | 读给谁 | 一句话 |
| --- | --- | --- | --- |
| `ONBOARDING.md` | `onboarding` | 新人 / 接手者 | 按角色的阅读路线与清单 |
| `ARCHITECTURE.md` | `architecture` | 负责人 / 评审 | 分层、依赖方向、循环、风险 |
| `MODULE_MAP.md` | `moduleMap` | 开发者 | 逐模块的职责与接口 |
| `KEY_FLOWS.md` | `keyFlows` | 排障 / 改动评估 | 关键链路与时序图 |
| `GETTING_STARTED.md` | `gettingStarted` | 任何人 | 跑起来需要的全部命令 |
| `project-compass.json` | `json` | 工具 / CI | IR 摘要视图 |

渲染顺序固定为 `onboarding → architecture → moduleMap → keyFlows → gettingStarted → json`，
产物是**确定性渲染**：同一份 IR 反复渲染得到字节级相同的结果，因此可以安全地 diff 与做 CI 断言
（唯一例外是元信息块里的生成时间）。

---

## 证据引用格式

全插件统一两种引用语法：

| 形式 | 含义 | 何时用 |
| --- | --- | --- |
| `path:line` | 指向某个文件的具体行（1-based） | 指向「这里的代码」——入口、调用点、路由定义 |
| `path#symbol` | 指向符号定义位置 | 指向「这个函数/类/方法」——被引用方、被依赖方 |
| `path:line#symbol` | 行号 + 符号名同时给出 | 需要同时精确位置与语义时（推荐） |
| `path:1` | 整文件级引用 | 对「整个文件」的引用统一记为第 1 行，而不是省略行号 |

示例：

```text
src/server.ts:24                  入口文件第 24 行
src/api/orders.ts#createOrder     orders.ts 里 createOrder 的定义位置
src/api/orders.ts:88#createOrder  第 88 行，且归属符号是 createOrder
```

**在工具返回与 JSON 中**，引用是结构化的（由 `project_compass_ask` 的 `citations[]` 产出）：

```json
{ "path": "src/api/orders.ts", "line": 88, "symbol": "createOrder",
  "text": "导出函数 createOrder(...)", "score": 0.82,
  "why": "支撑结论句：与问题最相关的实现位于 src/api/orders.ts:88" }
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 项目根相对 posix 路径 |
| `line` | number | 1-based 行号 |
| `symbol` | string \| 缺失 | 符号名；不涉及符号时该字段不存在 |
| `text` | string | 命中片段摘要（截断，**不是**整段代码） |
| `score` | number | 重排后的相关度得分 |
| `why` | string | 为什么选中它（支撑了哪条结论） |

**硬性约束**：报告与问答中出现的每一个 `path` 必须存在于 IR；每一个 `line` 必须落在该文件的
`1..loc` 范围内；每一个 `symbol` 必须能在 IR 中找到。**任何不满足的声明都会被验证器丢弃**，
无法验证的推断只能以「未验证」的形式出现，不能伪装成事实。

---

## Markdown 报告的公共约定

5 份 Markdown 产物共享同一套骨架（由 `lib/report.js` 统一渲染），便于人读也便于脚本抽。

### 1. 标题与元信息块

每份报告的第一行是标题，形如 `# ONBOARDING · <项目名> 上手报告`；
紧随其后是**元信息块**（blockquote 形式，5 行）：

```markdown
# ONBOARDING · example-shop 上手报告

> **生成时间**：2026-10-02T09:12:44.108Z ｜ **项目**：`example-shop` ｜ **工具版本**：dsh-project-compass@0.1.0
> **证据口径**：所有结论均标注静态证据：`path:line` 或 `path#symbol`；整文件级引用统一记为 `path:1`（文件起始）。无证据的推断显式标注"未验证"。
> **LLM 参与**：否 —— 本报告全部结论来自静态证据，未调用 LLM
> **验证器**：丢弃 0 条无静态证据支撑的声明。
> **数据来源**：IR：模块 14 / 文件 213 / 符号 1480 / 路由 26；流程 9 条；扫描告警 0 条。
```

要点：

- 元信息块**没有 HTML 注释包裹**，就是连续的 blockquote 行；想用脚本解析，匹配以 `> **` 开头的行即可；
- `LLM 参与` 与 `验证器` 两行随运行情况变化（开启 LLM 时会写出 provider / model / 调用次数）；
- 元信息块之后是一行 `>` 引言，说明这份报告的定位。

### 2. 章节标题层级

- `#` 只出现一次（报告标题）；
- `##` 是一级章节：`ONBOARDING` / `ARCHITECTURE` / `MODULE_MAP` / `GETTING_STARTED`
  使用 `## 1.`、`## 2.` … 编号；`KEY_FLOWS` 使用非编号标题；
- `###` 是子章节（例如每个模块、每条流程各一节），不超过 `####`；
- 单个模块/流程的详情放在 `###` 下，`####` 用于细节小节；
- 数据缺失时会出现 `## 数据不足：…` 这样的章节，并在正文中说明替代做法——
  **缺数据是显式章节，不是空白**。

### 3. 证据行

每条结论后面跟着证据标注。**没有证据的推断必须显式标注「未验证」**，例如：

```markdown
- `src/queue` 疑似用于异步结算。（未验证：该模块未出现在任何从入口可达的调用链中）
```

引用格式与生成规则见上一节。

### 4. Mermaid 图

- 用围栏代码块 + `mermaid` 语言标记；
- 节点标签经安全化处理（去掉会破坏语法的字符）并截断长度；
- 节点数受 `maxNodes`（默认 40）约束，裁剪后会在图下方明确标注；
- 模块图/文件图用 `graph`，关键链路用 `sequenceDiagram`；
- `includeMermaid: false` 时，图的位置会被替换为一行说明文字，而不是留下空的代码块。

### 5. 列表与表格

- 「阅读顺序」「上手路径」用有序列表，序号即执行/阅读顺序；
- 「模块清单」「命令清单」「流程概览」用表格，列含义稳定（见各报告结构）；
- 超出展示上限时会在表格后注明「只列出前 N 个，其余见 `project-compass.json`」——
  截断永远有交代。

---

## 逐份报告的结构

实际章节标题如下（`{…}` 表示插入项目名的位置）。

### `ONBOARDING.md` —— `# ONBOARDING · {项目名} 上手报告`

| 章节 | 内容 |
| --- | --- |
| 元信息块 | 见上 |
| `## 1. 项目一句话定位` | 项目类型、技术栈、规模的一句话概括 |
| `## 2. 技术栈与规模` | 语言分布表、模块/文件/符号/行数统计 |
| `## 3. 10 分钟上手路径` | 有序的上手步骤，每步带 `path:line` |
| `## 4. 架构总览` | 模块划分与依赖方向（含 Mermaid 图） |
| `## 5. 核心模块 Top N` | 按重要度排序的核心模块表 |
| `## 6. 按角色阅读路线` | backend / 前端 / 测试 / 运维部署 / 数据 五类角色的阅读顺序与自检清单 |
| `## 7. 风险与 TODO 摘要` | 风险项（含优先级与证据）与 TODO/FIXME 分布 |
| `## 8. 下一步命令` | 建议接下来执行的命令（含 `update` / `ask` 等） |

### `ARCHITECTURE.md` —— `# ARCHITECTURE · {项目名} 架构说明`

| 章节 | 内容 |
| --- | --- |
| `## 1. 分层架构总览` | 分层图（Mermaid）+ 层次职责 |
| `## 2. 模块依赖表` | 模块 / 依赖 / 被依赖 / 扇入扇出 / 风险 |
| `## 3. 关键设计决策与约束` | 从代码结构推断出的约束（带证据；无证据的标注未验证） |
| `## 4. 循环依赖与高风险模块` | 每一组环路的成员与证据；高风险模块评分与理由 |
| `## 5. 外部依赖与运行时形态` | 外部依赖清单与运行形态（服务 / CLI / 库） |
| `## 6. 文件级依赖（前 40 个连接度最高的文件）` | 仅在有文件级数据时出现；连接度最高的文件及其依赖边 |

### `MODULE_MAP.md` —— `# MODULE_MAP · {项目名} 模块地图`

| 章节 | 内容 |
| --- | --- |
| `## 1. 模块清单` | 模块总表：id / 类型 / 文件数 / LOC / 符号数 / 风险 / 职责 |
| `## 2. 模块详情` | 每个模块一个 `###` 小节：职责、文件清单、对外接口、依赖与被依赖、入口与路由、风险理由 |
| `## 3. 未归属文件清单` | 未能归属到任何已知模块的文件（含记录的 `moduleId` 与告警），最多列 50 个 |

### `KEY_FLOWS.md` —— `# KEY_FLOWS · {项目名} 关键流程`

| 章节 | 内容 |
| --- | --- |
| `## 流程概览` | 流程总表：id / 名称 / 类型 / 入口 / 步骤数 / 置信度 |
| `## 流程 N · {名称}`（每条一节） | 入口位置、步骤表（`order` / 文件 / 行 / 符号 / 类型 / `via`）、Mermaid 时序图、证据与置信度 |
| `## 如何自行定位入口` | 当自动识别的流程不足时的手工定位步骤（每条都给出可执行的依据） |
| `## 数据不足：未识别到流程` | 没有可用入口时出现，说明原因与替代做法 |

最多渲染前 12 条流程，其余在 JSON 里。

### `GETTING_STARTED.md` —— `# GETTING_STARTED · {项目名} 环境与运行`

| 章节 | 内容 |
| --- | --- |
| `## 1. 环境要求` | 运行时版本、包管理器（来自清单文件） |
| `## 2. 安装 / 构建 / 运行 / 测试` | 命令 + 来源（如 `package.json#scripts.test`） |
| `## 3. 配置项与必需环境变量` | 配置项清单；**只列位置与键名，不输出任何疑似密钥的值** |
| `## 4. 常见任务速查表` | 任务 → 命令 |
| `## 5. 排障指南` | 常见失败与排查方向 |
| `## 6. 首次贡献清单` | 第一次贡献需要知道的检查项 |

---

## project-compass.json 字段表

这是**IR 的摘要视图**（由 `lib/report.js` 的 `buildJsonView` 产出），不是全量 IR
（全量 IR 在 `.project-compass/ir.json`）。设计目标是「CI 和其他工具够用，且体积可控」。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | number | 本报告 JSON 的格式版本，当前 `1` |
| `generatedAt` | string | ISO-8601 生成时间 |
| `tool` | object | `{ name, version }` |
| `project` | object | 见下 |
| `modules` | array | `[{ id, name, kind, loc, files, dependsOn, risk }]`——注意 `files` 是**文件数量**，不是 id 列表 |
| `files` | array | `[{ id, moduleId, language, loc, symbolCount, routeCount }]`（受 `maxFiles` 截断） |
| `symbols` | array | `[{ id, name, kind, fileId, line, exported, fanIn, fanOut }]`（按 `fanIn+fanOut` 排序，受 `maxSymbols` 截断） |
| `routes` | array | `[{ id, method, path, framework, fileId, moduleId, line, handlerName, kind }]` |
| `entrypoints` | array | `[{ path, kind, evidence }]` |
| `commands` | array | `[{ preset, argv, source }]` |
| `flows` | array | `[{ id, name, kind, entry, steps, confidence }]`——`entry` 为 `{ fileId, line, symbolId, symbolName }` |
| `graph` | object | `{ stats, hubs, cycles, riskModules }` |
| `risks` | object | `{ count, items, todos, signals, warnings, gaps }` |
| `roleRoutes` | array | 按角色的阅读路线（`renderRoleRoutes` 的产物） |
| `evidence` | object | `{ policy, sources, llm, validation, budget, warnings, notes }` |

### `project` 对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 项目名 |
| `kinds` | string[] | 项目类型：`cli` / `library` / `web-app` / `api-service` / `monorepo` / `plugin` / `data` / `docs-only` |
| `ecosystems` | array | `[{ kind, manifest, name, version }]` |
| `languages` | array | `[{ name, files, loc, bytes }]` |
| `size` | object | `{ files, sourceFiles, dirs, bytes, loc, modules, symbols, imports, calls, routes, flows, tests: { files, frameworks } }` |

### `graph` 对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `stats` | object | 三级图的节点/边数与循环数 |
| `hubs` | array | `[{ id, fanIn, fanOut }]`，最多 20 条 |
| `cycles` | array | `string[][]`，每组环路的模块 id |
| `riskModules` | array | `[{ id, score, reasons }]` |

### `risks` 对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `count` | number | 风险条目总数 |
| `items` | array | `[{ source, id?, priority, title, detail, evidence, verified? }]`；`source` 取值 `profile.gaps` / `insights.risks` / `graph.metrics.riskModules` |
| `todos` | object | `{ count, byKind, samples }`——`samples` 最多 20 条，含 `{ path, line, kind, text }` |
| `signals` | object | `{ todoCount, debugStatementCount, secretSuspects, largeFiles, generatedFiles }`；`secretSuspects` 只含 `{ path, line, kind }`，**不含值** |
| `warnings` | string[] | 降级与截断说明 |
| `gaps` | array | `[{ id, priority, title, detail, evidence }]` |

### `evidence` 对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `policy` | string | 证据口径原文 |
| `sources` | string[] | 证据来源：`ir` / `profile` / `graph` / `flows` / `insights` |
| `llm` | object | `{ used, provider, model, calls }` |
| `validation` | object | `{ droppedCount }`——被验证器丢弃的声明条数 |
| `budget` | object | 本次运行的预算消耗 |
| `warnings` | string[] | 与 `risks.warnings` 一致 |
| `notes` | string[] | 说明性备注，含「本 JSON 是摘要视图而非全量 IR」以及截断说明 |

### 最小示例

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-02T09:12:44.108Z",
  "tool": { "name": "dsh-project-compass", "version": "0.1.0" },
  "project": {
    "name": "example-shop",
    "kinds": ["api-service"],
    "languages": [{ "name": "typescript", "files": 198, "loc": 42310, "bytes": 1183744 }],
    "size": { "files": 213, "sourceFiles": 198, "modules": 14, "symbols": 1480, "routes": 26, "flows": 9 }
  },
  "modules": [
    { "id": "src/infra", "name": "infra", "kind": "source", "loc": 3120, "files": 11,
      "dependsOn": ["src/api", "src/domain"], "risk": "high" }
  ],
  "graph": { "hubs": [{ "id": "src/infra", "fanIn": 11, "fanOut": 2 }],
             "cycles": [["src/api", "src/domain", "src/infra"]],
             "riskModules": [{ "id": "src/infra", "score": 72, "reasons": ["fanIn=11", "位于循环依赖中"] }] },
  "risks": { "count": 3, "signals": { "todoCount": 17 } },
  "evidence": { "policy": "…", "validation": { "droppedCount": 0 }, "warnings": [] }
}
```

> 上例是**示意**，用于说明字段形状；数字与真实项目无关。

---

## schemaVersion 策略

有两个版本号，含义必须分清：

| 版本号 | 位置 | 含义 |
| --- | --- | --- |
| `schemaVersion`（报告 JSON） | `docs/project-compass/project-compass.json` | **本文档所描述的报告格式版本** |
| `irSchemaVersion` / IR 的 `schemaVersion` | `.project-compass/ir.json` | 内部 IR 结构版本（契约版本） |
| 工具版本 | `tool.version` | 插件自身的 semver（`package.json` 的 `version`） |

**规则**

1. 初始版本都是 `1`，与 `docs/INTERNAL-CONTRACTS.md` 的契约版本对齐；
2. **向后不兼容的字段变更**（删字段、改字段语义、改类型、改枚举取值）→ 主版本 +1；
   消费方遇到不认识的 `schemaVersion` 应当**快速失败**，而不是猜着解析；
3. **向后兼容的增量**（新增可选字段、新增枚举取值）→ 版本号不变，消费方必须容忍未知字段；
4. 每个产物的元信息块都会写出生成它时的版本，便于排查「用新工具读了旧报告」；
5. 旧版本 IR 遇到新版本工具时，工具走**兼容读取**并在 `warnings` 中说明降级；
   IR 无法兼容读取时按「未分析」处理（重新分析即可），不会静默给出错误的报告。

**给消费方的代码建议**

```js
const report = JSON.parse(await readFile('docs/project-compass/project-compass.json', 'utf8'))
if (report.schemaVersion !== 1) {
  throw new Error(`unsupported project-compass schemaVersion: ${report.schemaVersion}`)
}
```

---

## 在自己的 CI 里消费 JSON

典型用途：**在 PR 里守住架构约束**——循环依赖不许新增、高风险模块不许变多、
新文件必须归属某个模块。

### 例 1：循环依赖不得新增

```bash
node -e "
const fs = require('node:fs');
const r = JSON.parse(fs.readFileSync('docs/project-compass/project-compass.json', 'utf8'));
if (r.schemaVersion !== 1) throw new Error('unsupported schemaVersion: ' + r.schemaVersion);
const cycles = r.graph?.cycles ?? [];
if (cycles.length > 0) {
  for (const c of cycles) console.error('cycle:', c.join(' -> '));
  process.exit(1);
}
console.log('no module cycles');
"
```

### 例 2：高风险模块白名单

只允许已知的几个高风险模块存在，其余视为回归：

```bash
node -e "
const fs = require('node:fs');
const r = JSON.parse(fs.readFileSync('docs/project-compass/project-compass.json', 'utf8'));
const allow = new Set(['src/infra']);
const bad = (r.graph?.riskModules ?? []).map(m => m.id).filter(id => !allow.has(id));
if (bad.length > 0) { console.error('unexpected high-risk modules:', bad.join(', ')); process.exit(1); }
console.log('high-risk modules within allowance');
"
```

### 例 3：分析没有触顶（结果可信）

被截断的分析不能当门禁依据：

```bash
node -e "
const fs = require('node:fs');
const r = JSON.parse(fs.readFileSync('docs/project-compass/project-compass.json', 'utf8'));
const budget = r.evidence?.budget ?? {};
const warnings = r.evidence?.warnings ?? [];
if (budget.truncated || warnings.some((w) => /截断|触顶/.test(w))) {
  console.error('analysis was truncated; raise budget or narrow scope');
  console.error(warnings.join('\n'));
  process.exit(1);
}
console.log('analysis complete:', r.project?.size?.files, 'files /', r.project?.size?.symbols, 'symbols');
"
```

### 例 4：确认敏感文件没有内容泄漏

```bash
node -e "
const fs = require('node:fs');
const r = JSON.parse(fs.readFileSync('docs/project-compass/project-compass.json', 'utf8'));
const suspects = r.risks?.signals?.secretSuspects ?? [];
const leaked = suspects.filter((s) => Object.keys(s).some((k) => k !== 'path' && k !== 'line' && k !== 'kind'));
if (leaked.length > 0) { console.error('secret suspects must only carry path+line+kind'); process.exit(1); }
console.log('secret suspects carry location+kind only:', suspects.length);
"
```

### CI 里的典型顺序

```yaml
- run: node scripts/compass-cli.mjs analyze .
- run: node scripts/compass-cli.mjs report .
- run: node -e "…上面的门禁断言…"
- uses: actions/upload-artifact@v4
  with:
    name: project-compass-docs
    path: docs/project-compass/
```

因为渲染是确定性的，你甚至可以把 `docs/project-compass/` 提交进仓库，
然后在 CI 里重新生成并 `git diff --exit-code` —— 有 diff 就说明「代码结构变了但文档没更新」。

---

## 稳定性承诺

| 对象 | 承诺 |
| --- | --- |
| 报告文件名与目录 | 稳定；不会在不改 `schemaVersion` 的情况下改名 |
| `project-compass.json` 的字段 | 遵循 [schemaVersion 策略](#schemaversion-策略)：破坏性变更升版本 |
| 证据引用语法 | `path:line` / `path#symbol` 是稳定契约 |
| Mermaid 图的具体形状 | **不承诺**。节点顺序、分组与裁剪可能随版本变化，请勿对其做正则断言 |
| Markdown 的措辞 | **不承诺**。请依赖标题行与元信息块中以 `> **` 开头的行、以及 `##` 章节编号，而不是整句文案 |
| 确定性 | 同输入同版本 → 同样字节（生成时间除外） |
