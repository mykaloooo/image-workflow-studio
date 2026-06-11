import React, { useState, useEffect, useCallback } from 'react'
import { getAgentPresets, saveAgentPresets } from '../utils/api'

// 默认预设（内置）
const defaultPresets = {
  default: {
    name: '通用助手',
    icon: '🤖',
    systemPrompt: '你是一个专业的AI助手，帮助用户完成各种任务。',
    builtin: true
  },
  director: {
    name: '导演思维',
    icon: '🎬',
    systemPrompt: '你是一位经验丰富的电影导演。从导演的视角分析场景构图、叙事节奏、情感表达。关注画面的戏剧张力、角色位置、光影氛围。给出专业的镜头语言建议。',
    builtin: true
  },
  photographer: {
    name: '摄影师视角',
    icon: '📷',
    systemPrompt: '你是一位专业摄影师。从摄影的角度分析构图、光线、色彩、景深。关注黄金分割、引导线、对比度、色温。给出技术性的拍摄建议和后期调整方案。',
    builtin: true
  },
  screenwriter: {
    name: '编剧创意',
    icon: '✍️',
    systemPrompt: '你是一位富有创意的编剧。擅长构思故事情节、角色背景、场景描述。能够为图片创作背景故事，设计角色对话，构建情感冲突。',
    builtin: true
  },
  promptOptimizer: {
    name: '提示词优化',
    icon: '✨',
    systemPrompt: '你是一位AI绘画提示词专家。擅长将用户的想法转化为高质量的图片生成提示词。了解Midjourney、Stable Diffusion、DALL-E等模型的提示词技巧。输出结构化的英文提示词。',
    builtin: true
  },
  artCritic: {
    name: '艺术评论',
    icon: '🎨',
    systemPrompt: '你是一位专业的艺术评论家。能够从艺术史、美学理论、文化背景的角度分析作品。关注艺术风格、流派传承、创作手法、象征意义。',
    builtin: true
  }
}

// 可选图标
const iconOptions = [
  '🤖', '🎬', '📷', '✍️', '✨', '🎨', '🌈', '📐', '🎭', '🏠',
  '💡', '🔮', '🎯', '📚', '🧠', '💭', '🎪', '🌟', '🔥', '⚡',
  '🎹', '🎸', '🎺', '🎻', '🥁', '🎤', '📝', '🖼️', '🗿', '🌸'
]

function AgentManager({ onClose }) {
  const [presets, setPresets] = useState({})
  const [deletedBuiltins, setDeletedBuiltins] = useState([])  // 记录已删除的内置预设
  const [editingKey, setEditingKey] = useState(null)
  const [editForm, setEditForm] = useState({ name: '', icon: '🤖', systemPrompt: '' })
  const [isCreating, setIsCreating] = useState(false)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [testPrompt, setTestPrompt] = useState('')
  const [testResponse, setTestResponse] = useState('')
  const [isTesting, setIsTesting] = useState(false)

  // 加载预设
  useEffect(() => {
    loadPresets()
  }, [])

  const loadPresets = async () => {
    setLoading(true)
    try {
      const result = await getAgentPresets()
      if (result.success && result.presets) {
        // 获取已删除的内置预设列表
        const deletedBuiltinsList = result.presets._deletedBuiltins || []
        setDeletedBuiltins(deletedBuiltinsList)

        // 过滤掉已删除的内置预设
        const filteredDefaults = {}
        Object.entries(defaultPresets).forEach(([key, preset]) => {
          if (!deletedBuiltinsList.includes(key)) {
            filteredDefaults[key] = preset
          }
        })

        // 合并默认预设和自定义预设（自定义优先覆盖默认）
        const customPresets = { ...result.presets }
        delete customPresets._deletedBuiltins  // 移除特殊字段

        setPresets({ ...filteredDefaults, ...customPresets })
      } else {
        setPresets(defaultPresets)
      }
    } catch (error) {
      console.error('加载预设失败:', error)
      setPresets(defaultPresets)
    }
    setLoading(false)
  }

  // 保存预设
  const handleSave = async () => {
    try {
      // 如果正在创建/编辑，先保存当前内容
      let newPresets = { ...presets }

      if ((isCreating || editingKey) && editForm.name.trim() && editForm.systemPrompt.trim()) {
        if (isCreating) {
          const key = `custom_${Date.now()}`
          newPresets[key] = {
            name: editForm.name,
            icon: editForm.icon,
            systemPrompt: editForm.systemPrompt,
            builtin: false
          }
        } else if (editingKey) {
          newPresets[editingKey] = {
            name: editForm.name,
            icon: editForm.icon,
            systemPrompt: editForm.systemPrompt,
            builtin: false
          }
        }

        setPresets(newPresets)
        setEditingKey(null)
        setIsCreating(false)
      }

      // 保存所有非内置的预设 + 已删除的内置预设列表
      const customPresets = {}
      Object.entries(newPresets).forEach(([key, preset]) => {
        if (!preset.builtin) {
          customPresets[key] = {
            name: preset.name,
            icon: preset.icon,
            systemPrompt: preset.systemPrompt
          }
        }
      })

      // 添加已删除的内置预设列表
      if (deletedBuiltins.length > 0) {
        customPresets._deletedBuiltins = deletedBuiltins
      }

      const result = await saveAgentPresets(customPresets)
      if (result.success) {
        setMessage('✓ 预设已保存')
        setTimeout(() => setMessage(''), 2000)
      } else {
        setMessage('保存失败: ' + result.error)
      }
    } catch (error) {
      setMessage('保存失败: ' + error.message)
    }
  }

  // 开始编辑
  const handleEdit = (key) => {
    const preset = presets[key]
    setEditingKey(key)
    setEditForm({
      name: preset.name,
      icon: preset.icon,
      systemPrompt: preset.systemPrompt
    })
    setIsCreating(false)
    setTestResponse('')
  }

  // 开始创建新预设
  const handleCreate = () => {
    setIsCreating(true)
    setEditingKey(null)
    setEditForm({ name: '', icon: '🤖', systemPrompt: '' })
    setTestResponse('')
  }

  // 保存编辑 - 编辑后自动保存到后端
  const handleSaveEdit = async () => {
    if (!editForm.name.trim() || !editForm.systemPrompt.trim()) {
      setMessage('名称和提示词不能为空')
      return
    }

    let newPresets = { ...presets }

    if (isCreating) {
      // 创建新预设
      const key = `custom_${Date.now()}`
      newPresets[key] = {
        name: editForm.name,
        icon: editForm.icon,
        systemPrompt: editForm.systemPrompt,
        builtin: false
      }
    } else if (editingKey) {
      // 更新现有预设 - 统一标记为自定义
      newPresets[editingKey] = {
        name: editForm.name,
        icon: editForm.icon,
        systemPrompt: editForm.systemPrompt,
        builtin: false,
        customized: true
      }
    }

    setPresets(newPresets)

    // 自动保存到后端 - 保存所有非默认内置的预设
    try {
      const customPresets = {}
      Object.entries(newPresets).forEach(([key, preset]) => {
        // 保存所有 builtin=false 的预设（包括编辑过的内置预设）
        if (preset.builtin === false) {
          customPresets[key] = {
            name: preset.name,
            icon: preset.icon,
            systemPrompt: preset.systemPrompt
          }
        }
      })

      console.log('保存预设:', customPresets)  // 调试日志

      const result = await saveAgentPresets(customPresets)
      if (result.success) {
        setMessage('✓ 预设已保存')
      } else {
        setMessage('保存失败: ' + result.error)
      }
    } catch (error) {
      setMessage('保存失败: ' + error.message)
    }

    setEditingKey(null)
    setIsCreating(false)
    setTimeout(() => setMessage(''), 2000)
  }

  // 删除预设（包括内置预设）
  const handleDelete = async (key) => {
    const preset = presets[key]
    if (!confirm(`确定删除预设"${preset.name}"吗？`)) return

    // 如果是内置预设，添加到已删除列表
    if (preset.builtin) {
      setDeletedBuiltins(prev => [...prev, key])
    }

    setPresets(prev => {
      const newPresets = { ...prev }
      delete newPresets[key]
      return newPresets
    })

    // 立即保存到后端
    try {
      const customPresets = {}
      Object.entries(presets).forEach(([k, p]) => {
        if (k !== key && !p.builtin) {
          customPresets[k] = p
        }
      })

      // 保存已删除的内置预设列表
      const newDeletedBuiltins = preset.builtin
        ? [...deletedBuiltins, key]
        : deletedBuiltins
      customPresets._deletedBuiltins = newDeletedBuiltins

      await saveAgentPresets(customPresets)
      setMessage('✓ 预设已删除')
    } catch (error) {
      setMessage('删除失败: ' + error.message)
    }

    setTimeout(() => setMessage(''), 2000)
  }

  // 测试预设
  const handleTest = async () => {
    if (!testPrompt.trim()) {
      setMessage('请输入测试问题')
      return
    }

    setIsTesting(true)
    setTestResponse('')

    try {
      const { chatWithAI } = await import('../utils/api')
      const result = await chatWithAI({
        prompt: testPrompt,
        system_prompt: editForm.systemPrompt,
        reference_images: []
      })

      if (result.success) {
        setTestResponse(result.response)
      } else {
        setTestResponse(`错误: ${result.error}`)
      }
    } catch (error) {
      setTestResponse(`错误: ${error.message}`)
    }

    setIsTesting(false)
  }

  // 复制预设
  const handleDuplicate = (key) => {
    const preset = presets[key]
    const newKey = `custom_${Date.now()}`
    setPresets(prev => ({
      ...prev,
      [newKey]: {
        name: preset.name + ' (副本)',
        icon: preset.icon,
        systemPrompt: preset.systemPrompt,
        builtin: false
      }
    }))
    setMessage('✓ 已复制预设')
  }

  return (
    <div className="agent-manager-overlay">
      <div className="agent-manager-panel">
        <div className="agent-manager-header">
          <h2>🤖 智能体管理</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="agent-manager-body">
          {/* 左侧：预设列表 */}
          <div className="agent-list-section">
            <div className="agent-list-header">
              <h3>预设列表</h3>
              <button className="add-agent-btn" onClick={handleCreate}>
                ➕ 新建
              </button>
            </div>

            {loading ? (
              <div className="agent-loading">加载中...</div>
            ) : (
              <div className="agent-list">
                {Object.entries(presets).map(([key, preset]) => (
                  <div
                    key={key}
                    className={`agent-item ${editingKey === key ? 'active' : ''} ${preset.builtin ? 'builtin' : ''}`}
                    onClick={() => handleEdit(key)}
                  >
                    <span className="agent-icon">{preset.icon}</span>
                    <div className="agent-info">
                      <span className="agent-name">{preset.name}</span>
                      {preset.builtin && <span className="builtin-badge">内置</span>}
                    </div>
                    <div className="agent-actions">
                      <button
                        className="agent-action-btn"
                        onClick={(e) => { e.stopPropagation(); handleDuplicate(key); }}
                        title="复制"
                      >
                        📋
                      </button>
                      <button
                        className="agent-action-btn delete"
                        onClick={(e) => { e.stopPropagation(); handleDelete(key); }}
                        title="删除"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 右侧：编辑区域 */}
          <div className="agent-edit-section">
            {(editingKey || isCreating) ? (
              <>
                <h3>{isCreating ? '创建新预设' : '编辑预设'}</h3>

                <div className="agent-form">
                  <div className="form-row">
                    <div className="form-group">
                      <label>图标</label>
                      <div className="icon-selector">
                        {iconOptions.map(icon => (
                          <button
                            key={icon}
                            className={`icon-option ${editForm.icon === icon ? 'active' : ''}`}
                            onClick={() => setEditForm(prev => ({ ...prev, icon }))}
                          >
                            {icon}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>名称</label>
                    <input
                      type="text"
                      value={editForm.name}
                      onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="例如：导演思维"
                    />
                  </div>

                  <div className="form-group">
                    <label>系统提示词 (System Prompt)</label>
                    <textarea
                      value={editForm.systemPrompt}
                      onChange={(e) => setEditForm(prev => ({ ...prev, systemPrompt: e.target.value }))}
                      placeholder="定义智能体的角色、能力和行为规范..."
                      rows={8}
                    />
                    <small>提示词决定AI的角色和回答风格，写得越具体效果越好</small>
                  </div>

                  <div className="form-actions">
                    <button className="cancel-btn" onClick={() => { setEditingKey(null); setIsCreating(false); }}>
                      取消
                    </button>
                    <button className="save-btn" onClick={handleSaveEdit}>
                      ✓ 确认
                    </button>
                  </div>
                </div>

                {/* 测试区域 */}
                <div className="agent-test-section">
                  <h4>🧪 测试预设</h4>
                  <div className="test-input-row">
                    <input
                      type="text"
                      value={testPrompt}
                      onChange={(e) => setTestPrompt(e.target.value)}
                      placeholder="输入测试问题..."
                      onKeyDown={(e) => e.key === 'Enter' && handleTest()}
                    />
                    <button onClick={handleTest} disabled={isTesting}>
                      {isTesting ? '⏳' : '🚀'} 测试
                    </button>
                  </div>
                  {testResponse && (
                    <div className="test-response">
                      {testResponse}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="agent-empty-state">
                <p>👈 选择左侧预设进行编辑</p>
                <p>或点击"新建"创建自定义智能体</p>
              </div>
            )}
          </div>
        </div>

        {message && (
          <div className={`agent-message ${message.includes('失败') || message.includes('不能') ? 'error' : 'success'}`}>
            {message}
          </div>
        )}

        <div className="agent-manager-footer">
          <button className="cancel-btn" onClick={onClose}>关闭</button>
          <button className="save-all-btn" onClick={handleSave}>
            💾 保存全部
          </button>
        </div>
      </div>
    </div>
  )
}

export { defaultPresets }
export default AgentManager
