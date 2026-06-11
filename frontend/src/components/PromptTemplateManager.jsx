import React, { useState } from 'react'
import PromptTemplateTab from './PromptTemplateTab'
import GenerationHistoryTab from './GenerationHistoryTab'

/**
 * PromptTemplateManager
 * 顶层 Tab 容器（Modal 壳）。内部两个 Tab：
 *   - templates: 提示词模板（原有功能全量搬到 PromptTemplateTab）
 *   - history:   生图历史聚合面板（Phase 3 填充）
 * 默认激活 templates Tab。保留 onClose prop 用于关闭 Modal。
 */
function PromptTemplateManager({ onClose }) {
  const [tab, setTab] = useState('templates') // 'templates' | 'history'

  return (
    <div className="config-panel-overlay" onClick={onClose}>
      <div
        className="config-panel"
        onClick={e => e.stopPropagation()}
        style={{
          width: '90vw',
          maxWidth: '1200px',
          height: '85vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="config-header">
          <h2>📝 提示词 &amp; 生图历史</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        {/* Tab 切换栏 */}
        <div style={{
          display: 'flex',
          gap: '2px',
          padding: '8px 12px 0',
          borderBottom: '1px solid #333',
          background: '#1a1a1a',
        }}>
          <TabButton active={tab === 'templates'} onClick={() => setTab('templates')}>
            📝 提示词模板
          </TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
            🖼️ 生图历史
          </TabButton>
        </div>

        {/* Tab 内容区 */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {tab === 'templates' && <PromptTemplateTab />}
          {tab === 'history' && <GenerationHistoryTab />}
        </div>
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? '#222' : 'transparent',
        color: active ? 'white' : '#999',
        border: 'none',
        borderRadius: '6px 6px 0 0',
        padding: '10px 16px',
        cursor: 'pointer',
        fontSize: '13px',
        borderBottom: active ? '2px solid #4CAF50' : '2px solid transparent',
        transition: 'background 0.2s, color 0.2s',
      }}
    >
      {children}
    </button>
  )
}

export default PromptTemplateManager
