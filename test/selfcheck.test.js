/**
 * 自扫描守卫：用**独立于解析器的探针**核对解析结果，防止"静默丢符号"。
 *
 * 为什么需要它：解析器测试用的是自己写的内联 fixture，fixture 与实现很容易一起错——
 * 真实的 bug 长这样：`lib/report.js` 有 96 个函数声明，解析器只抽出 51 个，
 * 并且**公开导出 `renderReports` 完全消失**（根因是"模板字面量里嵌套模板字面量"
 * 让扫描器误判字符串边界，把后续内容整段吞掉）。这种缺失不会抛错、不会让其它测试变红，
 * 但会直接让模块地图与公开 API 流程漏掉最重要的一条。
 *
 * 这里的探针刻意**只用最朴素的逐行正则**去读"源码里确实写了什么"：
 * 探针与解析器实现完全无关，因此两者不一致时必然是其中一方错了，而不是"两边一起错"。
 *
 * @module test/selfcheck.test
 */

import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFile, detectLanguage } from '../lib/parse/index.js'

const repoRoot = new URL('..', import.meta.url).pathname

/** 递归收集要自检的文件。 */
async function collectFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await collectFiles(full, out)
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * 独立探针：逐行找出**顶层导出声明**。
 *
 * 只认 `^export ...` 开头的行（注释行以 `*`、`//` 开头，不会误命中），
 * 因此这是"源码里确实存在这个导出名"的可靠下界。
 */
function probeExportedNames(text) {
  const names = new Set()
  for (const line of text.split('\n')) {
    let match = /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line)
    if (match !== null) {
      names.add(match[1])
      continue
    }
    match = /^export\s+class\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (match !== null) {
      names.add(match[1])
      continue
    }
    match = /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (match !== null) names.add(match[1])
  }
  return [...names]
}

/** 用真实解析器解析一个文件。 */
function parseRepoFile(absPath) {
  const relPath = path.relative(repoRoot, absPath)
  const content = readFileSync(absPath, 'utf8')
  return {
    relPath,
    content,
    parsed: parseFile({
      relPath,
      content,
      language: detectLanguage(relPath),
      fileId: relPath,
      moduleId: path.dirname(relPath),
    }),
  }
}

test('自扫描守卫：每个顶层导出名都必须被解析器抽出', async () => {
  const files = [...(await collectFiles(path.join(repoRoot, 'lib'))), ...(await collectFiles(path.join(repoRoot, 'scripts')))]
  assert.ok(files.length >= 20, `自检文件数异常：${files.length}`)

  const problems = []
  let checked = 0
  for (const absPath of files) {
    const { relPath, parsed } = parseRepoFile(absPath)
    const extracted = new Set(parsed.symbols.map((symbol) => symbol.name))
    for (const name of probeExportedNames(readFileSync(absPath, 'utf8'))) {
      checked += 1
      if (!extracted.has(name)) problems.push(`${relPath}: 导出 ${name} 未被抽出`)
    }
  }

  assert.deepEqual(problems, [], `发现静默丢符号（解析器与源码不一致）：\n${problems.join('\n')}`)
  assert.ok(checked >= 60, `探针覆盖的导出名太少（${checked}），守卫可能失效`)
})

test('自扫描守卫：符号不应在文件尾部成片消失', async () => {
  const files = await collectFiles(path.join(repoRoot, 'lib'))
  const problems = []
  for (const absPath of files) {
    const { relPath, content, parsed } = parseRepoFile(absPath)
    const loc = content.split('\n').length
    if (loc < 120) continue
    // 尾部 15% 内的顶层声明若一个都没抽到，通常意味着扫描器在某个字符串/模板里"卡住"了
    const tailStart = Math.floor(loc * 0.85)
    const tailDeclarations = probeExportedNames(content.split('\n').slice(tailStart - 1).join('\n')).length
    const maxSymbolLine = parsed.symbols.reduce((max, symbol) => Math.max(max, symbol.line), 0)
    if (tailDeclarations > 0 && maxSymbolLine < tailStart) {
      problems.push(`${relPath}: 尾部 ${tailStart}-${loc} 行有 ${tailDeclarations} 个导出，但最后抽到的符号在第 ${maxSymbolLine} 行`)
    }
  }
  assert.deepEqual(problems, [], `疑似在文件尾部成片丢符号：\n${problems.join('\n')}`)
})

test('自扫描守卫：解析器对自身的每一行号都能反查命中', async () => {
  const files = await collectFiles(path.join(repoRoot, 'lib'))
  const problems = []
  for (const absPath of files) {
    const { relPath, content, parsed } = parseRepoFile(absPath)
    const lines = content.split('\n')
    for (const symbol of parsed.symbols) {
      const text = lines[symbol.line - 1]
      if (text === undefined) {
        problems.push(`${relPath}:${symbol.line} 符号 ${symbol.name} 的行号超出文件范围`)
        continue
      }
      // 行号指向的那一行必须真的提到这个符号名（或它是 route-handler 这类合成名）
      if (!text.includes(symbol.name) && symbol.kind !== 'route-handler') {
        problems.push(`${relPath}:${symbol.line} 声称是 ${symbol.name}，但该行是「${text.trim().slice(0, 60)}」`)
      }
    }
  }
  assert.deepEqual(problems.slice(0, 20), [], `符号行号无法反查：\n${problems.slice(0, 20).join('\n')}`)
})
