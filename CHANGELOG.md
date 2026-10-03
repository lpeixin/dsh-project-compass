# 变更记录

本文件记录 Project Compass（项目罗盘）的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- **路径别名解析**：读 `tsconfig.json` / `jsconfig.json` 的 `paths`、webpack / vite alias，
  把别名映射到真实路径，减少跨模块依赖图里的 `unresolved`。
- **增量图与增量索引**：只重算受影响子图的扇入扇出、可达性与环检测，只重建变化文件的分块与向量。
- **`ask` 多轮上下文**：允许把上一轮的引用作为本轮检索的偏置。
- **忽略规则调试**：输出「某个路径为什么被忽略 / 为什么没被忽略」的逐步说明。
- **报告章节可配置**：通过配置选择章节集合与顺序。
- **报告国际化**：`locale: 'en'` 输出英文报告（标识符与 JSON 已语言中立）。
- **项目级配置**：把配置随仓库走，团队共享同一套忽略规则与预算。

详见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## [0.1.0] - 2026-10-02

首个版本。目标是打通主干：**从一个路径出发，得到可验证、可 diff、可交接的项目理解产物**。

按需求文档的 FR1–FR12 逐条对照（详见 [README 的能力矩阵](README.md#能力矩阵)）：
**FR1、FR3、FR4、FR6、FR7、FR8、FR9、FR11、FR12 完全实现；FR2 实现方式与原文不同
（零依赖自研抽取，未使用 Tree-sitter）；FR5 缓存粒度为「单文件解析结果」；
FR10 部分实现（配置 / 预算 / 并发 / 忽略规则已完成，进度流式透出未完成）。**

### 新增

**工具（6 个，模型可见）**

- `project_compass_scan`——项目侦察：目录扫描、忽略规则、语言 / 框架 / 入口 / 配置识别、
  敏感文件登记（只记路径，不读内容）、风险信号与工程缺口。
- `project_compass_analyze`——扫描 + 多语言解析 + 统一 IR + 模块 / 文件 / 符号三级依赖图谱；
  支持内容哈希增量、并发与预算控制。
- `project_compass_report`——生成 6 份产物到 `docs/project-compass/`：`ONBOARDING.md`、
  `ARCHITECTURE.md`、`MODULE_MAP.md`、`KEY_FLOWS.md`、`GETTING_STARTED.md`、
  `project-compass.json`；含 Mermaid 图、按角色（backend / frontend / test / devops / data）
  的阅读路线与证据引用。
- `project_compass_ask`——项目级带引用问答：本地 BM25 + 确定性向量混合检索 → RRF 融合 → 重排；
  默认抽取式回答，返回 `citations`（`path:line` + 符号 + 依据）与置信度，不联网。
- `project_compass_update`——增量更新：只重算变更文件，刷新 IR、索引与报告。
- `project_compass_status`——当前状态：是否已分析、产物路径、缓存规模、上次预算消耗与下一步建议。

**命令**

- `/compass`——子命令 `analyze`、`report`、`ask <问题>`、`update`、`status`、`help`。

**解析（FR2，实现方式说明）**

- 深度解析：TypeScript / JavaScript / TSX / JSX（函数、箭头函数、类、方法、接口、类型、枚举、
  常量、import / export / require / 动态 `import()`、调用、Express / Koa / Fastify / NestJS 路由、
  React 组件）、Python（`def` / `async def` / `class`、`import` / `from ... import`、
  Flask / FastAPI / Django 装饰器路由、调用、`__all__`）、Java（类 / 接口 / 枚举 / 注解类型 / 记录、
  方法含构造器、`package` / `import`、Spring 注解路由、方法调用）。
- 轻量抽取：Go / Rust / C / C++ / C# / Ruby / PHP / Kotlin / Scala / Swift / Shell / SQL / Vue /
  Svelte / HTML / CSS / YAML / JSON / Markdown 等，输出与深度解析同构。
- 定位基于行扫描 + 括号 / 缩进配平，统一 1-based 行号；宁可少报，不错报。
- **与需求原文的偏差**：需求原文要求用 Tree-sitter 做 AST 解析；本插件受「零外部依赖」硬约束
  （只允许 `node:*` 内置模块，宿主与仓库均无该依赖可用），改为自研的零依赖词法 / 结构抽取器。
  语言范围不变（TS/JS/TSX/JSX、Python、Java 深度解析，其余语言轻量抽取），
  但拿不到真正的语法树——因此无法做类型推断与重载解析。可选的真 AST / tree-sitter 后端见
  [docs/ROADMAP.md](docs/ROADMAP.md)。

**统一 IR 与图谱**

- `schemaVersion` 化的单文件 IR：模块 / 文件 / 符号 / 导入 / 调用 / 路由 + 统计 + 警告 + 预算。
- 调用绑定只有四种结论（`same-file` / `import` / `global` / `unresolved`），且必须记录
  `resolution`，不做无依据的猜测。
- 模块 / 文件 / 符号三级依赖图：扇入扇出、枢纽、孤儿、从入口可达性、循环依赖、风险评分。
- 关键链路抽取：从 HTTP 路由 / CLI / 事件入口出发，逐步步骤 + 证据 + 置信度 + Mermaid 时序图。

**检索与问答（FR7）**

- 本地确定性向量（哈希词向量 + 字符三元组，L2 归一化）：无模型文件、无网络、可复现。
- BM25 + 向量余弦 → RRF 融合 → 重排（符号名精确 / 前缀命中、路径命中、kind 权重）。
- 默认抽取式回答：直接引用命中片段并给出来源，不生成没有出处的句子。

**LLM 摘要与验证（FR6，可选、默认关闭）**

- `llm.enabled: false` 为默认值；关闭时任何 `withLlm` 都被忽略，全部走确定性路径。
- 开启后提供叙述性文字增强，并为 LLM 输出建立验证器：路径必须存在于 IR、行号必须落在该文件的
  `1..loc` 范围内、符号必须能在 IR 中找到；**验证不通过的声明一律丢弃并计数**，报告中写明丢弃条数。
- 宿主缺少 LLM 服务时降级为确定性输出，不报错。

**增量缓存与预算（FR5 / FR10）**

- 按文件内容哈希建立解析缓存；未变化文件直接复用，`update` 只重算变更文件。
- **缓存粒度**：`.project-compass/cache/` 落盘的是单文件解析结果；IR 与依赖图由缓存结果
  在内存中重算（纯计算、毫秒级，故不单独落盘），检索索引支持按变更文件增量更新。
- 预算项：`maxFiles`、`maxFileBytes`、`maxTotalBytes`、`maxDurationMs`、`maxChunks`；
  触顶时截断并明确打标（`truncated`、`budget.filesSkipped`、`warnings`），绝不静默。

**命令与配置（FR9 / FR10）**

- profile 内的 `config` 段：`outputDir`、`concurrency`、`budget.*`、`ignore`、`include`、
  `sensitive.extraPatterns`、`llm.*`、`contextInjection`。
- 忽略规则：内置默认规则 + `.gitignore` + `.compassignore` + 配置 `ignore` / `include`，
  语法贴近 `.gitignore`（`**`、`*`、`?`、`{a,b}`、`!` 取反、锚定语义）。
- 敏感文件：默认清单覆盖 `.env` 系列、私钥、凭据、keystore、云配置、terraform state 等；
  命中只 `stat` 登记路径与类型。

**工程**

- 零外部依赖：只使用 `node:*` 内置模块，无 npm 依赖、无构建步骤、无安装脚本。
- 纯 ESM，无 default export；插件入口只导出 `name` / `inject` / `apply`。
- 容错优先：解析器、检索器与报告渲染器对畸形输入不抛错，降级并写 `warnings`；
  只有工具入参非法才抛错。
- 原子写 + 软失败读：中断不会留下半截 JSON，缓存损坏按未命中处理。
- 状态目录（`.project-compass/`）与人类产物目录（`docs/project-compass/`）刻意分离。
- 测试基于 `node:test` + `node:assert/strict`，不联网、不依赖 DSH 宿主。
- 非 DSH 环境的自测通道：`scripts/compass-cli.mjs`。

**文档**

- `README.md`（中文全文）、`README.zh-CN.md`（英文摘要入口）、`docs/TOOLS.md`（工具参考）、
  `docs/CONFIG.md`（配置参考）、`docs/OUTPUT-FORMAT.md`（产物格式）、
  `docs/ARCHITECTURE.md`（插件自身架构）、`docs/ROADMAP.md`（路线图与已知限制）、
  `CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`。
- CI：Node 20 / 22 矩阵，执行 `node --test`。

### 安全

- 敏感路径只做 `stat`，内容永不进入内存、缓存、索引或报告——该边界不可通过配置绕过。
- 插件自身不发起任何网络请求；LLM 能力默认关闭，且开启后输出必经验证器。
- 写入只发生在目标项目的 `.project-compass/` 与 `docs/project-compass/`，不改动业务代码。

[Unreleased]: https://github.com/lpeixin/dsh-project-compass/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lpeixin/dsh-project-compass/releases/tag/v0.1.0
