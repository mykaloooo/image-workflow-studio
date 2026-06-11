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
