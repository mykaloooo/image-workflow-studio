import React, { useState, useCallback, memo, useEffect } from 'react'
import { Handle, Position } from 'reactflow'
import { getAgentPresets, chatWithAI } from '../utils/api'
import { useReferenceImages } from '../contexts/NodesContext'
import ChatDialog from './ChatDialog'

// 默认预设（内置）
const defaultPresets = {
  default: {
    name: '通用助手',
    icon: '🤖',
    systemPrompt: '你是一个专业的AI助手，帮助用户完成各种任务。'
  },
  director: {
    name: '导演思维',
    icon: '🎬',
    systemPrompt: '你是一位经验丰富的电影导演。从导演的视角分析场景构图、叙事节奏、情感表达。关注画面的戏剧张力、角色位置、光影氛围。给出专业的镜头语言建议。'
  },
  photographer: {
    name: '摄影师视角',
    icon: '📷',
    systemPrompt: '你是一位专业摄影师。从摄影的角度分析构图、光线、色彩、景深。关注黄金分割、引导线、对比度、色温。给出技术性的拍摄建议和后期调整方案。'
  },
  screenwriter: {
    name: '编剧创意',
    icon: '✍️',
    systemPrompt: '你是一位富有创意的编剧。擅长构思故事情节、角色背景、场景描述。能够为图片创作背景故事，设计角色对话，构建情感冲突。'
  },
  promptOptimizer: {
    name: '提示词优化',
    icon: '✨',
    systemPrompt: '你是一位AI绘画提示词专家。擅长将用户的想法转化为高质量的图片生成提示词。了解Midjourney、Stable Diffusion、DALL-E等模型的提示词技巧。输出结构化的英文提示词。'
  },
  artCritic: {
    name: '艺术评论',
    icon: '🎨',
    systemPrompt: '你是一位专业的艺术评论家。能够从艺术史、美学理论、文化背景的角度分析作品。关注艺术风格、流派传承、创作手法、象征意义。'
  }
}

/**
 * ChatNode - AI对话节点
 * 用于优化提示词、分析图片、提供创意建议
 */
function ChatNode({ id, data }) {
  const [prompt, setPrompt] = useState(data.prompt || '')
  const [response, setResponse] = useState(data.response || '')
  const [isGenerating, setIsGenerating] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState(data.preset || 'default')
  const [presets, setPresets] = useState(defaultPresets)
  const [chatHistory, setChatHistory] = useState([])  // 对话历史
  const [dialogOpen, setDialogOpen] = useState(false)  // 对话弹窗

  // 获取连接到此节点的参考图
  const referenceImages = useReferenceImages(id)

  // 加载自定义预设
  useEffect(() => {
    const loadPresets = async () => {
      try {
        const result = await getAgentPresets()
        if (result.success && result.presets) {
          setPresets({ ...defaultPresets, ...result.presets })
        }
      } catch (error) {
        console.error('加载预设失败:', error)
      }
    }
    loadPresets()
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) return

    setIsGenerating(true)
    setResponse('')

    try {
      // 获取参考图的 URL 列表
      const imageUrls = referenceImages.map(img => img.imageUrl)

      // 直接调用对话API
      const result = await chatWithAI({
        prompt,
        system_prompt: presets[selectedPreset]?.systemPrompt || '',
        reference_images: imageUrls
      })

      if (result.success) {
        setResponse(result.response)
        // 记录对话历史
        setChatHistory(prev => [
          ...prev,
          { role: 'user', content: prompt },
          { role: 'assistant', content: result.response }
        ])
      } else {
        setResponse(`错误: ${result.error}`)
      }
    } catch (error) {
      setResponse(`错误: ${error.message}`)
    } finally {
      setIsGenerating(false)
    }
  }, [id, prompt, selectedPreset, presets, referenceImages])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleGenerate()
    }
  }, [handleGenerate])

  const handleCopyResponse = useCallback(() => {
    if (response) {
      navigator.clipboard.writeText(response)
    }
  }, [response])

  const handleUseAsPrompt = useCallback(() => {
    if (response && data.onUseAsPrompt) {
      data.onUseAsPrompt(response)
    }
  }, [response, data])

  return (
    <div className="chat-node">
      {/* 输入连接点 */}
      <Handle
        type="target"
        position={Position.Left}
        className="node-handle"
        style={{ background: '#4CAF50' }}
      />

      {/* 节点头部 - 只有这里可以拖动 */}
      <div className="chat-node-header chat-node-drag-handle">
        <span className="chat-node-icon">{presets[selectedPreset]?.icon}</span>
        <span className="chat-node-title">{presets[selectedPreset]?.name}</span>
        <span className="drag-hint">⋮⋮</span>
      </div>

      {/* 预设选择 */}
      <div className="chat-preset-bar">
        {Object.entries(presets).map(([key, preset]) => {
          // 过滤无效预设（防止删除后出现空框）
          if (!preset || !preset.icon) return null

          return (
            <button
              key={key}
              className={`preset-btn ${selectedPreset === key ? 'active' : ''}`}
              onClick={() => setSelectedPreset(key)}
              title={preset.name}
            >
              {preset.icon}
            </button>
          )
        })}
      </div>

      {/* 参考图提示 */}
      {referenceImages.length > 0 && (
        <div className="chat-reference-hint">
          📷 已连接 {referenceImages.length} 张参考图
        </div>
      )}

      {/* 输入区域 */}
      <div className="chat-input-area" onMouseDown={(e) => e.stopPropagation()}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入你的问题或需求... (Ctrl+Enter 发送)"
          rows={3}
          disabled={isGenerating}
        />
      </div>

      {/* 响应区域 */}
      {(response || isGenerating) && (
        <div
          className="chat-response-area"
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          {isGenerating ? (
            <div className="chat-loading">
              <div className="spinner"></div>
              <span>思考中...</span>
            </div>
          ) : (
            <>
              <div
                className="chat-response-content"
                onMouseDown={(e) => e.stopPropagation()}
                onWheel={(e) => e.stopPropagation()}
                style={{ userSelect: 'text', cursor: 'text' }}
              >
                {response}
              </div>
              <div className="chat-response-actions">
                <button onClick={handleCopyResponse} title="复制响应">
                  📋 复制
                </button>
                {selectedPreset === 'promptOptimizer' && (
                  <button onClick={handleUseAsPrompt} title="用作提示词">
                    ✨ 用作提示词
                  </button>
                )}
                <button onClick={() => setDialogOpen(true)} title="展开多轮对话">
                  💬 展开对话
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 底部工具栏 */}
      <div className="chat-bottom-toolbar">
        <button
          className="chat-send-btn"
          onClick={handleGenerate}
          disabled={isGenerating || !prompt.trim()}
        >
          {isGenerating ? '⏳' : '🚀'} {isGenerating ? '生成中' : '发送'}
        </button>
      </div>

      {/* 输出连接点 */}
      <Handle
        type="source"
        position={Position.Right}
        className="node-handle source-handle"
        style={{ background: '#2196F3' }}
      />

      {/* 多轮对话弹窗 */}
      <ChatDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        initialMessages={chatHistory}
        systemPrompt={presets[selectedPreset]?.systemPrompt || ''}
        referenceImages={referenceImages.map(img => img.imageUrl)}
        presetName={presets[selectedPreset]?.name}
        presetIcon={presets[selectedPreset]?.icon}
      />
    </div>
  )
}

export default memo(ChatNode)
