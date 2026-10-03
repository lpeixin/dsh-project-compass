/**
 * 内嵌技能（runtime skill）注册。
 *
 * 技能正文放在同目录的 `SKILL.md`：安装后可直接编辑该文件调整方法论，
 * 不需要改代码（每次插件加载时读取）。技能是"该怎么读懂一个项目"的说明书，
 * 工具是"能读什么"的能力面——两者分开，方法论就能独立演进。
 *
 * @module dsh-project-compass/skill
 */

import { readFileSync } from 'node:fs'
import { DISPLAY_NAME, PACKAGE_NAME, SKILL_NAME, VERSION } from './version.js'

const SKILL_DESCRIPTION = [
  `把陌生或遗留项目读成"可接手的说明书"的方法论：${DISPLAY_NAME} 用扫描 → 多语言解析 → 统一 IR → 依赖图谱 → 本地检索 → 带引用报告六步流水线，`,
  '产出 ONBOARDING / ARCHITECTURE / MODULE_MAP / KEY_FLOWS / GETTING_STARTED 五份文档与一份机器可读 JSON，并支持就项目带证据提问。',
].join('')

const SKILL_WHEN_TO_USE = [
  '当用户要求"读懂这个项目""帮我接手这个代码库""这个项目是做什么的""入口在哪""某功能经过哪些模块"',
  '或需要为新人/技术负责人产出上手指南、架构说明、模块地图、关键调用链时使用。',
].join('')

let cachedBody

function skillBody() {
  if (cachedBody === undefined) {
    cachedBody = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8')
  }
  return cachedBody
}

/**
 * 把方法论技能注册到 `ctx.skills`（该组合未挂载技能注册表时静默跳过）。
 * @param ctx 插件上下文。
 * @returns 取消注册的函数，或 undefined（未注册时）。
 */
export function registerSkill(ctx) {
  const skills = typeof ctx?.get === 'function' ? ctx.get('skills') : ctx?.skills
  if (skills === undefined || skills === null || typeof skills.register !== 'function') return undefined
  const dispose = skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    content: skillBody(),
    source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
    metadata: { plugin: PACKAGE_NAME, kind: 'methodology', version: VERSION },
  })
  return typeof dispose === 'function' ? dispose : undefined
}
