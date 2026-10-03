/**
 * 增量缓存（FR5）：按"内容哈希 + 语言 + 解析器版本"缓存单文件解析结果。
 *
 * 为什么不缓存 IR 整体：IR 装配是纯内存计算（毫秒级），而**解析**才是大头。
 * 缓存粒度落在文件解析结果上，既能复用，又不会因为一次装配逻辑变更而整体失效。
 *
 * 失效规则（三者任一变化即重算）：
 *   - 文件内容哈希变化；
 *   - 语言判定变化（改扩展名/改大小写）；
 *   - `PARSER_VERSION` 变化——**解析器行为改动必须同步 bump 这个常量**，
 *     否则用户会拿到旧解析结果且毫无提示。
 *
 * @module dsh-project-compass/cache
 */

import { cacheEntryFile, stateDir } from './paths.js'
import { dirStats, listDir, pathExists, readJsonFile, removeDir, removeFile, writeJsonFile } from './store.js'
import { hashContent, toPosix } from './util.js'

/** 缓存结构版本；字段增删时递增（旧条目会被忽略而不是报错）。 */
export const CACHE_SCHEMA_VERSION = 1

/** 解析器版本；解析逻辑（符号抽取、行号算法）变更时**必须**递增。 */
export const PARSER_VERSION = 1

/**
 * 缓存键：内容哈希 + 语言 + 解析器版本。
 * @param input.relPath 相对路径（只用于可读性与剪枝，不参与语义）。
 */
export function cacheKey(input) {
  return hashContent(`${input.hash}|${input.language}|${input.parserVersion ?? PARSER_VERSION}`)
}

/**
 * 创建一个项目级解析缓存。
 * @param root 项目根。
 * @param options.enabled 关闭后所有读都落空、写都跳过（`--no-cache` 场景）。
 * @param options.parserVersion 覆盖解析器版本（测试用）。
 * @param options.maxEntries 软上限，超出后 put 会跳过（避免单仓库把磁盘写满）。
 */
export async function createCache(root, options = {}) {
  const enabled = options.enabled !== false
  const parserVersion = options.parserVersion ?? PARSER_VERSION
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(0, Math.trunc(options.maxEntries)) : 200000
  const memo = new Map()
  let hits = 0
  let misses = 0
  let writes = 0
  let entries = 0

  return {
    parserVersion,
    /** 读取一个缓存条目；不存在/损坏/版本不符一律返回 undefined。 */
    async get(relPath, hash, language) {
      if (!enabled) return undefined
      const key = cacheKey({ hash, language, parserVersion })
      if (memo.has(key)) {
        hits += 1
        return memo.get(key)
      }
      const file = cacheEntryFile(root, key)
      const record = await readJsonFile(file, undefined)
      if (record === undefined || record === null || typeof record !== 'object') {
        misses += 1
        return undefined
      }
      if (record.schemaVersion !== CACHE_SCHEMA_VERSION || record.parserVersion !== parserVersion) {
        misses += 1
        return undefined
      }
      if (record.hash !== hash || record.language !== language || toPosix(record.relPath) !== toPosix(relPath)) {
        misses += 1
        return undefined
      }
      memo.set(key, record.parsed)
      hits += 1
      return record.parsed
    },

    /** 写入一个缓存条目（原子写；失败不抛错，缓存不该让分析失败）。 */
    async put(relPath, hash, language, parsed) {
      if (!enabled) return false
      if (entries >= maxEntries) return false
      const key = cacheKey({ hash, language, parserVersion })
      memo.set(key, parsed)
      const record = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        parserVersion,
        key,
        relPath: toPosix(relPath),
        hash,
        language,
        savedAt: new Date().toISOString(),
        parsed,
      }
      try {
        await writeJsonFile(cacheEntryFile(root, key), record)
        entries += 1
        writes += 1
        return true
      } catch {
        return false
      }
    },

    /** 命中/未命中统计（写进 status 与报告元信息）。 */
    stats() {
      const total = hits + misses
      return { enabled, hits, misses, writes, entries, hitRate: total === 0 ? 0 : hits / total }
    },

    /**
     * 剪枝：删除不在 keepKeys 中的缓存条目。
     * @param keepKeys 需要保留的缓存键集合（通常是本轮全量文件算出的键）。
     * @returns 删除数量。
     */
    async prune(keepKeys) {
      if (!enabled) return 0
      const keep = new Set(keepKeys ?? [])
      const base = `${stateDir(root)}/cache`
      if (!(await pathExists(base))) return 0
      let removed = 0
      for (const shard of await listDir(base)) {
        if (!shard.dir) continue
        for (const entry of await listDir(`${base}/${shard.name}`)) {
          if (!entry.file || !entry.name.endsWith('.json')) continue
          const key = entry.name.slice(0, -'.json'.length)
          if (keep.has(key)) continue
          if (await removeFile(`${base}/${shard.name}/${entry.name}`)) removed += 1
        }
      }
      return removed
    },

    /** 缓存占用的磁盘体积。 */
    async size() {
      return dirStats(`${stateDir(root)}/cache`)
    },

    /** 清空缓存目录。 */
    async clear() {
      memo.clear()
      hits = 0
      misses = 0
      writes = 0
      entries = 0
      return removeDir(`${stateDir(root)}/cache`)
    },
  }
}

/**
 * 判断一批文件里哪些发生了变化（内容哈希对比 IR 中记录的 hash）。
 * `project_compass_update` 靠它决定重算范围。
 *
 * @param ir 上一轮 IR（可为空）。
 * @param files 本轮文件 `[{ id, hash }]`。
 * @returns { changed, added, removed, unchanged }
 */
export function diffFiles(ir, files) {
  const previous = new Map((ir?.files ?? []).map((file) => [file.id, file.hash ?? null]))
  const current = new Map((files ?? []).map((file) => [toPosix(file.id), file.hash ?? null]))
  const changed = []
  const added = []
  const unchanged = []
  for (const [id, hash] of current) {
    if (!previous.has(id)) added.push(id)
    else if (previous.get(id) !== hash) changed.push(id)
    else unchanged.push(id)
  }
  const removed = [...previous.keys()].filter((id) => !current.has(id))
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort(), unchanged: unchanged.sort() }
}
