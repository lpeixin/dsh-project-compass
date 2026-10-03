/**
 * LLM 适配层（FR6 的"生成"半边，另半边是 `lib/validate.js`）。
 *
 * 三条设计红线：
 *   1. **默认不联网**：只有调用方显式传 `withLlm: true`（或配置 `llm.enabled: true`）时才会走到这里，
 *      确定性报告在任何情况下都不依赖 LLM；
 *   2. **不可用即降级**：宿主没挂 `llm`、没有默认模型、模型调用失败、超出预算——
 *      一律返回可判定的失败，调用方必须回退到确定性输出，绝不抛给用户；
 *   3. **宿主契约容错**：DSH 的 `RequestMessage` 形态在不同版本间有过变化，
 *      这里对请求形态与流式分片都做兼容读取，避免因为一次宿主升级把插件打挂。
 *
 * @module dsh-project-compass/llm
 */

import { clip } from './util.js'

/** 单次 LLM 调用的错误码（调用方按码降级，不要靠字符串匹配）。 */
export const LLM_ERROR = {
  UNAVAILABLE: 'LLM_UNAVAILABLE',
  BUDGET: 'LLM_BUDGET_EXCEEDED',
  TIMEOUT: 'LLM_TIMEOUT',
  FAILED: 'LLM_FAILED',
}

/** 构造一个带错误码的 LLM 错误。 */
export function llmError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 创建一个 LLM 客户端。
 * @param ctx 插件上下文（可为 undefined——测试与 CLI 场景没有宿主）。
 * @param config `{ enabled, provider, model, maxCalls, maxTokens, timeoutMs, reasoningEffort }`。
 * @returns LlmClient
 */
export function createLlmClient(ctx, config = {}) {
  const maxCalls = Number.isFinite(config.maxCalls) ? Math.max(0, Math.trunc(config.maxCalls)) : 12
  const defaultMaxTokens = Number.isFinite(config.maxTokens) ? Math.max(64, Math.trunc(config.maxTokens)) : 1200
  const timeoutMs = Number.isFinite(config.timeoutMs) ? Math.max(1000, Math.trunc(config.timeoutMs)) : 60000
  const enabled = config.enabled !== false
  let calls = 0
  let tokensIn = 0
  let tokensOut = 0

  /** 读取宿主服务（`ctx.get` 优先，兼容直接属性访问）。 */
  const service = (name) => {
    if (ctx === undefined || ctx === null) return undefined
    try {
      if (typeof ctx.get === 'function') {
        const found = ctx.get(name)
        if (found !== undefined && found !== null) return found
      }
    } catch {
      // 组合未挂载该服务：继续走属性兜底
    }
    const direct = ctx[name]
    return direct === undefined || direct === null ? undefined : direct
  }

  /** 解析 provider/model：显式配置优先，其次会话默认模型。 */
  function resolveRoute() {
    const explicitProvider = typeof config.provider === 'string' && config.provider.length > 0 ? config.provider : null
    const explicitModel = typeof config.model === 'string' && config.model.length > 0 ? config.model : null
    if (explicitProvider !== null && explicitModel !== null) {
      return { provider: explicitProvider, model: explicitModel, reasoningEffort: config.reasoningEffort ?? undefined, source: 'config' }
    }
    const selectionService = service('agentDefaultModel')
    let selection
    try {
      selection = typeof selectionService?.currentSelection === 'function' ? selectionService.currentSelection() : undefined
    } catch {
      selection = undefined
    }
    if (selection !== undefined && selection !== null) {
      const provider = explicitProvider ?? pickString(selection.provider, selection.model?.provider, selection.route?.provider)
      const model = explicitModel ?? pickString(
        typeof selection.model === 'string' ? selection.model : undefined,
        selection.model?.id,
        selection.modelId,
        selection.route?.model,
      )
      if (provider !== null && model !== null) {
        return {
          provider,
          model,
          reasoningEffort: config.reasoningEffort ?? selection.reasoningEffort ?? undefined,
          source: 'session-default',
        }
      }
    }
    return null
  }

  function describe() {
    if (!enabled) return { available: false, provider: null, model: null, reason: '配置中已关闭 LLM（llm.enabled=false）' }
    const llm = service('llm')
    if (llm === undefined || typeof llm.stream !== 'function') return { available: false, provider: null, model: null, reason: '宿主未挂载 llm 服务' }
    const route = resolveRoute()
    if (route === null) return { available: false, provider: null, model: null, reason: '无法确定 provider/model（既未配置，也没有会话默认模型）' }
    if (calls >= maxCalls) return { available: false, provider: route.provider, model: route.model, reason: `已达到本次运行的 LLM 调用上限（${maxCalls}）` }
    return { available: true, provider: route.provider, model: route.model, reason: route.source === 'config' ? '使用插件配置的模型' : '使用会话默认模型' }
  }

  return {
    available() {
      return describe().available
    },
    describe,
    stats() {
      return { calls, maxCalls, inputTokens: tokensIn, outputTokens: tokensOut }
    },

    /**
     * 单轮补全。失败抛带 `code` 的错误——调用方**必须**捕获并降级。
     * @param request.system 系统提示词。
     * @param request.prompt 用户提示词。
     * @param request.maxTokens 覆盖默认上限。
     * @param request.temperature 采样温度。
     * @param request.signal 外部取消信号。
     */
    async complete(request = {}) {
      const status = describe()
      if (!status.available) throw llmError(LLM_ERROR.UNAVAILABLE, status.reason)
      const llm = service('llm')
      const route = resolveRoute()
      if (route === null) throw llmError(LLM_ERROR.UNAVAILABLE, '无法确定 provider/model')

      const started = Date.now()
      calls += 1
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const onAbort = () => controller.abort()
      if (request.signal !== undefined) {
        if (request.signal.aborted) controller.abort()
        else request.signal.addEventListener('abort', onAbort, { once: true })
      }

      const options = {
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        system: request.system,
        maxTokens: Number.isFinite(request.maxTokens) ? Math.trunc(request.maxTokens) : defaultMaxTokens,
        messages: [{ role: 'user', content: [{ type: 'text', text: String(request.prompt ?? '') }] }],
        signal: controller.signal,
      }
      if (Number.isFinite(request.temperature)) options.temperature = request.temperature

      try {
        const collected = await collectStream(llm, options)
        tokensIn += collected.usage?.inputTokens ?? 0
        tokensOut += collected.usage?.outputTokens ?? 0
        if (collected.text.trim().length === 0) throw llmError(LLM_ERROR.FAILED, '模型返回了空内容')
        return {
          text: collected.text,
          provider: route.provider,
          model: route.model,
          usage: collected.usage ?? null,
          finishReason: collected.finishReason ?? null,
          elapsedMs: Date.now() - started,
          source: route.source,
        }
      } catch (error) {
        if (controller.signal.aborted && !(request.signal?.aborted ?? false)) {
          throw llmError(LLM_ERROR.TIMEOUT, `模型调用超时（${timeoutMs}ms）`)
        }
        if (error?.code !== undefined) throw error
        throw llmError(LLM_ERROR.FAILED, `模型调用失败：${clip(error instanceof Error ? error.message : String(error), 300)}`)
      } finally {
        clearTimeout(timer)
        if (request.signal !== undefined) request.signal.removeEventListener?.('abort', onAbort)
      }
    },
  }
}

/** 取第一个非空字符串。 */
function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * 消费宿主的流式分片：汇总文本、用量与结束原因。
 * 兼容两种文本载体（`text-delta` 增量和 `block-end` 里带 text 的块）。
 */
async function collectStream(llm, options) {
  let text = ''
  let usage = null
  let finishReason = null
  const iterate = () => {
    try {
      return llm.stream(options)
    } catch (error) {
      // 部分版本对 messages 形态更严格：退化为纯字符串 content 再试一次
      if (!/content|message|schema|invalid/i.test(String(error?.message ?? ''))) throw error
      const fallback = { ...options, messages: [{ role: 'user', content: String(options.messages[0].content[0].text) }] }
      return llm.stream(fallback)
    }
  }
  for await (const chunk of iterate()) {
    if (chunk === undefined || chunk === null) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') text += chunk.block.text
    else if (chunk.type === 'usage') usage = chunk.usage ?? usage
    else if (chunk.type === 'finish') {
      finishReason = chunk.reason?.kind ?? null
      if (chunk.reason?.kind === 'error') {
        throw llmError(LLM_ERROR.FAILED, `模型返回错误：${clip(chunk.reason.failure?.message ?? '未知原因', 300)}`)
      }
      if (chunk.reason?.kind === 'aborted') {
        throw llmError(LLM_ERROR.TIMEOUT, '模型调用被中断')
      }
    }
  }
  return { text, usage, finishReason }
}

/**
 * 从模型输出里抠出 JSON（容忍 ```json 围栏、前后废话、尾随逗号）。
 * 解析失败返回 undefined——调用方据此降级，不要猜。
 * @param text 模型原始输出。
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) return undefined
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = []
  if (fenced !== null) candidates.push(fenced[1])
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  const firstBracket = raw.indexOf('[')
  const lastBracket = raw.lastIndexOf(']')
  const braceSlice = firstBrace >= 0 && lastBrace > firstBrace ? raw.slice(firstBrace, lastBrace + 1) : null
  const bracketSlice = firstBracket >= 0 && lastBracket > firstBracket ? raw.slice(firstBracket, lastBracket + 1) : null
  // 哪个开括号先出现就先试哪个，否则 `[{...}]` 会被误解析成内层对象
  if (bracketSlice !== null && (braceSlice === null || firstBracket < firstBrace)) {
    if (bracketSlice !== null) candidates.push(bracketSlice)
    if (braceSlice !== null) candidates.push(braceSlice)
  } else {
    if (braceSlice !== null) candidates.push(braceSlice)
    if (bracketSlice !== null) candidates.push(bracketSlice)
  }
  candidates.push(raw)
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue
    const attempt = String(candidate).trim()
    if (attempt.length === 0) continue
    try {
      return JSON.parse(attempt)
    } catch {
      const repaired = attempt.replace(/,\s*([}\]])/g, '$1')
      try {
        return JSON.parse(repaired)
      } catch {
        // 换一种候选继续
      }
    }
  }
  return undefined
}
