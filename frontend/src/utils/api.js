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

export async function getFlowBridgeJob(jobId, params = {}) {
  try {
    const response = await axios.get(`${API_BASE_URL}/flow-bridge/jobs/${encodeURIComponent(jobId)}`, { params })
    return response.data
  } catch (error) {
    console.error('Flow Bridge 查询失败:', error)
    throw new Error(error.response?.data?.error || 'Flow Bridge 查询失败')
  }
}

export async function redownloadFlowImage(params) {
  try {
    const response = await axios.post(`${API_BASE_URL}/flow-bridge/redownload`, params)
    return response.data
  } catch (error) {
    console.error('Flow 高清下载提交失败:', error)
    throw new Error(error.response?.data?.error || 'Flow 高清下载提交失败')
  }
}

// 获取后端运行日志
export async function getRuntimeLogs(params = {}) {
  try {
    const response = await axios.get(`${API_BASE_URL}/runtime-logs`, { params })
    return response.data
  } catch (error) {
    console.error('获取后端日志失败:', error)
    return { success: false, logs: [], latest_id: 0 }
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
