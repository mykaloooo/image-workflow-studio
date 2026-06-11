import axios from 'axios'

// 使用相对路径，兼容开发模式和 Flask 服务模式
const API_BASE_URL = '/api';

// 初始化 API
export async function initializeAPI(apiKey, proxyUrl, outputDir) {
  try {
    const response = await axios.post(`${API_BASE_URL}/init`, {
      api_key: apiKey,
      proxy_url: proxyUrl || null,
      output_dir: outputDir || null
    })
    return response.data
  } catch (error) {
    console.error('初始化失败:', error)
    throw new Error(error.response?.data?.error || '初始化失败')
  }
}

// 生成图片
export async function generateImage(params) {
  try {
    const response = await axios.post(`${API_BASE_URL}/generate`, params)
    return response.data
  } catch (error) {
    console.error('生成失败:', error)
    throw new Error(error.response?.data?.error || '生成失败')
  }
}

// 健康检查
export async function healthCheck() {
  try {
    const response = await axios.get(`${API_BASE_URL}/health`)
    return response.data
  } catch (error) {
    console.error('健康检查失败:', error)
    return { status: 'error' }
  }
}

// 导出项目
export async function exportProject(projectName, nodes, edges) {
  try {
    const response = await axios.post(`${API_BASE_URL}/export`, {
      project_name: projectName,
      nodes: nodes,
      edges: edges
    })
    return response.data
  } catch (error) {
    console.error('导出失败:', error)
    throw new Error(error.response?.data?.error || '导出失败')
  }
}

// 导入项目
export async function importProject(file) {
  try {
    const formData = new FormData()
    formData.append('file', file)

    const response = await axios.post(`${API_BASE_URL}/import`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    })
    return response.data
  } catch (error) {
    console.error('导入失败:', error)
    throw new Error(error.response?.data?.error || '导入失败')
  }
}

// v2新功能：上传图片到后端
export async function uploadImage(file) {
  try {
    const formData = new FormData()
    formData.append('file', file)

    const response = await axios.post(`${API_BASE_URL}/upload-image`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    })
    return response.data
  } catch (error) {
    console.error('上传失败:', error)
    throw new Error(error.response?.data?.error || '上传失败')
  }
}

// 获取系统配置
export async function getSystemConfig() {
  try {
    const response = await axios.get(`${API_BASE_URL}/system-config`)
    return response.data
  } catch (error) {
    console.error('获取配置失败:', error)
    return { success: false, configured: false }
  }
}

// 更新系统配置
export async function updateSystemConfig(config) {
  try {
    const response = await axios.post(`${API_BASE_URL}/system-config`, config)
    return response.data
  } catch (error) {
    console.error('更新配置失败:', error)
    throw new Error(error.response?.data?.error || '更新配置失败')
  }
}

// 自动初始化（使用已保存的配置）
export async function autoInit() {
  try {
    const response = await axios.post(`${API_BASE_URL}/auto-init`)
    return response.data
  } catch (error) {
    console.error('自动初始化失败:', error)
    return { success: false, needSetup: true }
  }
}

// AI 对话
export async function chatWithAI(params) {
  try {
    const response = await axios.post(`${API_BASE_URL}/chat`, params)
    return response.data
  } catch (error) {
    console.error('对话失败:', error)
    return {
      success: false,
      error: error.response?.data?.error || '对话API未配置，请在系统设置中配置对话模型'
    }
  }
}

// 生成视频 (旧接口，保留兼容)
export async function generateVideo(params) {
  try {
    const response = await axios.post(`${API_BASE_URL}/generate-video`, params, {
      timeout: 600000
    })
    return response.data
  } catch (error) {
    console.error('视频生成失败:', error)
    throw new Error(error.response?.data?.error || '视频生成失败')
  }
}

// 创建视频任务 (异步，返回任务ID)
export async function createVideoTask(params) {
  try {
    console.log('📤 createVideoTask 调用参数:', params)
    const response = await axios.post(`${API_BASE_URL}/video/create`, params)
    console.log('📤 createVideoTask 响应:', response.data)
    return response.data
  } catch (error) {
    console.error('创建视频任务失败:', error)
    console.error('错误响应:', error.response?.data)
    
    // 确保错误信息是字符串
    const errorMsg = error.response?.data?.error || '创建视频任务失败'
    
    // 如果错误信息是对象，转换为 JSON 字符串
    const errorMessage = typeof errorMsg === 'object' 
      ? JSON.stringify(errorMsg)
      : errorMsg
    
    console.error('最终错误信息:', errorMessage)
    throw new Error(errorMessage)
  }
}

// 查询视频任务状态
export async function getVideoTaskStatus(taskId) {
  try {
    console.log('🔍 getVideoTaskStatus 查询任务:', taskId)
    const response = await axios.get(`${API_BASE_URL}/video/status/${taskId}`)
    console.log('📤 getVideoTaskStatus 响应:', response.data)
    return response.data
  } catch (error) {
    console.error('查询视频状态失败:', error)
    console.error('错误响应:', error.response?.data)
    
    // 确保错误信息是字符串
    const errorMsg = error.response?.data?.error || '查询失败'
    const errorMessage = typeof errorMsg === 'object'
      ? JSON.stringify(errorMsg)
      : errorMsg
    
    console.error('最终错误信息:', errorMessage)
    return { success: false, status: 'error', error: errorMessage }
  }
}

// 下载视频到本地
export async function downloadVideo(taskId) {
  try {
    const response = await axios.post(`${API_BASE_URL}/video/download`, { task_id: taskId })
    return response.data
  } catch (error) {
    console.error('下载视频失败:', error)
    throw new Error(error.response?.data?.error || '下载视频失败')
  }
}

// 获取智能体预设
export async function getAgentPresets() {
  try {
    const response = await axios.get(`${API_BASE_URL}/agent-presets`)
    return response.data
  } catch (error) {
    console.error('获取预设失败:', error)
    return { success: false, presets: {} }
  }
}

// 保存智能体预设
export async function saveAgentPresets(presets) {
  try {
    const response = await axios.post(`${API_BASE_URL}/agent-presets`, { presets })
    return response.data
  } catch (error) {
    console.error('保存预设失败:', error)
    return { success: false, error: error.message }
  }
}

// ============ 提示词模板 API ============

export async function getPromptTemplates() {
  try {
    const response = await axios.get(`${API_BASE_URL}/prompt-templates`)
    return response.data
  } catch (error) {
    console.error('获取提示词模板失败:', error)
    return { success: false, groups: [], templates: [] }
  }
}

export async function savePromptTemplates(data) {
  try {
    const response = await axios.post(`${API_BASE_URL}/prompt-templates`, data)
    return response.data
  } catch (error) {
    console.error('保存提示词模板失败:', error)
    return { success: false, error: error.message }
  }
}

export async function upsertPromptTemplate(template) {
  try {
    const response = await axios.post(`${API_BASE_URL}/prompt-templates/template`, template)
    return response.data
  } catch (error) {
    console.error('保存模板失败:', error)
    return { success: false, error: error.message }
  }
}

export async function deletePromptTemplate(templateId) {
  try {
    const response = await axios.delete(`${API_BASE_URL}/prompt-templates/template/${templateId}`)
    return response.data
  } catch (error) {
    console.error('删除模板失败:', error)
    return { success: false, error: error.message }
  }
}

export async function upsertPromptGroup(group) {
  try {
    const response = await axios.post(`${API_BASE_URL}/prompt-templates/group`, group)
    return response.data
  } catch (error) {
    console.error('保存分组失败:', error)
    return { success: false, error: error.message }
  }
}

export async function deletePromptGroup(groupId) {
  try {
    const response = await axios.delete(`${API_BASE_URL}/prompt-templates/group/${groupId}`)
    return response.data
  } catch (error) {
    console.error('删除分组失败:', error)
    return { success: false, error: error.message }
  }
}

// ============ 生图历史 API ============

/**
 * 把 axios 错误包装成带 HTTP 状态和 reason 的 Error
 * - err.status : HTTP 状态码（无响应时为 null）
 * - err.reason : 后端返回的 error 字段 / 原始错误消息 / fallback
 * - err.warnings : 后端可能附带的 warnings（例如 /api/history 的行解析告警）
 * 调用方只看 error.message 的保持兼容；需要细分 404/422/timeout 的用 err.status
 */
function _wrapHistoryError(error, fallbackMessage) {
  const status = error.response?.status ?? null
  const data = error.response?.data || {}
  const reason = data.error || data.reason || error.message || fallbackMessage
  const message = status ? `[${status}] ${reason}` : reason
  const err = new Error(message)
  err.status = status
  err.reason = reason
  err.warnings = data.warnings || null
  return err
}

/**
 * 构建 URL 查询串，过滤掉 undefined/null/空字符串/空数组
 * 数组参数按后端约定用逗号拼（source/provider_id/canvas_save_state 多选）
 */
function _buildQuery(params) {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      sp.append(key, value.join(','))
    } else {
      sp.append(key, String(value))
    }
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

// 查询历史记录列表（支持 source/mode/provider_id/canvas_save_state/date_from/date_to/keyword/batch_id/limit/offset）
export async function getHistory(params = {}) {
  try {
    const qs = _buildQuery(params)
    const response = await axios.get(`${API_BASE_URL}/history${qs}`)
    return response.data
  } catch (error) {
    console.error('获取历史记录失败:', error)
    throw _wrapHistoryError(error, '获取历史记录失败')
  }
}

// 获取历史面板配置（machine_id / peer_machines / history_store_path / history_store_max_mb）
export async function getHistoryConfig() {
  try {
    const response = await axios.get(`${API_BASE_URL}/history/config`)
    return response.data
  } catch (error) {
    console.error('获取历史配置失败:', error)
    throw _wrapHistoryError(error, '获取历史配置失败')
  }
}

// 局部更新一条历史记录（canvas_save_state / eagle_item_ids / output_files）
export async function patchHistoryRecord(id, patch) {
  try {
    const response = await axios.patch(
      `${API_BASE_URL}/history/${encodeURIComponent(id)}`,
      patch
    )
    return response.data
  } catch (error) {
    console.error('更新历史记录失败:', error)
    throw _wrapHistoryError(error, '更新历史记录失败')
  }
}

/**
 * 构建缩略图 URL（支持跨机 base_url）
 * - baseUrl: null/undefined/'' → 本机（相对路径 /api/history/thumbnail...）
 * - baseUrl: 'http://192.168.110.120:5001' → 跨机绝对 URL
 * 注意：不复用 API_BASE_URL 常量，这里必须显式拼 /api/history/thumbnail
 * 才能正确支持"本机相对 + 远端绝对"两种形态
 */
export function buildThumbnailUrl(baseUrl, recordId, index = 0) {
  const base = baseUrl || ''
  const qs = `record_id=${encodeURIComponent(recordId)}&index=${index}`
  return `${base}/api/history/thumbnail?${qs}`
}
