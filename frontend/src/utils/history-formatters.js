// 生成历史面板的公共格式化工具
// 所有渲染逻辑（卡片、列表、详情）统一复用这里的函数
// 相关 spec：.kiro/specs/generation-history-unified-panel/design.md

// 来源 → emoji 映射（未知来源用 ❓）
export const SOURCE_EMOJI = {
  canvas: '🎨',
  eagle_plugin: '🦅',
  script: '🔧',
  unknown: '❓'
}

// 生成模式 → 中文标签映射
export const MODE_LABEL = {
  text2img: '文生图',
  img2img: '图生图'
}

// 截断 prompt 预览，超长加省略号
// prompt 可能为 null / undefined / 非字符串，统一兜底返回 ''
export function formatPromptPreview(prompt, maxLen = 80) {
  if (prompt == null) return ''
  const str = typeof prompt === 'string' ? prompt : String(prompt)
  if (!Number.isFinite(maxLen) || maxLen <= 0) return str
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '…'
}

// 格式化耗时（秒）
// < 60s     → "12.3s"
// < 3600s   → "1m 02s"
// >= 3600s  → "1h 05m"
export function formatElapsed(sec) {
  const s = Number(sec)
  if (!Number.isFinite(s) || s < 0) return '-'
  if (s < 60) {
    // 保留一位小数，整数时也强制显示 .0 以保持风格统一
    return `${s.toFixed(1)}s`
  }
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const rem = Math.floor(s % 60)
    return `${m}m ${String(rem).padStart(2, '0')}s`
  }
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}h ${String(m).padStart(2, '0')}m`
}

// 格式化 ISO 8601 时间戳为本地时区 "YYYY-MM-DD HH:mm"
// 解析失败时原样返回
export function formatTimestamp(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const pad = (n) => String(n).padStart(2, '0')
  const y = d.getFullYear()
  const M = pad(d.getMonth() + 1)
  const D = pad(d.getDate())
  const h = pad(d.getHours())
  const m = pad(d.getMinutes())
  return `${y}-${M}-${D} ${h}:${m}`
}

// 是否展示 "在 Eagle 中打开" 深链
// 规则：记录来自本机 && eagle_item_ids 非空
// 跨机记录即使有 item_ids，也无法在本机 Eagle 里打开，所以不给深链
export function shouldShowEagleLink(record, localMachineId) {
  if (!record || !localMachineId) return false
  if (record.machine_id !== localMachineId) return false
  const ids = Array.isArray(record.eagle_item_ids) ? record.eagle_item_ids : []
  return ids.length > 0
}

// 构造 Eagle 客户端深链
// 形如 eagle://item/{id}
export function buildEagleDeepLink(itemId) {
  if (itemId == null || itemId === '') return ''
  return `eagle://item/${encodeURIComponent(itemId)}`
}
