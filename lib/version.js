/**
 * 版本与身份常量：报告元信息、工具描述、缓存失效都引用这里，避免多处硬编码漂移。
 *
 * @module dsh-project-compass/version
 */

/** 插件包名（与 package.json 一致）。 */
export const PACKAGE_NAME = 'dsh-project-compass'

/** 中文名。 */
export const DISPLAY_NAME = '项目罗盘'

/** 英文名。 */
export const DISPLAY_NAME_EN = 'Project Compass'

/** 插件版本；发布时与 package.json 同步。 */
export const VERSION = '0.1.0'

/** 内嵌技能名。 */
export const SKILL_NAME = 'project-compass-onboarding'

/** 工具名前缀（6 个工具共用）。 */
export const TOOL_PREFIX = 'project_compass_'

/** 报告落款的生成口径说明。 */
export const EVIDENCE_POLICY =
  '本报告所有结论均来自静态证据（文件内容、导入关系、已解析调用与配置），引用格式为 `路径:行号` 或 `路径#符号`；无法证实的推断会显式标注"未验证"。'
