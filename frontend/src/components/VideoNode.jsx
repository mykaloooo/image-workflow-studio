import React, { useState, useRef, useEffect } from 'react'
import { Handle, Position } from 'reactflow'
import { useReferenceImages } from '../contexts/NodesContext'

function VideoNode({ data, id }) {
  const [promptText, setPromptText] = useState(data.prompt || '')
  const [model, setModel] = useState(data.model || 'sora-2-all')

  // 使用 Context Hook 获取参考图 (与 ImageNode 保持一致)
  const referenceImages = useReferenceImages(id)

  const [params, setParams] = useState({
    duration: data.duration || '10s',
    ratio: data.ratio || '16:9',
    quality: data.quality || '1080p' // 新增清晰度
  })
  const [showSettings, setShowSettings] = useState(false) // 控制参数面板显示
  const [isPlaying, setIsPlaying] = useState(false)
  const videoRef = useRef(null)
  const settingsRef = useRef(null)

  // 点击外部关闭设置面板
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target)) {
        setShowSettings(false)
      }
    }
    if (showSettings) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showSettings])

  const handleGenerate = () => {
    if (!promptText.trim()) {
      alert('请先输入提示词')
      return
    }
    if (data.onGenerate) {
      data.onGenerate(id, {
        prompt: promptText,
        model: model,
        duration: params.duration,
        ratio: params.ratio,
        quality: params.quality
      })
    }
  }

  return (
    <div className={`video-node ${data.status}`}>
      <div className="node-content">
        <div className="prompt-node-new video-theme">
          {/* 顶部标题 */}
          <div className="node-header image-node-drag-handle">
            <span className="node-title">🎬 视频生成</span>
            <div className="header-controls">
              <select
                className="header-model-select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onClick={(e) => e.stopPropagation()} // 防止拖动
              >
                <option value="sora-2-all">Sora-2</option>
                <option value="veo3.1-fast-components">Veo 3.1 (图生视频)</option>
                <option value="runway-gen3">Runway</option>
                <option value="kling-v1">Kling</option>
              </select>
            </div>
          </div>

          {/* 视频区域 */}
          <div className="generation-area video-area">
            {/* 参考图缩略图区域 (叠加显示) - 移除状态限制，始终显示 */}
            {referenceImages.length > 0 && (
              <div className="reference-images-overlay">
                <div className="reference-badge">参考图 x{referenceImages.length}</div>
                <div className="reference-thumbs">
                  {referenceImages.map((ref, index) => (
                    <div key={ref.id} className="reference-thumb-mini">
                      <img src={ref.imageUrl} alt={`参考图 ${index + 1}`} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.status === 'generating' ? (
              <div className="generating-state">
                <div className="spinner large"></div>
                <div className="loading-text">
                  视频生成中...<br/>
                  <small>{model}</small>
                  {data.progress !== undefined && (
                    <div className="video-progress-container">
                      <div className="progress-bar">
                        <div className="progress-fill" style={{width: `${data.progress}%`}}></div>
                      </div>
                      <div className="progress-text">{data.progress}%</div>
                    </div>
                  )}
                </div>
              </div>
            ) : data.status === 'completed' && data.videoUrl ? (
              <div className="video-wrapper">
                <video
                  ref={videoRef}
                  src={data.videoUrl}
                  className="node-video"
                  controls
                  loop
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                />
              </div>
            ) : (
              <div className="empty-state">
                <span>输入提示词生成视频</span>
              </div>
            )}
          </div>

          {/* 输入框 */}
          <div className="prompt-input-bar">
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="描述视频内容..."
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleGenerate()
                }
              }}
            />
          </div>

          {/* 底部工具栏 (仿 Tapnow) */}
          <div className="bottom-toolbar video-toolbar-compact">
            {/* 参数概览按钮 */}
            <button
              className={`params-toggle-btn ${showSettings ? 'active' : ''}`}
              onClick={() => setShowSettings(!showSettings)}
              title="调整参数"
            >
              ⚙️ {params.ratio} · {params.quality} · {params.duration}
            </button>

            <div className="spacer"></div>

            {/* 下载按钮 */}
            {data.status === 'completed' && data.videoUrl && (
              <button
                className="icon-btn"
                onClick={() => {
                  const link = document.createElement('a')
                  link.href = data.videoUrl
                  link.download = data.filename || `video_${Date.now()}.mp4`
                  link.click()
                }}
              >
                ⬇️
              </button>
            )}

            {/* 生成按钮 */}
            <button
              className="generate-btn-icon"
              onClick={handleGenerate}
              disabled={data.status === 'generating'}
              title="生成视频 (Enter)"
            >
              {data.status === 'generating' ? '⏳' : '🚀'}
            </button>

            {/* 弹出式参数面板 */}
            {showSettings && (
              <div className="video-settings-popover" ref={settingsRef}>
                {/* 比例选择 */}
                <div className="setting-group">
                  <label>画面比例</label>
                  <div className="ratio-grid">
                    {['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map(r => (
                      <button
                        key={r}
                        className={`ratio-btn ${params.ratio === r ? 'active' : ''}`}
                        onClick={() => setParams({...params, ratio: r})}
                      >
                        <span className="ratio-icon" style={{aspectRatio: r.replace(':', '/')}}></span>
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 清晰度 */}
                <div className="setting-group">
                  <label>清晰度</label>
                  <div className="btn-group">
                    {['720p', '1080p'].map(q => (
                      <button
                        key={q}
                        className={`option-btn ${params.quality === q ? 'active' : ''}`}
                        onClick={() => setParams({...params, quality: q})}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 时长 */}
                <div className="setting-group">
                  <label>视频时长</label>
                  <div className="btn-group">
                    {['5s', '10s', '15s'].map(d => (
                      <button
                        key={d}
                        className={`option-btn ${params.duration === d ? 'active' : ''}`}
                        onClick={() => setParams({...params, duration: d})}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <Handle type="target" position={Position.Left} className="node-handle" isConnectable={true} />
    </div>
  )
}

export default VideoNode
