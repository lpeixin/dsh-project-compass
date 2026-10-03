# 验证与验收

> 需求文档 §0 要求「每个阶段必须有测试和验收标准」。本文件就是那份标准的落地说明：
> **每条能力对应哪个测试、用什么命令验证、验证到什么程度、哪些是已知缺口。**

---

## 1. 一条命令的回归

```bash
node --test            # 全量单元测试 + 端到端验收，必须全绿
```

无外部依赖、无构建步骤、不联网，因此在任何装了 Node ≥ 20.11 的机器上都能跑。

### 测试文件分工

| 文件 | 覆盖范围 | 特点 |
|---|---|---|
| `test/core.test.js` | 纯函数与核心算法：`util`（glob/哈希/JSON 安全/并发）、`ir`（装配、导入解析、调用绑定四级、路由绑定、幂等）、`graph`（环检测、度量、风险）、`flows`、`validate`（引用校验）、`cache`（往返/失效/剪枝）、`llm`（无宿主降级、流式汇总、预算、JSON 容错） | 全部合成数据，不碰磁盘与网络 |
| `test/parse.test.js` | 多语言解析：TS/JS/TSX/JSX、Python、Java 的符号/导入/调用/路由抽取，**行号必须能用源文件反查命中**；畸形输入不抛错 | 内联 fixture，含路由误报（`Map.get`）与内联处理器回归 |
| `test/scan.test.js` | 侦察：忽略规则三层合并与取反、结构性排除（产物目录）、语言/生态/命令/入口/测试框架识别、敏感文件只登记不读内容、TODO 与疑似密钥的行号与精度、预算截断 | 全部 `fs.mkdtemp` 临时项目，测后清理 |
| `test/rag.test.js` | 检索与问答：本地向量可重现、分块边界、BM25 命中、RRF + 重排、抽取式回答的引用可反查、**无关问题必须低置信并说明证据不足**、索引往返与增量更新、损坏索引降级 | 自造 IR；索引用临时目录 |
| `test/report.test.js` | 报告渲染：6 份产物齐全、元信息块、Mermaid 语法自检、角色路线、空数据降级，以及**两条证据纪律守卫**（聚合数字不得挂源文件当证据） | 合成 model，不落盘 |
| `test/insights.test.js` | 洞察与 LLM 叙事：确定性阅读顺序与风险汇总、事实简报长度约束、LLM 各降级路径、**验证器丢弃后的 module/claim 对齐**、阅读顺序同样过验证器 | 假 LLM 客户端，不出网 |
| `test/plugin.test.js` | 插件入口：导出形状（无 default、有 inject）、`apply` 注册与**逆序卸载**、注册失败隔离、可选服务缺失时的降级、每个工具的 schema 完整性、**工具返回值满足 output.schema 必需字段**、`/compass` 命令分支 | 假 ctx，不需要宿主 |
| `test/selfcheck.test.js` | **自扫描守卫**：用独立于解析器的逐行正则探针读出"源码里确实导出了哪些名字"，再断言解析器把它们全抽出来；另含"尾部成片丢符号"与"符号行号可反查"两条 | 探针与实现完全无关，因此两者不一致时必然是其中一方错了 |
| `test/e2e.test.js` | 端到端：在临时目录造一个含 Express 路由、跨文件调用、测试、README、`.env`、Dockerfile、CI 的真实感项目，跑 扫描 → 解析 → IR → 图 → 流程 → 报告 → 索引 → 问答 → 增量更新，并校验**产物不被下一轮分析吃进去**、工具返回值是无损 JSON、非法入参不产生半成品 | 唯一的"整机"验收 |

---

## 2. 能力 → 验收对照（FR1–FR12）

| FR | 能力 | 实现位置 | 验收方式 |
|---|---|---|---|
| FR1 | 项目扫描 | `lib/scan.js` | `test/scan.test.js` 26 条；本仓库与另一个真实仓库各跑一次 |
| FR2 | 多语言解析 | `lib/parse/*` | `test/parse.test.js`；断言"行号反查命中源文件"而非仅比对字段 |
| FR3 | 统一 IR | `lib/ir.js` | `test/core.test.js` 的 `validateIR` 自检 + 幂等断言（两次装配逐字节一致） |
| FR4 | 依赖图谱 | `lib/graph.js` | `test/core.test.js` 的环检测/扇入扇出/可达性/孤儿/风险 + `test/e2e.test.js` 跨文件边 |
| FR5 | 增量缓存 | `lib/cache.js`、`lib/analyze.js` | `test/core.test.js` 键与失效；`test/e2e.test.js` 断言"未改动时 `cacheMisses===0`、只改一个文件时 `cacheMisses===1`" |
| FR6 | LLM 摘要与验证 | `lib/llm.js`、`lib/validate.js`、`lib/insights.js` | `test/insights.test.js` 断言无效引用被丢弃、丢弃后对齐不错位；`test/core.test.js` 覆盖无宿主降级与调用上限 |
| FR7 | RAG 索引与问答 | `lib/embed.js`、`lib/chunk.js`、`lib/rag.js` | `test/rag.test.js` 20 条；`test/e2e.test.js` 断言引用指向真实文件且行号不越界、无关问题低置信 |
| FR8 | 报告生成 | `lib/report.js`、`lib/mermaid.js` | `test/report.test.js` 含 Mermaid 语法自检与产物齐全断言；`test/e2e.test.js` 断言 6 份文件真实落盘 |
| FR9 | DSH 工具注册 | `lib/tools.js`、`lib/index.js`、`lib/skill.js` | `test/plugin.test.js` 断言 6 工具 + 命令 + 技能注册、卸载逆序、`cordis.patch.yml` id 一致；**并在真实宿主中安装后由 Inspect 复核** |
| FR10 | 配置与进度 | `lib/tools.js`（`effectiveOptions`）、`lib/analyze.js`（预算/并发/`onProgress`） | 配置项由 `test/plugin.test.js` 的 schema 断言覆盖；预算截断由 `test/scan.test.js` 覆盖。**流式进度受宿主能力限制**，见 §4 |
| FR11 | 多角色报告 | `lib/report.js`（`renderRoleRoutes`） | `test/report.test.js` 断言 5 类角色都存在、无证据的角色不编造路径 |
| FR12 | 安全隐私 | `lib/scan.js`（敏感清单）、`lib/llm.js`（默认关闭） | `test/scan.test.js` 断言"把敏感文件内容里的特征串放进文件，全量序列化后该串不存在"；`test/plugin.test.js` 断言默认 `llm.used === false` |

---

## 3. 真项目验证（不是只有单测）

单测用的是合成数据，因此额外做了三轮真实运行：

1. **本仓库自检**：`node scripts/compass-cli.mjs analyze .` → 57 个文件 / 1382 符号 / 0 条路由（纯 Node 库，符合预期）、
   `warnings` 为空；`report .` 产出 6 份产物，产物目录在下一轮扫描中被正确排除。
2. **另一个真实仓库**（把 `dsh-qualityforge` 复制到临时目录后分析）：56 个文件 / 561 符号 / 6 条流程，
   无崩溃；`ask "测试项是怎么生成的"` 命中的是 `plan`、`categories`、`nextItemId` —— 语义上正确。
3. **安装进宿主并实调**：见 §5。

> **这一步抓到了两个单测漏掉的真 bug**（记在这里，因为它说明"真项目验证"不是走形式）：
> ① Express 内联箭头处理器写成 `app.post('/x', async (req) => {…})` 时，处理器体内的调用成了孤儿，
> `KEY_FLOWS.md` 的流程只有 1 步；② `lib/report.js` 里"模板字面量里嵌套模板字面量"让解析器的
> 字符串状态机误判边界，**把后续 284 行整段吞掉、公开导出 `renderReports` 完全消失**（96 个函数声明只抽到 51 个）。
> 两者都由"拿真实仓库跑一遍并核对 IR"发现，后者已固化成 `test/selfcheck.test.js` 的守卫。

复现方式：

```bash
node scripts/compass-cli.mjs scan    <项目路径>
node scripts/compass-cli.mjs analyze <项目路径>
node scripts/compass-cli.mjs report  <项目路径>
node scripts/compass-cli.mjs ask     <项目路径> "登录流程经过哪些模块？"
node scripts/compass-cli.mjs status  <项目路径>
```

---

## 4. 已知缺口（不粉饰）

| 缺口 | 实情 | 影响与缓解 |
|---|---|---|
| **非真 AST 解析** | 需求原文要求 Tree-sitter；宿主与仓库约定零外部依赖，该依赖不可用，改为自研词法/结构抽取器 | 极端语法糖（装饰器工厂、复杂泛型、宏）可能漏抽；已通过"行号反查源文件"的测试与真实仓库冒烟控制误报 |
| **流式进度** | `ToolDefinition` 无进度通道，事件表也无进度事件，**插件侧无法透出** | 工具返回耗时与预算，便于事后判断；宿主一旦提供通道，接上已有 `onProgress` 回调即可 |
| **动态调用不可见** | 反射、依赖注入、事件总线、字符串化调用无法静态绑定 | 一律记 `unresolved` 且**不猜**；报告显式给出未解析占比 |
| **路径别名未解析** | `tsconfig` 的 `paths`、webpack alias 未展开 | 跨模块边可能偏少；`docs/ROADMAP.md` 列为计划项 |
| **嵌套 `.gitignore` 未实现** | 只读项目根的 `.gitignore` | 子目录忽略规则需写进 `.compassignore` 或配置 `ignore` |
| **增量图算法** | `update` 会重算整图（纯计算，但非严格 O(变更)） | 大仓库下 `update` 的耗时主要在解析而非图 |
| **本地向量非语义模型** | 哈希词袋 + 字符三元组，无预训练权重 | 同义改写（"登录" vs "认证"）召回弱；用 BM25 词面 + 标识符拆分弥补 |

---

## 5. 宿主内验收（安装后）

两条安装路径，选一条即可：

```bash
# A. 交给宿主的插件管理器（会写入 profile 的 bundles 与 dependencies）
#    在 GUI 里让 Agent 执行 install_bundle，spec 为：
#    file:/绝对路径/dsh-project-compass

# B. 手工软链（开发期推荐：改仓库即改插件，无需重装）
ln -s "$PWD" ~/.dsh/profiles/desktop/node_modules/dsh-project-compass
# 并在 ~/.dsh/profiles/desktop/cordis.patch.yml 追加 insert 行（见 README「安装」）
```

> 注意路径 A 由 pnpm 以 **file: 依赖**安装：如果用的是硬链接式落盘，仓库文件被
> "新写 + rename" 替换后，安装副本可能仍是旧内容——改完代码后请重新安装一次确认。

### 本机实测结果（不是"应该能用"）

| 验收项 | 证据 |
|---|---|
| Loader 条目已组合 | 宿主 Config 目录里出现 `patchId: project-compass`、`name: dsh-project-compass`，`packageDir` 指向 profile 的 node_modules |
| 6 个工具对模型可见 | 宿主 Tool 目录里列出 `project_compass_scan / analyze / report / ask / update / status` 及完整参数 schema |
| 工具真的能跑 | 在 GUI 里直接调用 `project_compass_status`，返回完整结构化结果（`analyzed: true`、产物 6/6、缓存 131 条、索引 1150 块），**没有触发宿主的 INVALID_TOOL_OUTPUT**——说明 `output.schema` 与真实返回值一致 |
| 安装副本可独立工作 | 用安装目录里的 `lib/tools.js` 单独执行一次 status，结果与仓库一致 |
| 配置条目状态 | Config 目录显示 `status: absent`（本插件不声明 Config schema，与既有第三方 bundle `dsh-qualityforge` 表现一致）；配置仍通过 `cordis.patch.yml` 的 `config:` 段正常传入 |

仍需人工确认的一项（模型无法自己敲斜杠命令）：在输入框执行 `/compass help`，
应列出 `scan / analyze / report / ask / update / status / help`。
命令注册与工具注册在同一次 `apply` 中完成（已被 `test/plugin.test.js` 覆盖），
因此工具可用即可推定命令已注册。

> 上面每一条都来自宿主自带的 Inspect 能力或真实调用，不依赖"看起来好像生效了"。
