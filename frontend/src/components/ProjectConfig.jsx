import React, { useState } from 'react'

function ConfigPanel({ isOpen, onClose, apiConfig, onSave, currentProjectName }) {
  const [outputDir, setOutputDir] = useState(apiConfig?.outputDir || '')
  const [editMode, setEditMode] = useState(false)
  const [tempDir, setTempDir] = useState(outputDir)

  const defaultOutputDir = 'backend/outputs'

  if (!isOpen) return null

  const handleSave = () => {
    setOutputDir(tempDir)
    onSave({
      apiKey: apiConfig?.apiKey || '',
      proxyUrl: apiConfig?.proxyUrl || '',
      outputDir: tempDir
    })
    setEditMode(false)
    onClose()
  }

  const handleCancel = () => {
    setTempDir(outputDir)
    setEditMode(false)
  }

  const getOutputPath = () => {
    if (tempDir) return tempDir
    return defaultOutputDir
  }

  const copyPath = () => {
    const path = getOutputPath()
    navigator.clipboard.writeText(path)
    alert('路径已复制到剪贴板')
  }

  const openOutputDir = () => {
    alert(`请手动打开以下目录查看生成的图片：\n\n${getOutputPath()}\n\n路径已复制到剪贴板`)
    navigator.clipboard.writeText(getOutputPath())
  }

  return (
    <div className="config-panel-overlay">
      <div className="config-panel">
        <div className="config-header">
          <h2>⚙️ 项目设置</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="config-section">
          <h3>📁 项目信息</h3>
          <div className="config-item">
            <label>当前项目:</label>
            <span>{currentProjectName || '未命名项目'}</span>
          </div>
          <div className="config-item">
            <label>保存方式:</label>
            <span>浏览器本地存储 / 文件对话框</span>
          </div>
        </div>

        <div className="config-section">
          <h3>🖼️ 图片输出</h3>
          
          {!editMode ? (
            <>
              <div className="config-item config-item-with-btn">
                <div>
                  <label>输出目录:</label>
                  <span className="config-path">{getOutputPath()}</span>
                </div>
                <div className="config-item-actions">
                  <button className="config-link-btn" onClick={copyPath}>📋 复制路径</button>
                  <button className="config-link-btn" onClick={openOutputDir}>📂 打开目录</button>
                  <button className="config-link-btn" onClick={() => { setTempDir(outputDir); setEditMode(true) }}>✏️ 修改</button>
                </div>
              </div>
              <p className="config-hint">生成的图片将保存到此目录（下次生成生效）</p>
            </>
          ) : (
            <div className="config-edit">
              <div className="form-group">
                <label>输出目录（绝对路径）:</label>
                <input
                  type="text"
                  value={tempDir}
                  onChange={(e) => setTempDir(e.target.value)}
                  placeholder={`例如: D:\\我的图片输出`}
                />
                <small>请输入完整的目录路径，支持中文</small>
              </div>
              <div className="config-hint">
                💡 提示：留空使用默认目录 "backend/outputs"
              </div>
            </div>
          )}
        </div>

        <div className="config-section">
          <h3>🔑 API 配置</h3>
          <div className="config-item">
            <label>API Key:</label>
            <span>{apiConfig?.apiKey ? '••••••••' : '未配置'}</span>
          </div>
          <div className="config-item">
            <label>代理:</label>
            <span>{apiConfig?.proxyUrl || '无'}</span>
          </div>
        </div>

        <div className="config-section">
          <h3>📖 使用说明</h3>
          <div className="config-help">
            <p>• <strong>查看图片</strong>：点击"打开目录"查看已生成的图片</p>
            <p>• <strong>修改路径</strong>：点击"修改"设置自定义输出目录</p>
            <p>• <strong>默认目录</strong>：{defaultOutputDir}</p>
          </div>
        </div>

        <div className="config-actions">
          {editMode ? (
            <>
              <button className="config-btn secondary" onClick={handleCancel}>取消</button>
              <button className="config-btn primary" onClick={handleSave}>保存</button>
            </>
          ) : (
            <button className="config-btn primary" onClick={onClose}>关闭</button>
          )}
        </div>
      </div>
    </div>
  )
}

export default ConfigPanel
