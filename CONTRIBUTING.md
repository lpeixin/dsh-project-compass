# 贡献指南 / CONTRIBUTING

感谢你对 Project Compass（项目罗盘）感兴趣。本文件说明**这个仓库怎么开发、什么能改、怎么验证**。

> 只读一遍也要记住三件事：**零依赖、无 default export、绝不读敏感文件内容。**

- [开发环境](#开发环境)
- [三条硬约束](#三条硬约束)
- [动手之前：先读契约](#动手之前先读契约)
- [代码风格](#代码风格)
- [测试](#测试)
- [提交前自检](#提交前自检)
- [Pull Request](#pull-request)
- [常见贡献类型](#常见贡献类型)
- [文档贡献](#文档贡献)
- [不要提交的东西](#不要提交的东西)

---

## 开发环境

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 20.11（CI 跑 20.x 与 22.x） |
| 包管理器 | **不需要**。本仓库零依赖，没有 `npm install` 这一步 |
| 编辑器 | 任意。没有构建步骤、没有生成产物 |

```bash
git clone <repo-url> dsh-project-compass
cd dsh-project-compass

node --test                                                  # 单元测试，必须全绿
node --test --experimental-test-coverage                      # 覆盖率
node scripts/compass-cli.mjs status .                          # 对自己跑一次（不需要 DSH）
```

**不需要安装 DSH 也能开发**：核心逻辑宿主无关，`scripts/compass-cli.mjs` 提供完整的自测通道。

想在 DSH 里试用本仓库的改动：

```bash
ln -s "$PWD" ~/.dsh/profiles/<profile>/node_modules/dsh-project-compass
```

然后在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: project-compass
      name: 'dsh-project-compass'
```

重启或重载 DSH 后即可使用 `/compass`。

---

## 三条硬约束

### 1. 零外部依赖

**只允许 `node:*` 内置模块。** 不许 `import` 任何 npm 包，包括看起来"很标准"的那些
（`tree-sitter`、`glob`、`chalk`、`yaml`、`zod`……）。

这条约束支撑了产品的核心承诺：克隆即用、无构建步骤、无供应链面、宿主升级不会把它拖垮。
它意味着有些东西要自己写（glob 编译器、BM25、向量、并发池、原子写），这已经被接受。

```js
import path from 'node:path'        // ✅
import { readFile } from 'node:fs/promises'   // ✅
import fg from 'fast-glob'          // ❌ 引入依赖
```

宿主侧能力只通过 `ctx` 访问，**不 import 宿主代码**。

### 2. 无 default export

插件入口只允许命名导出 `name` / `inject` / `apply`：

```js
// ✅
export const name = 'project-compass'
export const inject = ['tools']
export function apply(ctx) { /* … */ }

// ❌ Loader 的 unwrapExports 会折叠 default 并丢掉 inject
export default { name, inject, apply }
```

失败表现是"插件加载成功但工具不在"，很难排查，所以按硬约束处理。

### 3. 绝不读取敏感文件内容

命中的敏感路径**只允许 `stat`**，内容不得进入内存、缓存、索引或报告。
插件会读取用户代码是一件需要负责的事，这条红线不提供配置绕过。

```js
const info = await statSafe(target)      // ✅ 只取元信息
const text = await readTextFile(target)  // ❌ 若该路径已判定为敏感
```

---

## 动手之前：先读契约

[`docs/INTERNAL-CONTRACTS.md`](docs/INTERNAL-CONTRACTS.md) 是**并行开发的唯一接口真相**。
所有跨模块的数据形状都在那里定义（`Profile`、`ParsedFile`、`IR`、`GraphBundle`、`Flow`、
`Chunk`、`Index`、`Answer`、`Validator`…）。

流程是：

1. 需要改接口 → **先改契约**，在 PR 里单独说明，并让受影响的模块一起对齐；
2. 不需要改接口 → 直接按契约实现，不要在模块内私自扩展字段名。

契约里还有**文件归属表**，它说明了并行开发时谁负责哪些文件——动手前确认你要改的文件属于你。

契约第 0 节还列了工程硬约束（ESM + `.js` 后缀、容错优先、纯函数优先、1-based 行号、
中文注释与输出、`node:test` 测试），这些和本文档同等效力。

---

## 代码风格

没有 linter，靠以下约定保持一致（**模仿周围代码**是最快的对齐方式）：

| 项 | 约定 |
| --- | --- |
| 模块 | ES Module，相对 import **必须带 `.js` 后缀** |
| 命名 | 标识符、字段名用英文；注释与面向用户的文案用中文 |
| 注释 | 中文，解释**为什么**而不是**做了什么**；每个模块顶部写清职责与边界 |
| 类型标注 | 用 JSDoc 描述入参与返回（本项目不写 TypeScript，也没有构建步骤） |
| 缩进 | 2 空格，无分号结尾风格与现有代码保持一致 |
| 纯函数优先 | 计算与 I/O 分离；解析器除入参外不碰文件系统 |
| 抛错 | 只有工具入参非法才抛错；其余降级并写 `warnings` |
| 文本处理 | 一律经 `lib/util.js`（`clip` / `normalizeText` / `toPosix` / `mermaidSafe`…），不要就地手写 |

几个具体的好习惯：

- **不要**在 `lib/util.js` 里加 import——它是全项目的公共地基；
- 需要排序时显式 `sortBy`，不要依赖 `Object.keys` 的顺序（会影响渲染确定性）；
- 生成 `path:line` 一律用 `util.cite()`，不要手拼字符串；
- 往 Mermaid 图里放用户数据一律过 `util.mermaidSafe()`。

---

## 测试

用 `node:test` + `node:assert/strict`，测试文件放 `test/*.test.js`。

```bash
node --test                                   # 全绿是合并前提
node --test --experimental-test-coverage      # 看覆盖率
node --test test/parse.test.js                # 单个文件
```

**测试纪律**

- 测试**不得联网**、**不得依赖 DSH 宿主**——它们必须在任何机器上、离线可跑；
- 测试用临时目录（`node:fs/promises` 的 `mkdtemp`）构造输入，不要依赖仓库里的真实文件布局；
- 精度相关的断言必须**断言行号**，而不只是断言"抽到了符号"；
- 加解析器/渲染器时，同时加一个**畸形输入**用例，断言"不抛错且有 `notes`/`warnings`"。

**涉及精度的改动必须配测试**：行号、符号名、路径解析、忽略规则匹配、证据引用格式。
这些是产品的可信度来源，回归代价最高。

---

## 提交前自检

```bash
node --test                                                          # 1. 测试全绿
node --check lib/<你改的文件>.js                                      # 2. 语法检查
node scripts/compass-cli.mjs analyze <一个真实项目>                    # 3. 真实项目冒烟
node scripts/compass-cli.mjs report  <一个真实项目>                    # 4. 产物能生成
node scripts/compass-cli.mjs ask     <一个真实项目> "认证流程经过哪些模块？"  # 5. 问答有引用
grep -rnE "from '[^.]|require\('[^.]" lib/ | grep -v "node:"          # 6. 没有引入外部依赖
```

第 6 条的输出应当只有 `node:*` 相关的行（或为空）。有输出就说明引入了依赖。

再自查一遍：

- [ ] 没有新增外部依赖（`package.json` 的 `dependencies` 必须保持为空）；
- [ ] 没有 `export default`；
- [ ] 新增/修改的接口与契约一致；若改了契约，契约文件也在本次 PR 里；
- [ ] 涉及用户可见行为的变化，同步更新了 `README.md` / `docs/*.md` / `CHANGELOG.md`；
- [ ] 没有把真实项目的产物（`.project-compass/`）或本地路径提交进去。

---

## Pull Request

一个好的 PR 包含：

1. **问题陈述**——你想回答什么问题 / 遇到了什么缺陷（附最小复现）；
2. **改动范围**——改了哪些文件、为什么必须改这些；
3. **验证方式**——跑了哪些命令、看到了什么结果（贴关键输出）；
4. **影响面**——是否改变产物格式（要动 `schemaVersion` 吗）、是否影响性能、是否触及隐私边界。

**评审会重点看**

| 关注点 | 具体检查 |
| --- | --- |
| 依赖 | 是否引入任何外部 import |
| 契约 | 数据形状是否与 `INTERNAL-CONTRACTS.md` 一致 |
| 行号 | 新增的符号抽取是否有行号断言 |
| 容错 | 畸形输入会不会抛错 |
| 隐私 | 是否可能读到敏感路径的内容 |
| 确定性 | 是否引入时间戳/随机序导致渲染不可 diff |
| 文案 | 是否把"计划中"的能力写成了现有能力 |

**关于"文档承诺"**：本项目的文档是产品面的一部分。**不得在文档里描述尚未实现的能力**——
没实现的东西只能写进 [docs/ROADMAP.md](docs/ROADMAP.md) 或标为"计划中"。

---

## 常见贡献类型

按价值排序（也是我们最欢迎的顺序）：

| 类型 | 说明 | 入口 |
| --- | --- | --- |
| **精度缺陷修复** | 行号错、符号错、路径解析错——**最高优先级**，因为会污染报告与问答 | 附最小复现片段 + 期望结果 |
| **新语言解析器** | 让一门新语言拿到深度解析能力 | 见 [ARCHITECTURE.md 的扩展点](docs/ARCHITECTURE.md#如何加一门语言) |
| **解析器补强** | 现有深度语言里遗漏的语法形态（装饰器、泛型方法、record、pattern matching…） | `lib/parse/*.js` |
| **检索质量** | 更好的分词、重排特征、分块边界 | `lib/rag.js`、`lib/embed.js`、`lib/chunk.js` |
| **报告章节** | 新增有价值的章节（需附证据） | 见 [ARCHITECTURE.md 的扩展点](docs/ARCHITECTURE.md#如何加一个报告章节) |
| **测试** | 覆盖畸形输入、边界条件、真实项目形态 | `test/*.test.js` |
| **文档** | 澄清、示例、已知限制补充 | `README.md`、`docs/*.md` |

如果你不确定从哪开始，**给一个真实项目跑一次并报告哪里不对**，本身就是很有价值的贡献。

---

## 文档贡献

文档同样是产品面，规则比代码更严：

| 规则 | 说明 |
| --- | --- |
| **不得编造能力** | 没实现的功能只能出现在 `docs/ROADMAP.md`，或显式标注"计划中" |
| **命令必须可执行** | 文档里的每条命令都要在本仓库或任意真实项目上真的能跑（占位符用 `<项目路径>` 这类明确标记） |
| **不改契约措辞** | 接口形状以 `INTERNAL-CONTRACTS.md` 为准，不要在其他文档里另立一套说法 |
| **示例要标注** | 示意性的产物摘录必须明确标注"示意"，不能让读者以为是真实输出 |
| **两份 README 不打架** | `README.md` 是中文全文（唯一真相），`README.zh-CN.md` 是英文摘要并指回前者；改一份要检查另一份是否需要同步 |
| **术语一致** | 统一用「项目罗盘 / Project Compass」「证据引用」「未验证」「增量」等既有术语 |

---

## 不要提交的东西

`.gitignore` 已经覆盖大部分，这里强调几类：

| 不要提交 | 原因 |
| --- | --- |
| `node_modules/` | 本仓库根本不需要它；出现即说明有人引入了依赖 |
| `.project-compass/` | 分析状态是每台机器各自的派生数据 |
| 任何真实项目的敏感文件 | 显而易见的红线（哪怕是"只是测试一下"） |
| 本地绝对路径 / 个人配置 | 文档与示例里统一用占位符 |
| `docs/project-compass/`（本仓库自己的产物）**在无意义时** | 注意：这个目录**不被忽略**——它是给人看的交付物。本仓库自己是否提交产物由维护者决定；如果你的 PR 顺手跑了分析并改了这些文件，请在 PR 描述里说明，别夹带 |

许可证：向本仓库贡献即表示你同意以 [MIT](LICENSE) 许可发布你的贡献。
