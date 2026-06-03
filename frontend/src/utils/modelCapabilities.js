/**
 * 模型能力表 - 按模型类型定义支持的宽高比、分辨率、数量等参数
 * 用于前端动态过滤参数下拉框，避免用户选到模型不支持的值
 *
 * 使用方式:
 *   import { getModelCapabilities } from '../utils/modelCapabilities'
 *   const caps = getModelCapabilities('gpt-image-2')
 *   caps.aspectRatios  // ['1:1', '3:2', '2:3']
 */

// Gemini 3.1 Flash Image Preview 实测通过 suxi 网关支持的白名单（2026-04 探测）
// 官方文档列 14 种但 1:4/4:1/1:8/8:1/2:1 会 400，只保留稳定可用的 10 种
const GEMINI_ASPECT_RATIO_OPTIONS = [
  '1:1', '4:3', '3:2', '16:9', '21:9',
  '4:5', '3:4', '2:3', '9:16', '5:4'
].map(value => ({ value, label: value }))

const OPENAI_IMAGES_ASPECT_RATIO_OPTIONS = [
  { value: 'original', label: '原比例' },
  '1:1', '4:3', '3:2', '16:9', '21:9', '2:1', '3:1',
  '4:5', '3:4', '2:3', '9:16', '1:2', '1:3'
].map(option => typeof option === 'string' ? ({ value: option, label: option }) : option)

const GEMINI_RESOLUTION_OPTIONS = ['1K', '2K', '4K'].map(value => ({ value, label: value }))
const FLOW_ASPECT_RATIO_OPTIONS = [
  '16:9', '4:3', '1:1', '3:4', '9:16'
].map(value => ({ value, label: value }))
const FLOW_RESOLUTION_OPTIONS = [
  { value: 'flow-default', label: '默认' }
]

const OPENAI_LONG_EDGE_OPTIONS = [1024, 1536, 2048, 3072, 3840]
const OPENAI_MIN_PIXELS = 655360
const OPENAI_MAX_PIXELS = 8294400
const OPENAI_MAX_EDGE = 3840

function parseAspectRatio(value) {
  const text = String(value || '').trim()
  if (!text || text === 'original' || !text.includes(':')) return null
  const [w, h] = text.split(':').map(Number)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return { width: w, height: h, ratio: w / h }
}

function roundTo16(value) {
  return Math.max(16, Math.round(Number(value || 0) / 16) * 16)
}

function clampOpenAISize(width, height) {
  let nextWidth = roundTo16(width)
  let nextHeight = roundTo16(height)
  let scale = 1

  if (Math.max(nextWidth, nextHeight) > OPENAI_MAX_EDGE) {
    scale = Math.min(scale, OPENAI_MAX_EDGE / Math.max(nextWidth, nextHeight))
  }
  if (nextWidth * nextHeight > OPENAI_MAX_PIXELS) {
    scale = Math.min(scale, Math.sqrt(OPENAI_MAX_PIXELS / (nextWidth * nextHeight)))
  }
  if (scale < 1) {
    nextWidth = roundTo16(nextWidth * scale)
    nextHeight = roundTo16(nextHeight * scale)
  }

  if (nextWidth * nextHeight < OPENAI_MIN_PIXELS) {
    const grow = Math.sqrt(OPENAI_MIN_PIXELS / Math.max(1, nextWidth * nextHeight))
    nextWidth = roundTo16(nextWidth * grow)
    nextHeight = roundTo16(nextHeight * grow)
  }

  if (Math.max(nextWidth, nextHeight) > OPENAI_MAX_EDGE) {
    const shrink = OPENAI_MAX_EDGE / Math.max(nextWidth, nextHeight)
    nextWidth = roundTo16(nextWidth * shrink)
    nextHeight = roundTo16(nextHeight * shrink)
  }

  return {
    width: nextWidth,
    height: nextHeight,
  }
}

function buildOpenAISizeOption(aspectRatio, longEdge) {
  if (aspectRatio === 'original') {
    return {
      value: `original:${longEdge}`,
      label: `原比例 · 长边 ${longEdge}`,
    }
  }

  const ratio = parseAspectRatio(aspectRatio) || parseAspectRatio('1:1')
  const raw = ratio.ratio >= 1
    ? { width: longEdge, height: longEdge / ratio.ratio }
    : { width: longEdge * ratio.ratio, height: longEdge }
  const size = clampOpenAISize(raw.width, raw.height)

  return {
    value: `${size.width}x${size.height}`,
    label: `${size.width}×${size.height}`,
  }
}

function buildOpenAIResolutionOptions(aspectRatio) {
  const base = OPENAI_LONG_EDGE_OPTIONS.map(longEdge => buildOpenAISizeOption(aspectRatio, longEdge))
  if (aspectRatio === 'original') {
    return [{ value: 'original:max', label: '原比例 · 最大' }, ...base]
  }
  return base
}

function inferOpenAIDefaultSize(aspectRatio) {
  if (aspectRatio === 'original') return 'original:max'
  const options = buildOpenAIResolutionOptions(aspectRatio)
  return options[2]?.value || options[0]?.value || '1024x1024'
}

function buildOpenAIAspectRatioOptions(hasReferenceImage) {
  if (hasReferenceImage) return OPENAI_IMAGES_ASPECT_RATIO_OPTIONS
  return OPENAI_IMAGES_ASPECT_RATIO_OPTIONS.filter(option => option.value !== 'original')
}

const MODEL_LABELS = {
  'codex-gpt-image-2': 'GPT Image 2 (Codex)',
  'gpt-image-2': 'GPT Image 2',
  'gpt-image-1': 'GPT Image 1',
  'dall-e-3': 'DALL·E 3',
  'gemini-3.1-flash-image-preview': 'Gemini 3.1 Flash Image',
  'gemini-3-pro-image-preview': 'Gemini 3 Pro Image',
  'flow-web-image': 'Flow Web Automator',
  'gpt-5.4-mini': 'GPT-5.4 mini (chat-image)',
  'gpt-5.4': 'GPT-5.4 (chat-image)',
  'gpt-5.5': 'GPT-5.5 (chat-image)',
  'gpt-4o': 'GPT-4o (chat-image)',
  'gpt-5.4-openai-compact': 'GPT-5.4 OpenAI Compact (chat-image)',
  'gpt-5.5-openai-compact': 'GPT-5.5 OpenAI Compact (chat-image)',
  'gpt-5.3-codex-openai-compact': 'GPT-5.3 Codex Compact (chat-image)'
}

function buildCapabilities({
  type,
  displayName,
  aspectRatioOptions,
  resolutionOptions,
  requestField = 'resolution',
  resolutionLabel,
  note,
  maxCount = 10,
  defaultAspectRatio = '1:1',
  defaultResolution,
}) {
  return {
    type,
    displayName,
    aspectRatioOptions,
    resolutionOptions,
    aspectRatios: aspectRatioOptions.map(option => option.value),
    resolutions: resolutionOptions.map(option => option.value),
    requestField,
    resolutionLabel,
    note,
    maxCount,
    defaultAspectRatio,
    defaultResolution: defaultResolution || (resolutionOptions[0] ? resolutionOptions[0].value : ''),
  }
}

export function getModelDisplayName(modelName) {
  if (!modelName) return '未配置模型'
  return MODEL_LABELS[modelName] || modelName
}

/**
 * 根据模型名返回能力配置
 * @param {string} modelName - 模型名（如 'gemini-3.1-flash-image-preview' / 'gpt-image-2'）
 * @returns {{type, aspectRatios, resolutions, maxCount, displayName, note}}
 */
export function getModelCapabilities(modelName, options = {}) {
  const {
    aspectRatio = '1:1',
    hasReferenceImage = false,
  } = options

  // 空值/未知 → 按 Gemini 最宽松配置（兼容老用户）
  if (!modelName) {
    return buildCapabilities({
      type: 'gemini',
      displayName: 'Gemini',
      aspectRatioOptions: GEMINI_ASPECT_RATIO_OPTIONS,
      resolutionOptions: GEMINI_RESOLUTION_OPTIONS,
      resolutionLabel: '规格',
      note: '',
      defaultAspectRatio: '1:1',
      defaultResolution: '2K'
    })
  }

  const lower = modelName.toLowerCase()

  if (lower.startsWith('flow-web') || lower.startsWith('flow_web')) {
    return buildCapabilities({
      type: 'flow_web',
      displayName: getModelDisplayName(modelName),
      aspectRatioOptions: FLOW_ASPECT_RATIO_OPTIONS,
      resolutionOptions: FLOW_RESOLUTION_OPTIONS,
      resolutionLabel: '尺寸',
      note: 'Flow 图片模式当前不暴露 2K/4K 尺寸选择，实际输出由 Flow 页面和账号权益决定',
      maxCount: 4,
      defaultAspectRatio: '16:9',
      defaultResolution: 'flow-default'
    })
  }

  // OpenAI Images API（gpt-image-2 / dall-e-3）
  if (lower.startsWith('gpt-image') || lower.startsWith('dall-e') || lower.startsWith('codex-gpt-image')) {
    const aspectRatioOptions = buildOpenAIAspectRatioOptions(hasReferenceImage)
    const supportedAspectRatios = aspectRatioOptions.map(option => option.value)
    const effectiveAspectRatio = supportedAspectRatios.includes(aspectRatio) ? aspectRatio : '1:1'
    const resolutionOptions = buildOpenAIResolutionOptions(effectiveAspectRatio)

    return buildCapabilities({
      type: 'openai_images',
      displayName: getModelDisplayName(modelName),
      aspectRatioOptions,
      resolutionOptions,
      requestField: 'size',
      resolutionLabel: '尺寸',
      note: '长边≤3840，宽高为16倍数，总像素在 655,360 到 8,294,400 之间，支持原比例锁定',
      defaultAspectRatio: '1:1',
      defaultResolution: inferOpenAIDefaultSize(effectiveAspectRatio)
    })
  }

  // Chat-based 图像生成（gpt-5.x / gpt-4o / gpt-4.1 多模态模型，走 /v1/chat/completions）
  // 复用 OpenAI 风格的 aspect/size 选项，支持原比例；chat 接口无 size 参数，
  // 后端将 size 作为 prompt hint 传递，实际尺寸由模型决定（1024² / 1536×1024 / 1024×1536）
  if (lower.startsWith('gpt-5') || lower.startsWith('gpt-4o') || lower.startsWith('gpt-4.1')) {
    const aspectRatioOptions = buildOpenAIAspectRatioOptions(hasReferenceImage)
    const supportedAspectRatios = aspectRatioOptions.map(option => option.value)
    const effectiveAspectRatio = supportedAspectRatios.includes(aspectRatio) ? aspectRatio : '1:1'
    const resolutionOptions = buildOpenAIResolutionOptions(effectiveAspectRatio)

    return buildCapabilities({
      type: 'chat_image',
      displayName: getModelDisplayName(modelName),
      aspectRatioOptions,
      resolutionOptions,
      requestField: 'size',
      resolutionLabel: '尺寸提示',
      note: 'Chat-based 出图：size 作为 prompt hint，实际尺寸由模型决定（常见 1024² / 1536×1024 / 1024×1536）；原比例锁定推荐图生图使用',
      maxCount: 1,
      defaultAspectRatio: '1:1',
      defaultResolution: inferOpenAIDefaultSize(effectiveAspectRatio)
    })
  }

  // 默认 Gemini 协议（nano banana / gemini-3-pro / gemini-3.1-flash-image-preview 等）
  return buildCapabilities({
    type: 'gemini',
    displayName: getModelDisplayName(modelName),
    aspectRatioOptions: GEMINI_ASPECT_RATIO_OPTIONS,
    resolutionOptions: GEMINI_RESOLUTION_OPTIONS,
    resolutionLabel: '规格',
    note: '',
    defaultAspectRatio: '1:1',
    defaultResolution: '2K'
  })
}

/**
 * 检查一个值是否在能力列表里，不在则返回第一个支持值作为 fallback
 */
export function ensureSupported(value, supportedList, fallback) {
  if (supportedList.includes(value)) return value
  return fallback || supportedList[0]
}
