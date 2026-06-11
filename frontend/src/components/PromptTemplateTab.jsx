import React, { useState, useEffect } from 'react'
import { getPromptTemplates, upsertPromptTemplate, deletePromptTemplate, upsertPromptGroup, deletePromptGroup } from '../utils/api'

function PromptTemplateTab() {
  const [groups, setGroups] = useState([])
  const [templates, setTemplates] = useState([])
  const [selectedGroupId, setSelectedGroupId] = useState(null)
  const [editingTemplate, setEditingTemplate] = useState(null)
  const [editingGroup, setEditingGroup] = useState(null)
  const [showNewGroup, setShowNewGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupColor, setNewGroupColor] = useState('#4CAF50')

  useEffect(() => {
    loadData()
  }, [])

  // 从 AI 提示词工具包回来时自动刷新（焦点事件）
  useEffect(() => {
    const handleFocus = () => { loadData() }
    const handleMsg = (e) => {
      if (e && e.data && e.data.type === 'SUPT_TEMPLATE_PUSHED') loadData()
    }
    window.addEventListener('focus', handleFocus)
    window.addEventListener('message', handleMsg)
    return () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('message', handleMsg)
    }
  }, [])

  // 配置 SU Toolkit 地址（localStorage）
  const getSuptUrl = () => {
    return localStorage.getItem('iws_supt_url') || 'http://localhost:8765'
  }
  const setSuptUrl = () => {
    const cur = getSuptUrl()
    const v = prompt('SU Prompt Toolkit 地址（双击 index.html 通常是 file:///... ，HTTP 模式默认 http://localhost:8765）：', cur)
    if (v === null) return
    if (!v.trim()) {
      localStorage.removeItem('iws_supt_url')
    } else {
      localStorage.setItem('iws_supt_url', v.trim().replace(/\/$/, ''))
    }
  }
  const openSuptTool = () => {
    const base = getSuptUrl()
    const url = base + (base.includes('?') ? '&' : '?') + 'from=canvas'
    window.open(url, 'supt_tool', 'width=1400,height=900,menubar=no,toolbar=no')
  }

  const loadData = async () => {
    const result = await getPromptTemplates()
    if (result.success) {
      setGroups(result.groups || [])
      setTemplates(result.templates || [])
      if (!selectedGroupId && result.groups?.length > 0) {
        setSelectedGroupId(result.groups[0].id)
      }
    }
  }

  const filteredTemplates = selectedGroupId
    ? templates.filter(t => t.groupId === selectedGroupId)
    : templates

  const handleSaveTemplate = async () => {
    if (!editingTemplate?.name?.trim() || !editingTemplate?.prompt?.trim()) {
      alert('请填写模板名称和提示词内容')
      return
    }
    const tpl = {
      ...editingTemplate,
      groupId: editingTemplate.groupId || selectedGroupId || groups[0]?.id || 'default'
    }
    const result = await upsertPromptTemplate(tpl)
    if (result.success) {
      setEditingTemplate(null)
      loadData()
    }
  }

  const handleDeleteTemplate = async (id) => {
    if (!confirm('确定删除此模板？')) return
    const result = await deletePromptTemplate(id)
    if (result.success) loadData()
  }

  const handleAddGroup = async () => {
    if (!newGroupName.trim()) return
    const result = await upsertPromptGroup({ name: newGroupName, color: newGroupColor })
    if (result.success) {
      setNewGroupName('')
      setShowNewGroup(false)
      loadData()
    }
  }

  const handleDeleteGroup = async (id) => {
    const group = groups.find(g => g.id === id)
    const count = templates.filter(t => t.groupId === id).length
    if (!confirm(`删除分组"${group?.name}"？其下 ${count} 个模板也会被删除`)) return
    const result = await deletePromptGroup(id)
    if (result.success) {
      if (selectedGroupId === id) setSelectedGroupId(groups[0]?.id)
      loadData()
    }
  }

  const colorOptions = ['#4CAF50', '#FF9800', '#2196F3', '#E91E63', '#9C27B0', '#00BCD4', '#FF5722', '#607D8B']

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      {/* 左侧：分组列表 */}
      <div style={{ width: '200px', background: '#1a1a1a', display: 'flex', flexDirection: 'column', borderRight: '1px solid #333' }}>
        <div style={{ padding: '12px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#999', fontSize: '13px' }}>分组</span>
          <button
            onClick={() => setShowNewGroup(!showNewGroup)}
            style={{ background: 'none', border: 'none', color: '#4CAF50', cursor: 'pointer', fontSize: '18px' }}
          >+</button>
        </div>

        {showNewGroup && (
          <div style={{ padding: '8px', borderBottom: '1px solid #333' }}>
            <input
              value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              placeholder="分组名称"
              style={{ width: '100%', background: '#2a2a2a', border: '1px solid #444', borderRadius: '4px', padding: '6px', color: 'white', fontSize: '13px', marginBottom: '6px' }}
              onKeyDown={e => e.key === 'Enter' && handleAddGroup()}
              autoFocus
            />
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '6px' }}>
              {colorOptions.map(c => (
                <div
                  key={c}
                  onClick={() => setNewGroupColor(c)}
                  style={{
                    width: '20px', height: '20px', borderRadius: '50%', background: c, cursor: 'pointer',
                    border: newGroupColor === c ? '2px solid white' : '2px solid transparent'
                  }}
                />
              ))}
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={handleAddGroup} style={{ flex: 1, padding: '4px', background: '#4CAF50', border: 'none', borderRadius: '4px', color: 'white', cursor: 'pointer', fontSize: '12px' }}>添加</button>
              <button onClick={() => setShowNewGroup(false)} style={{ flex: 1, padding: '4px', background: '#555', border: 'none', borderRadius: '4px', color: 'white', cursor: 'pointer', fontSize: '12px' }}>取消</button>
            </div>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div
            onClick={() => setSelectedGroupId(null)}
            style={{
              padding: '10px 12px', cursor: 'pointer', fontSize: '13px',
              background: selectedGroupId === null ? '#333' : 'transparent',
              color: selectedGroupId === null ? 'white' : '#ccc',
              borderLeft: selectedGroupId === null ? '3px solid #4CAF50' : '3px solid transparent'
            }}
          >
            📋 全部 ({templates.length})
          </div>
          {groups.map(g => (
            <div
              key={g.id}
              onClick={() => setSelectedGroupId(g.id)}
              style={{
                padding: '10px 12px', cursor: 'pointer', fontSize: '13px',
                background: selectedGroupId === g.id ? '#333' : 'transparent',
                color: selectedGroupId === g.id ? 'white' : '#ccc',
                borderLeft: selectedGroupId === g.id ? `3px solid ${g.color}` : '3px solid transparent',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center'
              }}
            >
              <span>
                <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: g.color, marginRight: '8px' }} />
                {g.name} ({templates.filter(t => t.groupId === g.id).length})
              </span>
              <button
                onClick={e => { e.stopPropagation(); handleDeleteGroup(g.id) }}
                style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '12px', padding: '2px' }}
                title="删除分组"
              >✕</button>
            </div>
          ))}
        </div>
      </div>

      {/* 右侧：模板列表 + 编辑 */}
      <div style={{ flex: 1, background: '#222', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#999', fontSize: '13px' }}>
            {selectedGroupId ? groups.find(g => g.id === selectedGroupId)?.name : '全部'} - {filteredTemplates.length} 个模板
          </span>
          <button
            onClick={() => setEditingTemplate({ name: '', prompt: '', icon: '📝', groupId: selectedGroupId || groups[0]?.id })}
            style={{ background: '#4CAF50', border: 'none', borderRadius: '6px', padding: '6px 14px', color: 'white', cursor: 'pointer', fontSize: '13px' }}
          >+ 新建模板</button>
        </div>

        {editingTemplate ? (
          <div style={{ flex: 1, padding: '16px', overflowY: 'auto' }}>
            <div style={{ marginBottom: '12px' }}>
              <label style={{ color: '#999', fontSize: '12px', display: 'block', marginBottom: '4px' }}>模板名称</label>
              <input
                value={editingTemplate.name}
                onChange={e => setEditingTemplate({ ...editingTemplate, name: e.target.value })}
                placeholder="例如：皮克斯风格漫画"
                style={{ width: '100%', background: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', padding: '10px', color: 'white', fontSize: '14px' }}
                autoFocus
              />
            </div>
            <div style={{ marginBottom: '12px' }}>
              <label style={{ color: '#999', fontSize: '12px', display: 'block', marginBottom: '4px' }}>分组</label>
              <select
                value={editingTemplate.groupId || ''}
                onChange={e => setEditingTemplate({ ...editingTemplate, groupId: e.target.value })}
                style={{ width: '100%', background: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', padding: '10px', color: 'white', fontSize: '14px' }}
              >
                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: '12px' }}>
              <label style={{ color: '#999', fontSize: '12px', display: 'block', marginBottom: '4px' }}>图标</label>
              <input
                value={editingTemplate.icon || ''}
                onChange={e => setEditingTemplate({ ...editingTemplate, icon: e.target.value })}
                placeholder="输入 emoji"
                style={{ width: '80px', background: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', padding: '10px', color: 'white', fontSize: '18px', textAlign: 'center' }}
              />
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ color: '#999', fontSize: '12px', display: 'block', marginBottom: '4px' }}>提示词内容</label>
              <textarea
                value={editingTemplate.prompt}
                onChange={e => setEditingTemplate({ ...editingTemplate, prompt: e.target.value })}
                placeholder="输入提示词模板内容..."
                rows={8}
                style={{ width: '100%', background: '#1a1a1a', border: '1px solid #444', borderRadius: '6px', padding: '10px', color: 'white', fontSize: '14px', resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={handleSaveTemplate} style={{ padding: '10px 24px', background: '#4CAF50', border: 'none', borderRadius: '6px', color: 'white', cursor: 'pointer', fontSize: '14px' }}>保存</button>
              <button onClick={() => setEditingTemplate(null)} style={{ padding: '10px 24px', background: '#555', border: 'none', borderRadius: '6px', color: 'white', cursor: 'pointer', fontSize: '14px' }}>取消</button>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
            {filteredTemplates.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#666', padding: '40px', fontSize: '14px' }}>
                暂无模板，点击"+ 新建模板"创建
              </div>
            ) : (
              filteredTemplates.map(t => (
                <div
                  key={t.id}
                  style={{
                    padding: '12px', margin: '4px', background: '#2a2a2a', borderRadius: '8px',
                    cursor: 'pointer', transition: 'background 0.2s'
                  }}
                  onClick={() => setEditingTemplate({ ...t })}
                  onMouseEnter={e => e.currentTarget.style.background = '#333'}
                  onMouseLeave={e => e.currentTarget.style.background = '#2a2a2a'}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <span style={{ fontSize: '14px', color: 'white' }}>
                      {t.icon || '📝'} {t.name}
                    </span>
                    <button
                      onClick={e => { e.stopPropagation(); handleDeleteTemplate(t.id) }}
                      style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '14px' }}
                      title="删除"
                    >🗑</button>
                  </div>
                  <div style={{ fontSize: '12px', color: '#888', lineHeight: '1.5', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                    {t.prompt}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default PromptTemplateTab
