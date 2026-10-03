/**
 * 路径规约：项目内的所有落盘位置都只在这里定义。
 *
 * 两类目录刻意分开：
 *   - `<项目>/.project-compass/`  机器状态（扫描快照、IR、缓存、索引）——可随时删除重建；
 *   - `<项目>/docs/project-compass/` 人类产物（6 份报告）——进版本库、供评审。
 *
 * @module dsh-project-compass/paths
 */

import path from 'node:path'
import { toPosix } from './util.js'

/** 机器状态目录名（项目根下）。 */
export const STATE_DIR = '.project-compass'

/** 报告默认输出目录（项目根下，可配置覆盖）。 */
export const DEFAULT_OUTPUT_DIR = 'docs/project-compass'

/** 忽略规则文件名（项目根下，与 .gitignore 同语法）。 */
export const IGNORE_FILE = '.compassignore'

/** 6 份产物的逻辑名 → 文件名。 */
export const REPORT_FILES = {
  onboarding: 'ONBOARDING.md',
  architecture: 'ARCHITECTURE.md',
  moduleMap: 'MODULE_MAP.md',
  keyFlows: 'KEY_FLOWS.md',
  gettingStarted: 'GETTING_STARTED.md',
  json: 'project-compass.json',
}

/** 报告逻辑名顺序（渲染与状态汇报都按此顺序）。 */
export const REPORT_ORDER = ['onboarding', 'architecture', 'moduleMap', 'keyFlows', 'gettingStarted', 'json']

/** 状态目录绝对路径。 */
export function stateDir(root) {
  return path.join(root, STATE_DIR)
}

/** 解析缓存目录（按哈希前两位分片，避免单目录数万文件）。 */
export function cacheDir(root) {
  return path.join(stateDir(root), 'cache')
}

/** 单个缓存条目的绝对路径。 */
export function cacheEntryFile(root, key) {
  const safe = String(key ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
  const shard = safe.slice(0, 2).padEnd(2, '_')
  return path.join(cacheDir(root), shard, `${safe}.json`)
}

/** 扫描快照文件。 */
export function scanFile(root) {
  return path.join(stateDir(root), 'scan.json')
}

/** 统一 IR 文件。 */
export function irFile(root) {
  return path.join(stateDir(root), 'ir.json')
}

/** 运行状态文件（上次分析时间、预算消耗、产物清单）。 */
export function stateFile(root) {
  return path.join(stateDir(root), 'state.json')
}

/** RAG 索引文件。 */
export function indexFile(root) {
  return path.join(stateDir(root), 'index.json')
}

/** 问答历史文件（本地留痕，便于复现回答依据）。 */
export function qaLogFile(root) {
  return path.join(stateDir(root), 'qa-log.jsonl')
}

/** 报告输出目录（outputDir 为相对路径时按项目根解析）。 */
export function reportsDir(root, outputDir) {
  const raw = typeof outputDir === 'string' && outputDir.trim().length > 0 ? outputDir.trim() : DEFAULT_OUTPUT_DIR
  return path.isAbsolute(raw) ? raw : path.join(root, raw)
}

/** 全部产物的绝对路径表（键与 REPORT_FILES 一致）。 */
export function reportPaths(root, outputDir) {
  const dir = reportsDir(root, outputDir)
  const out = {}
  for (const [key, filename] of Object.entries(REPORT_FILES)) out[key] = path.join(dir, filename)
  return out
}

/** 绝对路径 → 项目内相对 posix 路径（不在项目内时原样返回）。 */
export function relPath(root, target) {
  const relative = path.relative(root, target)
  if (relative.length === 0) return '.'
  if (relative.startsWith('..')) return toPosix(target)
  return toPosix(relative)
}

/** 项目内相对 posix 路径 → 绝对路径。 */
export function absPath(root, relative) {
  return path.isAbsolute(relative) ? relative : path.resolve(root, relative)
}

/** 判断 target 是否位于 root 之内（含相等）。 */
export function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** 模块 id：取相对路径的目录部分，根目录记为 `.`。 */
export function moduleIdOf(relFile) {
  const dir = toPosix(path.posix.dirname(toPosix(relFile)))
  return dir === '' || dir === '.' ? '.' : dir
}
