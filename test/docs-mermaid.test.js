/**
 * 文档 Mermaid 语法守卫（针对手写 Markdown，不是插件生成的图）。
 *
 * 起因是一个真实 issue：`docs/ARCHITECTURE.md` 的「分层总览」里有个节点 id 叫 `graph`，
 * 而 `graph` 是 Mermaid flowchart 的**图类型关键字**。词法分析器把它当成 `GRAPH` token，
 * 于是 `graph["graph.js"]` 这行直接报 `got 'GRAPH'`，Typora 等阅读器整张图渲染失败。
 *
 * 插件**生成**的图不会踩这个坑（`lib/mermaid.js` 一律用 `n0…nN` 做 id，名字只出现在引号标签里），
 * 所以问题只会出现在人写的文档里——而 `test/report.test.js` 的 Mermaid 校验器只看生成器的输出，
 * 这道防线正好漏掉了手写部分。本文件补上它，并**自带反例**证明守卫真的会失败。
 *
 * 覆盖三类高信号问题（刻意不做完整 Mermaid 解析器，零依赖约束下不现实）：
 *   1. flowchart 的节点 id / 子图 id 命中保留字（`graph`、`end`、`class`、`style`、`click`、`subgraph` …）；
 *   2. 子图 `subgraph` 与 `end` 数量不配对；
 *   3. 代码围栏未闭合。
 *
 * @module test/docs-mermaid.test
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const repoRoot = new URL('..', import.meta.url).pathname

/**
 * flowchart / graph 中不能用作节点 id 的保留字（小写比较）。
 * 依据 Mermaid flowchart 语法与常见陷阱清单；宁可保守，只列确定会撞的关键字。
 */
const FLOWCHART_RESERVED = new Set([
  'graph', 'flowchart', 'subgraph', 'end', 'class', 'classdef', 'style',
  'linkstyle', 'click', 'direction', 'callback', 'default', 'acctitle', 'accdescr',
])

/** 箭头族（长的在前，避免 `-->` 被 `->` 先切断）。 */
const ARROW = /<?-{2,}>?|-\.->|==>|--[xo]|-->>|->>|-->|->|---/

/** 控制/装饰类语句：这些行的首个词不是节点 id。 */
const CONTROL_LINE = /^(%%|subgraph\b|end\b|direction\b|style\b|classDef\b|class\b|linkStyle\b|click\b|accTitle\b|accDescr\b)/

/**
 * 抽出 Markdown 里的 mermaid 代码块。
 * @param text 文件内容。
 * @returns `[{ startLine, body, closed }]`（`startLine` 是围栏所在行，1-based）。
 */
export function extractMermaidBlocks(text) {
  const lines = String(text ?? '').split('\n')
  const blocks = []
  let index = 0
  while (index < lines.length) {
    const open = /^(`{3,}|~{3,})\s*mermaid\b/i.exec(lines[index])
    if (open === null) {
      index += 1
      continue
    }
    const fenceChar = open[1][0]
    const fenceLen = open[1].length
    const startLine = index + 1
    const body = []
    let cursor = index + 1
    let closed = false
    while (cursor < lines.length) {
      const close = new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`).exec(lines[cursor])
      if (close !== null) {
        closed = true
        break
      }
      body.push(lines[cursor])
      cursor += 1
    }
    blocks.push({ startLine, body, closed })
    index = cursor + 1
  }
  return blocks
}

/** 取一行的首个标识符（节点 id 的形态）。 */
function leadingId(text) {
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)/.exec(String(text ?? '').trim())
  return match === null ? null : match[1]
}

/** 装饰类指令：`style X ...`、`classDef X ...` 这类行里的首个词不是节点 id。 */
const DIRECTIVE_LINE = /^(style|classDef|class|linkStyle|click|direction|accTitle|accDescr)\b/

/**
 * 抽出一行里出现的所有节点 id（定义、裸节点、边端点、`&` 链）。
 *
 * 难点是同一个词既可能是 id 也可能是指令：判定规则是「第一个词后面紧跟 `[`/`(`/`{`/`>`
 * 就是节点定义，否则才按指令/终止符处理」。这样 `end`（终止符）与 `end[Finish]`（节点）
 * 能区分开，`class A foo`（指令）与 `class["x"]`（节点）也能区分开。
 */
export function idsInLine(line) {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith('%%')) return []
  const ids = []

  const head = /^([A-Za-z_][A-Za-z0-9_-]*)\s*([[(>{]?)/.exec(trimmed)
  if (head !== null) {
    const id = head[1]
    const bracket = head[2]
    if (bracket.length > 0) {
      ids.push(id) // 节点定义（保留字同样要报）
    } else if (id.toLowerCase() === 'end') {
      // 裸 `end` 是 subgraph 终止符，不是节点
    } else if (DIRECTIVE_LINE.test(trimmed)) {
      // 指令行：首个词是被操作的对象，不是定义
    } else {
      ids.push(id) // 裸节点
    }
  }

  // 边：先去掉 |标签|，再按箭头切段，每段按 & 拆开取首标识符
  const cleaned = trimmed.replace(/\|[^|]*\|/g, ' ')
  if (ARROW.test(cleaned)) {
    for (const segment of cleaned.split(ARROW)) {
      for (const piece of segment.split('&')) {
        const id = leadingId(piece)
        if (id !== null) ids.push(id)
      }
    }
  }
  return ids
}

/**
 * 检查一个 mermaid 块。
 * @param body 块内各行的数组。
 * @returns `{ kind, problems, ids }`；`problems` 为空表示通过。
 */
export function lintMermaidBlock(body) {
  const lines = Array.isArray(body) ? body : []
  const problems = []
  const ids = new Set()

  const firstContent = lines.find((line) => line.trim().length > 0 && !line.trim().startsWith('%%'))
  const kind = firstContent === undefined ? '' : (leadingId(firstContent) ?? '').toLowerCase()
  if (kind.length === 0) problems.push('块内没有任何内容')

  const isFlowchart = kind === 'flowchart' || kind === 'graph'

  if (isFlowchart) {
    let subgraphs = 0
    let ends = 0
    // 图类型声明行（`flowchart TB` / `graph LR`）不是节点，必须跳过
    const declarationIndex = lines.findIndex((line) => line.trim().length > 0 && !line.trim().startsWith('%%'))
    for (const [index, line] of lines.entries()) {
      if (index === declarationIndex) continue
      const trimmed = line.trim()
      if (trimmed.startsWith('%%')) continue

      const sub = /^subgraph\s+([A-Za-z_][A-Za-z0-9_-]*)/.exec(trimmed)
      if (sub !== null) {
        subgraphs += 1
        const id = sub[1]
        ids.add(id)
        if (FLOWCHART_RESERVED.has(id.toLowerCase())) {
          problems.push(`子图 id 命中 Mermaid 保留字：「${id}」（${trimmed}）`)
        }
        continue
      }
      if (/^end\s*$/.test(trimmed)) {
        ends += 1
        continue
      }
      for (const id of idsInLine(line)) {
        ids.add(id)
        if (FLOWCHART_RESERVED.has(id.toLowerCase())) {
          problems.push(`节点 id 命中 Mermaid 保留字：「${id}」（${trimmed}）`)
        }
      }
    }
    if (subgraphs !== ends) {
      problems.push(`subgraph 与 end 不配对：subgraph ${subgraphs} 个 / end ${ends} 个`)
    }
  }

  return { kind, problems, ids: [...ids] }
}

/** 检查一份 Markdown（带行号偏移，便于定位）。 */
export function lintMarkdown(text) {
  const blocks = extractMermaidBlocks(text)
  const problems = []
  for (const block of blocks) {
    if (!block.closed) problems.push(`第 ${block.startLine} 行开始的 mermaid 代码围栏未闭合`)
    const result = lintMermaidBlock(block.body)
    for (const problem of result.problems) problems.push(`第 ${block.startLine} 行的图：${problem}`)
  }
  return { blocks: blocks.length, problems }
}

/* ------------------------------------------------------------------ *
 * 守卫自身的有效性（先证明它会失败，再谈它有没有通过）
 * ------------------------------------------------------------------ */

test('守卫自检：issue 里的原始写法必须被判定为错误', () => {
  const broken = [
    'flowchart TB',
    '  subgraph L2["L2 结构层"]',
    '    ir["ir.js"]',
    '    graph["graph.js"]',
    '  end',
    '  ir --> graph',
  ]
  const result = lintMermaidBlock(broken)
  assert.ok(result.problems.length >= 2, `应报出定义与边引用两处：${JSON.stringify(result.problems)}`)
  assert.ok(result.problems.some((problem) => problem.includes('「graph」')))
})

test('守卫自检：改名之后必须通过（且标签保持 graph.js）', () => {
  const fixed = [
    'flowchart TB',
    '  subgraph L2["L2 结构层"]',
    '    ir["ir.js"]',
    '    graphjs["graph.js"]',
    '  end',
    '  ir --> cache & parse & graphjs & flows',
    '  graphjs --> util',
    '  flows --> graphjs',
  ]
  assert.deepEqual(lintMermaidBlock(fixed).problems, [])
  assert.ok(lintMermaidBlock(fixed).ids.includes('graphjs'))
})

test('守卫自检：其它保留字与结构错误同样能被抓到', () => {
  assert.ok(lintMermaidBlock(['flowchart LR', '  end[Finish]']).problems.length > 0, 'end 作节点 id')
  assert.ok(lintMermaidBlock(['flowchart LR', '  class["x"]']).problems.length > 0, 'class 作节点 id')
  assert.ok(lintMermaidBlock(['flowchart LR', '  subgraph graph["x"]']).problems.length > 0, 'subgraph 作子图 id')
  assert.ok(
    lintMermaidBlock(['flowchart LR', '  subgraph A["a"]', '    n0["x"]']).problems.some((p) => p.includes('不配对')),
    '缺少 end',
  )
})

test('守卫自检：围栏未闭合会被报告', () => {
  const md = ['# t', '', '```mermaid', 'flowchart LR', '  n0["x"]'].join('\n')
  assert.ok(lintMarkdown(md).problems.some((p) => p.includes('未闭合')))
})

/* ------------------------------------------------------------------ *
 * 仓库里的真实文档
 * ------------------------------------------------------------------ */

/** 递归收集仓库内的 Markdown 文件（跳过生成物与依赖）。 */
async function collectMarkdown(dir, out = []) {
  const SKIP = new Set(['node_modules', '.git', '.project-compass', 'project-compass'])
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await collectMarkdown(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

test('仓库文档：所有 Mermaid 块都不使用保留字做节点 id，且结构完整', async () => {
  const files = await collectMarkdown(repoRoot)
  assert.ok(files.length >= 10, `Markdown 文件数异常：${files.length}`)

  let blockCount = 0
  const problems = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    const result = lintMarkdown(text)
    blockCount += result.blocks
    const rel = path.relative(repoRoot, file)
    for (const problem of result.problems) problems.push(`${rel}：${problem}`)
  }

  assert.ok(blockCount >= 8, `扫到的 mermaid 块太少（${blockCount}），守卫可能失效`)
  assert.deepEqual(problems, [], `发现 Mermaid 渲染风险：\n${problems.join('\n')}`)
})
