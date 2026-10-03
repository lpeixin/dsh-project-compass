/**
 * 落盘原语：所有读写在 <项目>/.project-compass 与报告目录内，全部原子写。
 *
 * 设计约束：
 *   - 原子写（临时文件 + rename）保证中断时不会留下半截 JSON，
 *     报告与缓存都是"可重建产物"，宁可缺也不要坏；
 *   - 读路径一律软失败（返回 fallback），因为缓存损坏不应让分析失败；
 *   - 不提供删除任意路径的通用能力，只提供精确的产物清理。
 *
 * @module dsh-project-compass/store
 */

import { constants } from 'node:fs'
import { access, appendFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 路径是否可访问（默认 F_OK）。 */
export async function pathExists(target, mode = constants.F_OK) {
  try {
    await access(target, mode)
    return true
  } catch {
    return false
  }
}

/** stat 软失败版本：不存在或不可读返回 undefined。 */
export async function statSafe(target) {
  try {
    return await stat(target)
  } catch {
    return undefined
  }
}

/** 是否为目录。 */
export async function isDirectory(target) {
  const info = await statSafe(target)
  return info !== undefined && info.isDirectory()
}

/** 是否为普通文件。 */
export async function isFile(target) {
  const info = await statSafe(target)
  return info !== undefined && info.isFile()
}

/** 递归创建目录。 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/** 读取文本；不存在或读取失败返回 fallback。 */
export async function readTextFile(file, fallback = undefined) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return fallback
  }
}

/** 读取 JSON；解析失败返回 fallback（缓存损坏不等于分析失败）。 */
export async function readJsonFile(file, fallback = undefined) {
  const text = await readTextFile(file, undefined)
  if (text === undefined) return fallback
  try {
    const parsed = JSON.parse(text)
    return parsed === null ? fallback : parsed
  } catch {
    return fallback
  }
}

/**
 * 在一个目录里放一个 `*` 的 `.gitignore`，让该目录**永远不会被提交**。
 *
 * 为什么需要：`.project-compass/` 里存的是机器状态，其中 `scan.json` / `ir.json` /
 * `state.json` 会记录**项目根的绝对路径**（即用户的本地目录结构）。用户如果
 * `git add .`，就把自己的文件系统布局一起提交上去了。工具自己声明"别提交我"，
 * 比指望每个用户都记得配 `.gitignore` 靠谱。
 *
 * 只在缺失时写入，不覆盖用户已有内容。
 * @param dir 目标目录（会被创建）。
 * @returns 该 `.gitignore` 的路径。
 */
export async function ensureSelfIgnoring(dir) {
  await ensureDir(dir)
  const file = path.join(dir, '.gitignore')
  if (await pathExists(file)) return file
  try {
    await writeTextFile(file, '# 由 Project Compass 自动生成：本目录是机器状态（含本机绝对路径），请勿提交。\n*\n')
  } catch {
    // 写不进去也不影响分析
  }
  return file
}

/** 原子写文本：同目录临时文件 + rename。 */
export async function writeTextFile(file, text) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(tmp, text, 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  return file
}

/** 原子写 JSON（两空格缩进，便于人工 review 与 diff）。 */
export async function writeJsonFile(file, value) {
  return writeTextFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** 追加一行到 jsonl（问答留痕用）。 */
export async function appendLine(file, line) {
  await ensureDir(path.dirname(file))
  await appendFile(file, `${String(line).replace(/\n+$/, '')}\n`, 'utf8')
  return file
}

/** 列目录（稳定排序，软失败返回空数组）。 */
export async function listDir(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory(), file: entry.isFile(), symlink: entry.isSymbolicLink() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch {
    return []
  }
}

/** 删除单个文件（软失败）。 */
export async function removeFile(file) {
  try {
    await unlink(file)
    return true
  } catch {
    return false
  }
}

/** 递归删除目录（仅用于 `.project-compass` 这类自建状态目录）。 */
export async function removeDir(dir) {
  try {
    await rm(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** 目录（含子目录）总体积与文件数，用于状态汇报。 */
export async function dirStats(dir) {
  const out = { files: 0, bytes: 0 }
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of await listDir(current)) {
      const target = path.join(current, entry.name)
      if (entry.dir) stack.push(target)
      else if (entry.file) {
        const info = await statSafe(target)
        out.files += 1
        out.bytes += info?.size ?? 0
      }
    }
  }
  return out
}
