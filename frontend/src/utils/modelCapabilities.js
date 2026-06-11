/**
 * 模型能力表 - 按模型类型定义支持的宽高比、分辨率、数量等参数
 * 用于前端动态过滤参数下拉框，避免用户选到模型不支持的值
 *
 * 使用方式:
 *   import { getModelCapabilities } from '../utils/modelCapabilities'
 *   const caps = getModelCapabilities('gpt-image-2')
 *   caps.aspectRatios  // ['1:1', '3:2', '2:3']
 */

// Gemini 协议支持的全部宽高比（最宽松的模型）
const GEMINI_ASPECT_RATIOS = [
  '1:1', '4:3', '3:2', '16:9', '21:9', '2:1', '4:1', '8:1',
  '4:5', '3:4', '2:3', '9:16', '1:4', '1:8'
]

// OpenAI Images API（gpt-image-2 / dall-e-3）官方只支持 3 种尺寸
const OPENAI_IMAGES_ASPECT_RATIOS = ['1:1', '3:2', '2:3']

// 默认分辨率档位（大部分模型都支持）
const DEFAULT_RESOLUTIONS = ['1K', '2K', '4K']

/**
 * 根据模型名返回能力配置
 * @param {string} modelName - 模型名（如 'gemini-3.1-flash-image-preview' / 'gpt-image-2'）
 * @returns {{type, aspectRatios, resolutions, maxCount, displayName, note}}
 */
export function getModelCapabilities(modelName) {
  // 空值/未知 → 按 Gemini 最宽松配置（兼容老用户）
  if (!modelName) {
    return {
      type: 'gemini',
      aspectRatios: GEMINI_ASPECT_RATIOS,
      resolutions: DEFAULT_RESOLUTIONS,
      maxCount: 10,
      displayName: 'Gemini',
      note: ''
    }
  }

  const lower = modelName.toLowerCase()

  // OpenAI Images API（gpt-image-2 / dall-e-3）
  if (lower.startsWith('gpt-image') || lower.startsWith('codex-gpt-image') || lower.startsWith('dall-e')) {
    return {
      type: 'openai_images',
      aspectRatios: OPENAI_IMAGES_ASPECT_RATIOS,
      resolutions: DEFAULT_RESOLUTIONS,  // 1K=low / 2K=medium / 4K=high
      maxCount: 10,
      displayName: 'GPT Image',
      note: '官方只支持 1:1 / 3:2 / 2:3，分辨率对应 low/medium/high'
    }
  }

  // 默认 Gemini 协议（nano banana / gemini-3-pro / gemini-3.1-flash-image-preview 等）
  return {
    type: 'gemini',
    aspectRatios: GEMINI_ASPECT_RATIOS,
    resolutions: DEFAULT_RESOLUTIONS,
    maxCount: 10,
    displayName: 'Gemini',
    note: ''
  }
}

/**
 * 检查一个值是否在能力列表里，不在则返回第一个支持值作为 fallback
 */
export function ensureSupported(value, supportedList, fallback) {
  if (supportedList.includes(value)) return value
  return fallback || supportedList[0]
}
