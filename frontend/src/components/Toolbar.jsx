import React from 'react'

function Toolbar({ onNewProject, onOpenProject, onSaveProject, onSaveProjectAs, onImportProject, onShowConfig, onOpenSettings, onOpenAgentManager, onOpenTemplateManager, projectName }) {
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <h1 className="app-title">图片工作流工作室</h1>
        <span className="project-name">📁 {projectName}</span>
      </div>

      <div className="toolbar-center">
        <button className="toolbar-btn" onClick={onNewProject}>
          ✨ 新建
        </button>
        <button className="toolbar-btn" onClick={onOpenProject}>
          📂 打开
        </button>
        <button className="toolbar-btn" onClick={onSaveProject}>
          💾 保存
        </button>
        <button className="toolbar-btn" onClick={onSaveProjectAs}>
          📄 另存为
        </button>
        <button className="toolbar-btn" onClick={onImportProject}>
          📥 导入
        </button>
        <button className="toolbar-btn" onClick={onShowConfig}>
          ⚙️ 设置
        </button>
        <button className="toolbar-btn" onClick={onOpenAgentManager}>
          🤖 智能体
        </button>
        <button className="toolbar-btn" onClick={onOpenTemplateManager}>
          📝 模板
        </button>
        <button className="toolbar-btn settings-btn-highlight" onClick={onOpenSettings}>
          🔧 系统
        </button>
      </div>

      <div className="toolbar-right">
        <span className="version">v2.2.0</span>
      </div>
    </div>
  )
}

export default Toolbar
