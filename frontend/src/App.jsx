import React, { useState, useEffect } from 'react'
import { ReactFlowProvider } from 'reactflow'
import Canvas from './components/Canvas'
import ConfigPanel from './components/ConfigPanel'
import SystemSettings from './components/SystemSettings'
import AgentManager from './components/AgentManager'
import PromptTemplateManager from './components/PromptTemplateManager'
import { autoInit, getSystemConfig } from './utils/api'

function App() {
  const [apiConfig, setApiConfig] = useState({
    apiKey: '',
    proxyUrl: 'http://127.0.0.1:10808',
    initialized: false
  })
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [showAgentManager, setShowAgentManager] = useState(false)
  const [showTemplateManager, setShowTemplateManager] = useState(false)
  // 独立页面模式：?view=suppliers 时不渲染画布，直接走 SystemSettings variant='page'
  const [viewMode, setViewMode] = useState('main')

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search || '')
    const hashText = (window.location.hash || '').replace(/^#\??/, '')
    const hashParams = new URLSearchParams(hashText)
    const viewTarget = searchParams.get('view') || hashParams.get('view')
    if (['suppliers', 'supplier', 'providers', 'provider'].includes(viewTarget)) {
      setViewMode('suppliers')
      return
    }
    const openTarget = searchParams.get('settings') || searchParams.get('open') || hashParams.get('settings') || hashParams.get('open')
    if (['providers', 'provider', 'settings', 'system'].includes(openTarget)) {
      setShowSettings(true)
    }
  }, [])

  // 启动时尝试自动初始化
  useEffect(() => {
    const tryAutoInit = async () => {
      setLoading(true)
      const result = await autoInit()
      if (result.success) {
        setApiConfig({ ...apiConfig, initialized: true })
      }
      setLoading(false)
    }
    tryAutoInit()
  }, [])

  // 加载中显示
  if (loading) {
    return (
      <div className="app loading-screen">
        <div className="loading-content">
          <div className="spinner large"></div>
          <p>正在加载...</p>
        </div>
      </div>
    )
  }

  // 独立页面模式：供 Eagle 插件打开 ?view=suppliers 使用，不渲染画布、不要求初始化
  if (viewMode === 'suppliers') {
    return (
      <div className="app">
        <SystemSettings
          variant="page"
          onClose={() => {
            // 打开者是 window.open 当然允许 close；直接打开的独立 tab 用返回画布兑底
            try {
              window.close()
              setTimeout(() => {
                if (!window.closed) {
                  window.location.href = '/'
                }
              }, 200)
            } catch (_) {
              window.location.href = '/'
            }
          }}
        />
      </div>
    )
  }

  return (
    <div className="app">
      {/* 配置面板 - 未初始化时显示 */}
      {!apiConfig.initialized && (
        <ConfigPanel
          onConfigured={(config) => setApiConfig({ ...config, initialized: true })}
          onOpenSettings={() => setShowSettings(true)}
        />
      )}

      {/* 主画布 */}
      {apiConfig.initialized && (
        <ReactFlowProvider>
          <Canvas
            apiConfig={apiConfig}
            onOpenSettings={() => setShowSettings(true)}
            onOpenAgentManager={() => setShowAgentManager(true)}
            onOpenTemplateManager={() => setShowTemplateManager(true)}
          />
        </ReactFlowProvider>
      )}

      {/* 系统设置面板 */}
      {showSettings && (
        <SystemSettings
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            // 配置保存后可以选择重新初始化
          }}
        />
      )}

      {/* 智能体管理面板 */}
      {showAgentManager && (
        <AgentManager
          onClose={() => setShowAgentManager(false)}
        />
      )}

      {/* 提示词模板管理面板 */}
      {showTemplateManager && (
        <PromptTemplateManager
          onClose={() => setShowTemplateManager(false)}
        />
      )}
    </div>
  )
}

export default App
