# 配置参考 / CONFIG

Project Compass（项目罗盘）的全部配置都在 profile 的 `cordis.patch.yml` 里，按插件 id `project-compass` 寻址。

> 本文给出的是**默认值**与**边界语义**——也就是配置面与默认策略的约定。
> 实现必须对齐这里；如果你的运行结果与本文不符，请按代码为准并把差异当作文档缺陷上报。

- [配置写在哪里](#配置写在哪里)
- [完整配置示例](#完整配置示例)
- [逐项详解](#逐项详解)
  - [outputDir](#outputdir)
  - [concurrency](#concurrency)
  - [budget](#budget)
  - [ignore / include](#ignore--include)
  - [sensitive](#sensitive)
  - [llm](#llm)
  - [contextInjection](#contextinjection)
- [忽略规则的匹配语义](#忽略规则的匹配语义)
- [敏感文件默认清单](#敏感文件默认清单)
- [性能与预算调优](#性能与预算调优)
- [LLM 开关与隐私](#llm-开关与隐私)
- [配置生效与排错](#配置生效与排错)

---

## 配置写在哪里

配置属于 **profile**，不属于项目：

```text
~/.dsh/profiles/<profile>/cordis.patch.yml
```

```yaml
- id: project-compass
  name: dsh-project-compass
  config:
    outputDir: docs/project-compass
    concurrency: 8
```

要点：

- `id` 必须是 `project-compass`（这是 bundle 插入时使用的稳定 id，改名会影响寻址）；
- `name` 必须是 `'dsh-project-compass'`（包名），否则加载不到模块；
- **`config` 段是覆盖式配置**：写进去的键覆盖默认值，没写的键保持默认；
- 改完配置后需要**重启或重载 DSH** 才生效；
- 想临时关掉整个插件：`- id: project-compass` + `disabled: true`。

---

## 完整配置示例

下面这份等于「所有键都写出来、值与默认一致」，可以直接当模板：

```yaml
- id: project-compass
  name: dsh-project-compass
  config:
    outputDir: docs/project-compass   # 报告输出目录（相对项目根）
    concurrency: 8                    # 解析并发
    budget:
      maxFiles: 20000                 # 最多分析多少个文件
      maxFileBytes: 262144            # 单文件上限（256 KiB）
      maxTotalBytes: 67108864         # 总读取上限（64 MiB）
      maxDurationMs: 600000           # 单次分析时间上限（10 分钟）
      maxChunks: 20000                # 检索索引最多多少个分块
    ignore: []                        # 追加忽略规则（.gitignore 语法）
    include: []                       # 强制包含
    sensitive:
      extraPatterns: []               # 追加敏感文件模式
    llm:
      enabled: false                  # 默认关闭：不调用任何 LLM
      provider: null                  # 省略则用会话默认模型
      model: null
      maxCalls: 12                    # 单次运行最多调用多少次 LLM
      maxTokens: 1200                 # 单次调用的输出上限
    contextInjection: false           # 是否向 Agent 系统提示注入项目简报
```

---

## 逐项详解

### outputDir

| | |
| --- | --- |
| 类型 | string |
| 默认 | `docs/project-compass` |
| 生效范围 | `project_compass_report` 的输出目录 |

人类产物的落盘位置，相对**被分析项目的根目录**（也接受绝对路径）。

- 之所以默认放在 `docs/project-compass/` 而不是隐藏目录：这 6 份产物是**给人看的**，
  应该能进版本库、能在 PR 里评审、能 diff。机器状态则相反，放在 `.project-compass/`（见下）。
- **`.project-compass/` 与 `outputDir` 是两套目录，互不影响**：删掉前者只是丢缓存（下次重算），
  删掉后者只是丢报告（重新 `report` 即可）。
- 边界情况：
  - 空字符串或纯空白 → 回退到默认值；
  - 相对路径按项目根解析，绝对路径原样使用；
  - 目录不存在时自动创建（含中间目录）；
  - **写成 `.project-compass` 之类的机器状态目录不会报错，但会让「可重建状态」与「评审产物」混在一起，不建议**；
  - Windows 上写路径请统一用正斜杠或双反斜杠（YAML 语义）。

### concurrency

| | |
| --- | --- |
| 类型 | number（整数） |
| 默认 | `8` |
| 生效范围 | `analyze` / `update` 的解析并发 |

同时解析的文件数上限。解析是「读文件 + 纯计算」的混合负载：

| 场景 | 建议 |
| --- | --- |
| SSD + 中等仓库（几千文件） | 保持 `8`，通常已经打满 IO |
| 大仓库、多核机器（数万文件） | 可以试 `16`；再往上收益很小，因为解析本身是单线程 JS |
| 机械硬盘 / 网络盘（NFS、SMB） | 降到 `2`–`4`，过高并发在机械盘上反而更慢 |
| 内存吃紧 / 单文件特别大 | 降到 `4` 或更低，减少同时在内存里的文件内容 |

边界情况：小于 1 或非整数的值会被规整为至少 1；并发只影响**速度**，不影响结果内容
（产物是确定性的，与并发度无关）。

### budget

四个「尺度上限」加一个「分块上限」。触顶不会失败，只会截断并打标。

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `maxFiles` | number | `20000` | 单次分析最多纳入多少个文件（按排序后顺序取前 N） |
| `maxFileBytes` | number | `262144`（256 KiB） | 单个文件超过这个字节数就不解析，只登记元信息 |
| `maxTotalBytes` | number | `67108864`（64 MiB） | 单次分析累计读取的上限 |
| `maxDurationMs` | number | `600000`（10 分钟） | 单次分析的时间上限 |
| `maxChunks` | number | `20000` | 检索索引最多保留多少个分块 |

**触顶后的行为**（三者一致）：

1. 立即停止继续扩大范围，已完成的部分**照常产出**；
2. 返回与 IR 中 `truncated: true`；
3. `budget.filesSkipped` 给出被跳过的文件数；
4. `warnings` 里明确写出触顶的是哪一项、阈值多少。

**为什么要有这四个键**：给一个路径就扫全盘是不可接受的。任何一个真实仓库里都可能有
`node_modules`、构建产物、压缩包、几十 MB 的生成代码——预算让「分析一个陌生项目」这件事
有确定的上界，而不是让一次调用把内存和耐心用完。

边界情况：

- `maxFileBytes` 必须小于等于 `maxTotalBytes`，否则后者先触顶；
- `maxDurationMs` 是人能等待的上限，不是精度承诺：检查发生在文件边界，因此可能略超；
- `maxFiles` 影响的是**纳入范围**，被忽略规则排除的文件不占用这个额度。

### ignore / include

| | |
| --- | --- |
| 类型 | string[]（`.gitignore` 语法） |
| 默认 | `[]`（只用内置默认规则 + 项目自身的忽略文件） |
| 生效范围 | `scan` / `analyze` / `update` |

- `ignore`：**追加**排除规则（不会覆盖内置默认规则，也不能取消默认规则）；
- `include`：**强制包含**，优先级高于所有忽略规则——用于「这个目录通常会被忽略，但我要它」。

```yaml
config:
  ignore:
    - '**/*.min.js'          # 压缩产物不解析
    - 'fixtures/**'           # 测试夹具
    - '!fixtures/important'   # 但这一条要（后出现的规则优先）
  include:
    - 'vendor/my-fork/**'     # 通常被忽略，这里强制纳入
```

规则来源与优先级（从低到高）：

1. **内置默认规则**（见 [忽略规则的匹配语义](#忽略规则的匹配语义)）；
2. 项目根与各级目录的 `.gitignore`；
3. 项目根 `.compassignore`（本插件专用，语法相同）；
4. 配置里的 `ignore`；
5. 配置里的 `include`（最高，强制纳入）。

### sensitive

| | |
| --- | --- |
| 类型 | object |
| 默认 | `{ extraPatterns: [] }`（默认清单始终生效，见 [敏感文件默认清单](#敏感文件默认清单)） |
| 生效范围 | `scan` / `analyze`（写入画像的 `sensitive[]`） |

```yaml
config:
  sensitive:
    extraPatterns:
      - 'config/secrets/**'
      - '**/*.p12'
      - 'internal/keys/*'
```

- `extraPatterns` 是**追加**到默认敏感清单之上的模式（不替换默认清单），命中的条目标 `kind: custom`；
- 命中敏感模式的路径会被**登记**（记入 `scan.json` 的 `sensitive[]`，含 `path` / `kind` / `reason`），
  但**内容永不读取**——只做 `stat` 取元信息；
- 敏感路径的内容不会进入解析结果、缓存、索引与报告；
- 边界情况：
  - 敏感与 `include` 冲突时，**敏感优先**（隐私边界不允许被配置绕过）；
  - 你自己的项目里如果有「路径名字很像密钥但不是」的文件，它仍然只会被登记而不会被读——这是有意的保守取舍。

### llm

| | |
| --- | --- |
| 类型 | object |
| 默认 | `{ enabled: false, provider: null, model: null, maxCalls: 12, maxTokens: 1200 }` |
| 生效范围 | `report` / `ask` / `update`（且必须调用方显式传 `withLlm: true`） |

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | **总开关**。`false` 时 `ask` / `update` 忽略 `withLlm` 走确定性路径；`report` 会记一条 warning 后尝试使用会话默认模型 |
| `provider` | string \| null | `null` | LLM 提供方；`null` 表示用会话默认模型 |
| `model` | string \| null | `null` | 模型名；`null` 表示用会话默认模型 |
| `maxCalls` | number | `12` | 单次运行最多调用多少次 LLM（硬上限，超出即停止并降级） |
| `maxTokens` | number | `1200` | 单次调用的输出 token 上限 |

> `analyze` 不接受 `withLlm`：解析与建图阶段不调用 LLM。

解析顺序：`config.provider` + `config.model`（两者都给才视为显式路由）→ 会话默认模型
（`agentDefaultModel.currentSelection()`）→ 不可用（降级为确定性输出，不报错）。

**`enabled: false` 的准确含义**：

- 不调用 LLM，也不把任何代码片段发出去；
- 报告照常生成，只是没有「叙述性文字」那部分——事实、图、引用、路线全部来自确定性算法；
- 检索问答默认就是抽取式的，本来不需要 LLM。

### contextInjection

| | |
| --- | --- |
| 类型 | boolean |
| 默认 | `false` |
| 生效范围 | 会话级行为 |

`true` 时，注册一个运行时上下文提供者：把**当前会话项目的三行简报**注入每一步的提示，
让 Agent 不必反复调用工具就知道项目规模与报告位置。

注入内容形如：

```text
[项目罗盘] 当前项目已分析：example-shop
规模：213 文件 / 42310 行 / 1480 符号 / 26 路由 / 14 模块
报告：docs/project-compass/（从 ONBOARDING.md 起读）；需要具体证据时调用 project_compass_ask。
```

- **按会话生效**：只有在该会话里跑过分析（工具层已记住项目根）之后才会注入；换项目要重新分析；
- **只读已落盘的小文件**（`ir.json` 的统计字段），不在上下文回调里做任何分析——回调必须是同步的；
- 这是便利性开关，**不是隐私开关**：注入的是规模摘要与路径，不含敏感文件内容；
- 代价是每轮对话都多三行提示词。项目大、会话长时建议保持 `false`，
  需要上下文时显式 `ask` 或读报告——按需取用比常驻注入更省上下文；
- 宿主没有 `systemPrompt` 服务、或从未分析过项目时，该开关没有任何效果（静默跳过）。

---

## 忽略规则的匹配语义

本插件的忽略匹配**贴近 `.gitignore`，但由自己实现**（零依赖，见 `lib/util.js` 的 glob 编译器）。

**支持的语法**

| 写法 | 含义 |
| --- | --- |
| `name` | 匹配任意层级的 `name`（文件或目录）**及其内容** |
| `dir/` | 匹配该目录及其内容（末尾斜杠表示目录） |
| `*.log` | 段内通配：匹配任意层级的 `*.log` |
| `**` | 跨目录匹配（`**/x` 命中任意深度） |
| `src/*.js` | **含斜杠 → 锚定到项目根**，只匹配 `src/` 下一层 |
| `?` | 匹配单个非斜杠字符 |
| `{a,b}` | 花括号展开，匹配 `a` 或 `b` |
| `!pattern` | 取反：重新纳入（**后出现者优先**） |
| `#comment` | 注释行，忽略 |
| 空行 | 忽略 |

**关键语义（与 `.gitignore` 对齐的部分）**

1. **不含斜杠的模式匹配任意层级，且同时命中「该名字的文件/目录」与「它下面的所有内容」。**
   `dist` 会命中 `dist/`、`packages/a/dist/`，以及 `dist/**`。
2. **含斜杠的模式锚定到项目根。** `src/*.js` 不会命中 `packages/a/src/x.js`。
   想只命中根目录的某个名字，写成 `/build` 这类形态。
3. **最后命中的规则决定结果。** `!` 取反不是「全局例外」，而是「在这一条上翻转为不忽略」；
   如果后面还有一条更靠后的规则命中它，仍会被忽略。因此取反规则要写在取反对象的后面。
4. **匹配对象是相对项目根的 posix 路径**（如 `src/api/orders.ts`），与平台无关。
5. **`include` 的优先级高于所有忽略规则**——命中 `include` 的路径会被强制分析；
   但**敏感文件仍然不读内容**（见下）。

**规则来源与优先级（从低到高）**

1. 内置默认规则；
2. 各级 `.gitignore`；
3. 项目根 `.compassignore`（本插件专用，语法相同）；
4. 配置里的 `ignore`（追加）；
5. 单次调用传入的 `ignore` / `include` 参数（追加）；
6. 配置与参数里的 `include`（最高，强制纳入）。

**内置默认规则**（`lib/scan.js` 的 `defaultIgnoreRules()`，总是生效，不能被配置取消）：

```text
# 依赖与包管理器产物
node_modules
bower_components
.pnpm-store
.yarn

# 版本控制
.git
.hg
.svn

# 构建与产物
dist
build
out
target
coverage
.nyc_output
.next
.nuxt
.svelte-kit
.turbo
.cache
.parcel-cache
.angular
.dart_tool
DerivedData
Pods

# 语言生态缓存与 IDE
.venv
venv
__pycache__
.pytest_cache
.mypy_cache
.ruff_cache
.tox
.gradle
.idea
.vscode
.terraform
.serverless
.fusebox
.dynamodb
.sass-cache

# 第三方代码
vendor

# 杂项
.DS_Store
.eslintcache

# 本工具自身状态目录
.project-compass

# 压缩 / 映射产物
*.min.js
*.min.css
*.map

# 锁文件与日志
*.lock
package-lock.json
pnpm-lock.yaml
yarn.lock
*.log
*.snap
```

> **锁文件被忽略 ≠ 依赖信息丢失**：`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` 等不进语言统计，
> 但它们的**存在性**会被记录，用于工程缺口判定（例如「有 package.json 却没有锁文件」）；
> 而 `package.json` / `pyproject.toml` 这类清单文件的 `dependencies` 仍会进入画像。
> 二进制与压缩产物（图片、字体、归档、`*.min.js`）不参与源码解析，只登记元信息。

**调试忽略规则**：`project_compass_scan` 返回的画像里含 `ignore: { rules, sources }`，
可以直接看到最终生效的规则列表以及每条规则的来源。

---

## 敏感文件默认清单

下面这份清单来自 `lib/scan.js` 的 `SENSITIVE_RULES`。命中者**只 `stat` 登记、绝不读取内容**
（连前 8KB 的二进制样本都不读）。清单按「文件名模式 + 目录模式」组织：

```text
.env*                    kind=env                 环境变量文件，可能包含口令与令牌
*.pem                    kind=certificate         PEM 证书 / 私钥
*.key                    kind=private-key         私钥文件
id_rsa* / id_dsa* /      kind=ssh-key             SSH 私钥
id_ecdsa* / id_ed25519*
credentials*             kind=credentials         凭据文件
credentials.json         kind=credentials         云凭据文件
secrets*                 kind=secrets             密钥清单文件
.npmrc                   kind=registry-token      npm registry 令牌
.pypirc                  kind=registry-token      PyPI 上传令牌
.netrc                   kind=credentials         netrc 凭据
.git-credentials         kind=credentials         git 明文凭据
.htpasswd                kind=credentials         HTTP 基本认证口令
*.p12 / *.pfx            kind=keystore            PKCS#12 密钥库
*.jks / *.keystore       kind=keystore            Java 密钥库
.aws/**                  kind=cloud-credentials   AWS 凭据目录
.ssh/**                  kind=ssh-config          SSH 配置与私钥目录
.docker/config.json      kind=docker-credentials  Docker registry 凭据
serviceAccount*.json     kind=service-account     GCP 服务账号密钥
service-account*.json    kind=service-account     GCP 服务账号密钥
kubeconfig / *.kubeconfig kind=kubeconfig         Kubernetes 集群凭据
*.tfstate                kind=terraform-state     Terraform state（常含明文密钥）
terraform.tfstate*       kind=terraform-state     Terraform state
```

**规则细节**

- 匹配对象是路径的 basename 与目录段（如 `.aws/**`、`.ssh/**`），带目录模式；
- `.env.example` / `.env.sample` / `.env.template` / `.env.dist` 这类**模板文件仍归入敏感**
  （绝不读取内容），但 kind 标为 `env-template`，且**不会**触发「疑似密钥入库」的 P0 风险缺口——
  因为模板文件本就该进版本库；
- 命中后只记录三样东西：`path`、`kind`、`reason`（为什么判定为敏感）；
- `scan.json` 的 `signals.secretSuspects` 记录的是**位置与疑似类型**（`{ path, line, kind }`），
  **绝不包含值**；
- 命中敏感的文件会计入 `size.files`（表示「被访问到」），但**不计入** `size.skipped`，
  且不参与语言统计（`loc` 记 0）；
- 想追加自己的模式用 `sensitive.extraPatterns`（kind 标为 `custom`）；默认清单**不能用配置取消**——
  如果你确实需要分析某个被误判的文件，请重命名它，而不是尝试绕过隐私边界。

---

## 性能与预算调优

### 一般仓库（几千文件）

默认配置就够了。典型耗时在秒到十几秒量级，主要成本是读文件与解析。

```yaml
config:
  concurrency: 8
```

### 大仓库（数万文件）

**先问一句：真的需要全量吗？** 多数情况下 `update` 或缩小范围更划算。

必须全量时的建议：

```yaml
config:
  concurrency: 16
  budget:
    maxFiles: 50000
    maxTotalBytes: 268435456   # 256 MiB
    maxDurationMs: 1800000     # 30 分钟
    maxChunks: 60000
```

- 用 `ignore` 把生成代码、第三方 vendored 代码、测试快照排掉，收益通常最大；
- 如果只关心某个子目录，最有效的手段是**把 `projectPath` 指向那个子目录**，
  而不是把预算调大——子目录本身就是一个合法项目根；
- 触顶后先看 `warnings` 与 `budget.filesSkipped`：如果跳过的是无关文件，不必调预算。

### monorepo

monorepo 的关键是「不要把所有包当成一个平铺目录」：

1. **逐包分析**：对每个 workspace 包分别跑 `analyze`（`projectPath` 指向包目录），
   包内依赖图更准，报告也更可读；
2. **根目录分析**：在仓库根跑一次，拿到跨包的模块级依赖图与整体画像；
3. **忽略不需要的包**：

   ```yaml
   config:
     ignore:
       - 'packages/legacy-*/**'
       - 'examples/**'
       - 'e2e/**'
   ```

4. **包名前缀差异不要靠猜测**：本插件不做 `tsconfig paths` / 别名解析的猜测，
   import 解析不到就记 `resolved: false`，因此别名较多的 monorepo 里跨包边可能偏少——
   这是「宁可少报不可错报」的取舍，见 [ROADMAP.md](ROADMAP.md)。

### 时间与规模的经验值

| 仓库规模 | 默认配置下的典型表现 | 建议 |
| --- | --- | --- |
| < 1 千文件 | 秒级 | 无需调整 |
| 1 千 – 1 万文件 | 数秒到数十秒 | 保持默认；必要时 `concurrency: 16` |
| 1 万 – 5 万文件 | 分钟级 | 用 `ignore` 收缩范围；提高预算；考虑分目录分析 |
| > 5 万文件 | 容易触顶 | **不要全量**：按子目录/包分别分析，或指向关注的子树 |

### 缓存与磁盘

- 缓存位于 `<项目>/.project-compass/cache/`，按哈希前两位分片，避免单目录堆积数万小文件；
- 缓存体积量级与「被解析源码的规模」相当（通常是源码体积的 1–3 倍）；
- 缓存是**纯派生数据**：删掉 `.project-compass/` 只会让下一次分析变慢，不会丢任何人工成果；
- 报告在 `docs/project-compass/`，与缓存分离，因此清理缓存不影响已生成的文档。

---

## LLM 开关与隐私

### 默认行为：完全不调用 LLM

`llm.enabled: false` 是默认值，含义是：

- 不向任何模型发送代码片段；
- `withLlm: true` 被静默忽略（返回里 `llm.used: false`）；
- 报告、图、引用、检索问答**全部照常工作**——它们本来就是确定性算法；
- 唯一缺的是「叙述性文字」（把模块职责用自然语言串起来的那部分）。

### 打开 LLM 时会发生什么

```yaml
config:
  llm:
    enabled: true
    maxCalls: 12
    maxTokens: 1200
```

1. 只有调用方同时传了 `withLlm: true` 才会真的调用；
2. 每次调用只发送**生成叙事所需的最小上下文**（相关模块的摘要、符号签名、路径），
   而不是整个仓库；
3. `maxCalls` / `maxTokens` 是硬上限，超出即停止并降级；
4. **所有 LLM 输出必须过验证器**：路径必须存在于 IR、行号必须落在 `1..loc` 内、
   符号名必须能在 IR 中找到；
5. 验证不通过的声明**被丢弃**，`validation.dropped` 给出条数，报告里写明丢弃了多少条；
6. 验证通过的声明也会带上 `path:line` 证据。

这条链路的设计意图很简单：**LLM 只负责「说得更顺」，不负责「说什么」**。
事实来自解析结果，模型说错的地方会被结构性校验拦下来。

### 数据出境的边界

| 项目 | 是否可能离开本机 |
| --- | --- |
| 源码内容（非敏感文件） | `llm.enabled: true` 且调用方传 `withLlm` 时，**部分片段可能**随提示发送 |
| 敏感文件内容 | **永不**——它们从不被读取 |
| 文件路径 | 可能随片段上下文发送 |
| 提问内容与命中片段 | `ask` 默认抽取式，不发送；显式开启 LLM 时可能发送 |
| 任何遥测 / 统计 | **不存在**。本插件没有任何回传通道 |

**结论**：不打开 `llm.enabled` 就绝对没有数据离开本机。打开之后，边界由你选择的 provider 决定——
在受监管环境里，请先确认 provider 的数据处理条款，或保持关闭。

---

## 配置生效与排错

| 现象 | 排查方向 |
| --- | --- |
| `/compass status` 不可用 | 软链是否正确、`cordis.patch.yml` 里的 `name` 是否为 `'dsh-project-compass'`、是否重启/重载过 |
| 配置改了没反应 | `config` 是覆盖式配置，确认写在 `- id: project-compass` 这一行下面（YAML 缩进）；确认重启 |
| 报告出现在意料之外的目录 | `outputDir` 是相对**项目根**解析的；确认你分析的是哪个目录 |
| 某个目录没被分析 | 先看 `scan` 返回的 `ignore: { rules, sources }`，确认是哪条规则命中 |
| 分析结果明显不全 | 看 `warnings` 与 `budget.filesSkipped`：多半是触顶了 `maxFiles` / `maxTotalBytes` / `maxDurationMs` |
| 模型不调用工具 | 确认插件已启用；工具是模型可见的，但模型是否调用取决于任务描述是否指向「读懂这个项目」 |
