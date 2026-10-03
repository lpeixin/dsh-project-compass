/**
 * 项目状态读写：把"磁盘上的事实"收敛到一处，工具层不再各自拼路径。
 *
 * 落盘布局（`docs/INTERNAL-CONTRACTS.md` §1 的 `lib/paths.js`）：
 *   `.project-compass/scan.json`   扫描画像
 *   `.project-compass/ir.json`     统一 IR（含图谱）
 *   `.project-compass/state.json`  运行状态（时间、预算、产物清单）
 *   `.project-compass/cache/`      文件解析缓存
 *   `.project-compass/index.json`  RAG 索引
 *
 * 读取路径一律软失败：状态文件缺失意味着"还没分析过"，不是错误。
 *
 * @module dsh-project-compass/project
 */

import { indexFile, irFile, scanFile, stateDir, stateFile } from './paths.js'
import { ensureSelfIgnoring, pathExists, readJsonFile, writeJsonFile } from './store.js'
import { buildGraphs } from './graph.js'
import { detectFlows } from './flows.js'
import { IR_SCHEMA_VERSION } from './ir.js'
import { VERSION } from './version.js'

/** 状态文件结构版本。 */
export const STATE_SCHEMA_VERSION = 1

/** 读取扫描画像。 */
export async function loadProfile(root) {
  return readJsonFile(scanFile(root), undefined)
}

/** 写入扫描画像。 */
export async function saveProfile(root, profile) {
  await ensureSelfIgnoring(stateDir(root))
  return writeJsonFile(scanFile(root), profile)
}

/** 读取 IR；schema 版本不符视为不存在（避免用旧结构渲染新报告）。 */
export async function loadIR(root) {
  const ir = await readJsonFile(irFile(root), undefined)
  if (ir === undefined || ir === null || typeof ir !== 'object') return undefined
  if (ir.schemaVersion !== IR_SCHEMA_VERSION) return undefined
  return ir
}

/** 写入 IR。 */
export async function saveIR(root, ir) {
  await ensureSelfIgnoring(stateDir(root))
  return writeJsonFile(irFile(root), ir)
}

/** 读取运行状态。 */
export async function loadState(root) {
  const state = await readJsonFile(stateFile(root), undefined)
  if (state === undefined || state === null || typeof state !== 'object') return defaultState()
  return { ...defaultState(), ...state }
}

/** 合并写入运行状态。 */
export async function saveState(root, patch) {
  const current = await loadState(root)
  const next = { ...current, ...patch, toolVersion: VERSION, updatedAt: new Date().toISOString() }
  await ensureSelfIgnoring(stateDir(root))
  await writeJsonFile(stateFile(root), next)
  return next
}

/** 默认状态。 */
export function defaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    toolVersion: VERSION,
    createdAt: null,
    updatedAt: null,
    lastScan: null,
    lastAnalyze: null,
    lastReport: null,
    lastIndex: null,
    lastAsk: null,
    budget: null,
    outputs: {},
    answerCount: 0,
  }
}

/**
 * 确保 IR 上带有图谱：从磁盘读回来的 IR 可能缺少或有旧图谱。
 * 图谱是 IR 的纯函数派生值，因此这里可以安全重建。
 * @returns 同一个 IR 对象（就地补齐 `graph`）。
 */
export function ensureGraph(ir, options = {}) {
  const missing = ir?.graph === undefined || ir?.graph === null || (ir.graph.stats?.fileNodes ?? 0) === 0
  if (missing && (ir?.files?.length ?? 0) > 0) ir.graph = buildGraphs(ir, options)
  return ir
}

/**
 * 从 IR 复算关键流程（确定性、毫秒级，因此不落盘）。
 * @returns Flow[]
 */
export function flowsOf(ir, options = {}) {
  if (ir === undefined || ir === null) return []
  return detectFlows(ir, options)
}

/**
 * 汇总一个项目的当前状态，供 `project_compass_status` 与报告元信息使用。
 * @param root 项目根。
 * @param options.outputDir 报告目录覆盖。
 */
export async function projectStatus(root) {
  const [state, profileExists, irExists, indexExists] = await Promise.all([
    loadState(root),
    pathExists(scanFile(root)),
    pathExists(irFile(root)),
    pathExists(indexFile(root)),
  ])
  const ir = irExists ? await loadIR(root) : undefined
  return {
    root,
    state,
    hasScan: profileExists,
    hasIR: irExists,
    hasIndex: indexExists,
    analyzed: irExists,
    ir: ir === undefined ? null : ir,
    files: {
      scan: scanFile(root),
      ir: irFile(root),
      state: stateFile(root),
      index: indexFile(root),
    },
  }
}

/**
 * 记录一次运行结果到状态文件（时间、预算、产物）。
 * @param kind `scan|analyze|report|index|ask`
 */
export async function recordRun(root, kind, payload = {}) {
  const patch = { [`last${kind[0].toUpperCase()}${kind.slice(1)}`]: new Date().toISOString() }
  if (payload.budget !== undefined) patch.budget = payload.budget
  if (payload.outputs !== undefined) patch.outputs = payload.outputs
  if (payload.extra !== undefined) Object.assign(patch, payload.extra)
  return saveState(root, patch)
}
