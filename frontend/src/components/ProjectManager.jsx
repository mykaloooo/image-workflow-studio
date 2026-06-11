import React, { useState, useEffect, useRef } from 'react'
import { projectDB } from '../utils/projectDB'
import { browserFS } from '../utils/browserFileSystem'

function ProjectManager({ isOpen, onClose, onLoadProject, onNewProject }) {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (isOpen) {
      loadProjects()
    }
  }, [isOpen])

  const loadProjects = async () => {
    try {
      setLoading(true)
      const allProjects = await projectDB.getAllProjects()
      setProjects(allProjects)
    } catch (error) {
      console.error('加载项目失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleLoad = (project) => {
    onLoadProject(project)
    onClose()
  }

  const handleLoadFromFile = async () => {
    try {
      setLoading(true)
      const project = await browserFS.loadProject()
      onLoadProject(project)
      onClose()
    } catch (error) {
      if (error.message !== '用户取消选择') {
        alert('加载失败: ' + error.message)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (project) => {
    if (!confirm(`确定要删除项目"${project.name}"吗？`)) return

    try {
      await projectDB.deleteProject(project.id)
      await loadProjects()
    } catch (error) {
      console.error('删除项目失败:', error)
      alert('删除项目失败: ' + error.message)
    }
  }

  const handleExport = async (project) => {
    try {
      const content = JSON.stringify(project, null, 2)
      const blob = new Blob([content], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${project.name}.json`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      alert(`项目"${project.name}"导出成功！`)
    } catch (error) {
      alert('导出失败: ' + error.message)
    }
  }

  const handleImportFile = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      setLoading(true)
      const content = await file.text()
      const project = JSON.parse(content)
      
      if (!project.id || !project.name) {
        throw new Error('项目文件格式错误')
      }

      onLoadProject(project)
      onClose()
      alert(`项目"${project.name}"导入成功！`)
    } catch (error) {
      alert('导入失败: ' + error.message)
    } finally {
      setLoading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const formatDate = (dateString) => {
    const date = new Date(dateString)
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  if (!isOpen) return null

  return (
    <div className="project-manager-overlay">
      <div className="project-manager">
        <div className="project-manager-header">
          <h2>📂 项目管理</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="project-manager-actions">
          <button className="new-project-btn" onClick={() => {
            onNewProject()
            onClose()
          }}>
            ➕ 新建项目
          </button>
          <button className="import-project-btn" onClick={handleLoadFromFile}>
            📥 加载本地项目
          </button>
          <button className="import-project-btn" onClick={() => fileInputRef.current?.click()}>
            📤 导入项目文件
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
        </div>

        <div className="project-list">
          {loading ? (
            <div className="loading-state">
              <div className="spinner"></div>
              <p>加载中...</p>
            </div>
          ) : projects.length === 0 ? (
            <div className="empty-state">
              <p>📭 还没有保存的项目</p>
              <small>点击"保存项目"将工作流保存到本地</small>
            </div>
          ) : (
            projects.map((project) => (
              <div key={project.id} className="project-item">
                <div className="project-info">
                  <h3>{project.name}</h3>
                  <div className="project-meta">
                    <span>🖼️ {project.nodes.length} 个节点</span>
                    <span>🔗 {project.edges.length} 个连接</span>
                  </div>
                  <div className="project-dates">
                    <small>创建: {formatDate(project.createdAt)}</small>
                    <small>更新: {formatDate(project.updatedAt)}</small>
                  </div>
                </div>

                <div className="project-actions">
                  <button
                    className="load-btn"
                    onClick={() => handleLoad(project)}
                    title="加载项目"
                  >
                    📂 加载
                  </button>
                  <button
                    className="export-btn"
                    onClick={() => handleExport(project)}
                    title="导出项目"
                  >
                    📤 导出
                  </button>
                  <button
                    className="delete-btn"
                    onClick={() => handleDelete(project)}
                    title="删除项目"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export default ProjectManager
