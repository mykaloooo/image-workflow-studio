import React, { useState } from 'react'
import { initializeAPI } from '../utils/api'

function ConfigPanel({ onConfigured, onOpenSettings }) {
  const [apiKey, setApiKey] = useState('')
  const [proxyUrl, setProxyUrl] = useState('http://127.0.0.1:10808')
  const [outputDir, setOutputDir] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const result = await initializeAPI(apiKey, proxyUrl, outputDir)
      if (result.success) {
        onConfigured({ apiKey, proxyUrl, outputDir })
      } else {
        setError(result.error || '初始化失败')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="config-panel-overlay">
      <div className="config-panel">
        <h2>🎨 图片工作流工作室</h2>
        <p className="config-desc">请配置 API 以开始使用，或打开系统设置管理多个 API</p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Gemini API Key *</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="输入你的 Gemini API Key"
              required
            />
          </div>

          <div className="form-group">
            <label>代理地址（可选）</label>
            <input
              type="text"
              value={proxyUrl}
              onChange={(e) => setProxyUrl(e.target.value)}
              placeholder="http://127.0.0.1:10808"
            />
            <small>如果需要代理访问，请填写代理地址</small>
          </div>

          <div className="form-group">
            <label>输出目录（可选）</label>
            <input
              type="text"
              value={outputDir}
              onChange={(e) => setOutputDir(e.target.value)}
              placeholder="D:\我的AI图片\生成"
            />
            <small>指定图片保存位置，留空则使用默认目录</small>
          </div>

          {error && (
            <div className="error-message">
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} className="submit-btn">
            {loading ? '初始化中...' : '开始使用'}
          </button>
        </form>

        <div className="config-divider">
          <span>或</span>
        </div>

        <button
          type="button"
          className="settings-btn"
          onClick={onOpenSettings}
        >
          ⚙️ 打开系统设置
        </button>
        <p className="settings-hint">管理多个 API Key（图片/对话/视频）</p>
      </div>
    </div>
  )
}

export default ConfigPanel
