import React, { useState, useEffect } from 'react'
import { getSystemConfig, updateSystemConfig } from '../utils/api'

function normalizeProvider(provider) {
  const normalized = { ...(provider || {}) }
  const models = []
  const source = [
    ...(Array.isArray(normalized.models) ? normalized.models : []),
    normalized.model,
  ]
  for (const item of source) {
    const model = String(item || '').trim()
    if (model && !models.includes(model)) {
      models.push(model)
    }
  }
  normalized.models = models
  normalized.model = String(normalized.model || models[0] || '').trim()
  normalized.api_url = String(normalized.api_url || normalized.apiUrl || '').trim()
  normalized.protocol = String(normalized.protocol || '').trim()
  return normalized
}

function SystemSettings({ onClose, onSaved, variant = 'modal' }) {
  const isPage = variant === 'page'

  const [config, setConfig] = useState({
    providers: [],
    active_image_provider_id: '',
    active_chat_provider_id: '',
    active_video_provider_id: '',
    proxy_url: '',
    output_dir: ''
  })

  // 当前正在编辑的供应商，暂存在这里，点击保存到列表才生效
  const [editingProvider, setEditingProvider] = useState(null)

  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [showKey, setShowKey] = useState(false)

  useEffect(() => {
    loadConfig()
  }, [])

  const loadConfig = async () => {
    const result = await getSystemConfig()
    if (result.success && result.config) {
      const providers = (result.config.providers || []).map(normalizeProvider);
      setConfig({
        providers: providers,
        active_image_provider_id: result.config.active_image_provider_id || '',
        active_chat_provider_id: result.config.active_chat_provider_id || '',
        active_video_provider_id: result.config.active_video_provider_id || '',
        proxy_url: result.config.proxyUrl || '',
        output_dir: result.config.outputDir || ''
      })
      if (providers.length > 0) {
        setEditingProvider({ ...providers[0] })
      }
    }
  }

  const handleEditSelect = (id) => {
    if (id === 'new') {
      setEditingProvider({
        id: 'provider_' + Date.now(),
        name: '新供应商',
        type: 'image', // 默认图片类型
        api_key: '',
        api_url: '',
        protocol: '',
        model: '',
        models: [],
        hasKey: false,
      });
    } else {
      const p = config.providers.find(x => x.id === id);
      if (p) setEditingProvider(normalizeProvider({ ...p }));
    }
    setShowKey(false);
  }

  const handleSaveProviderToList = () => {
    if (!editingProvider.name.trim()) {
      alert("请输入供应商名称");
      return;
    }

    const normalizedEditingProvider = normalizeProvider(editingProvider)

    setConfig(prev => {
      const exists = prev.providers.some(p => p.id === normalizedEditingProvider.id);
      let newProviders;
      if (exists) {
        newProviders = prev.providers.map(p => p.id === normalizedEditingProvider.id ? normalizedEditingProvider : p);
      } else {
        newProviders = [...prev.providers, normalizedEditingProvider];
      }

      let newImageId = prev.active_image_provider_id;
      let newChatId = prev.active_chat_provider_id;
      let newVideoId = prev.active_video_provider_id;

      // 如果当前类型的 active 是空，自动选中它
      if (normalizedEditingProvider.type === 'image' && !newImageId) newImageId = normalizedEditingProvider.id;
      if (normalizedEditingProvider.type === 'chat' && !newChatId) newChatId = normalizedEditingProvider.id;
      if (normalizedEditingProvider.type === 'video' && !newVideoId) newVideoId = normalizedEditingProvider.id;

      // 如果修改了分类类型，旧的激活态需要清空（比如原来是图片，现在改成视频，那么不能让它继续作为图片生图的选项）
      if (newImageId === normalizedEditingProvider.id && normalizedEditingProvider.type !== 'image') newImageId = '';
      if (newChatId === normalizedEditingProvider.id && normalizedEditingProvider.type !== 'chat') newChatId = '';
      if (newVideoId === normalizedEditingProvider.id && normalizedEditingProvider.type !== 'video') newVideoId = '';

      return {
        ...prev,
        providers: newProviders,
        active_image_provider_id: newImageId,
        active_chat_provider_id: newChatId,
        active_video_provider_id: newVideoId
      }
    });

    alert("✅ 该供应商已暂存！\n\n如果它是新添加的，请在下方选择将其设为对应的当前应用。\n最后请点击最底部的「💾 保存配置」来生效。");
  }

  const handleCopyProvider = () => {
    if (!editingProvider) return;

    const source = normalizeProvider(editingProvider);
    const copiedProvider = normalizeProvider({
      ...source,
      id: 'provider_' + Date.now(),
      name: `${source.name || '未命名供应商'}（复制）`,
    });

    setEditingProvider(copiedProvider);
    setShowKey(false);
    setMessage('已复制为新供应商，请修改后点击「暂存此供应商信息」。');
  }

  const handleRemoveProvider = () => {
    if (!editingProvider) return;
    if (config.providers.length <= 1) {
      alert("至少需要保留一个供应商");
      return;
    }
    if (window.confirm(`确定要删除供应商 "${editingProvider.name}" 吗？`)) {
      setConfig(prev => {
        const newList = prev.providers.filter(p => p.id !== editingProvider.id);

        let newImageId = prev.active_image_provider_id === editingProvider.id ? '' : prev.active_image_provider_id;
        let newChatId = prev.active_chat_provider_id === editingProvider.id ? '' : prev.active_chat_provider_id;
        let newVideoId = prev.active_video_provider_id === editingProvider.id ? '' : prev.active_video_provider_id;

        // 选中第一个继续编辑
        setEditingProvider(newList.length > 0 ? { ...newList[0] } : null);

        return {
          ...prev,
          providers: newList,
          active_image_provider_id: newImageId,
          active_chat_provider_id: newChatId,
          active_video_provider_id: newVideoId
        }
      });
    }
  }

  const handleSave = async () => {
    setLoading(true)
    setMessage('')

    // 自动应用当前正在编辑的供应商（无需必须先点击暂存）
    let currentProviders = [...config.providers];
    let currentImageId = config.active_image_provider_id;
    let currentChatId = config.active_chat_provider_id;
    let currentVideoId = config.active_video_provider_id;

    if (editingProvider && editingProvider.name && editingProvider.name.trim() !== '') {
      const normalizedEditingProvider = normalizeProvider(editingProvider)
      const exists = currentProviders.some(p => p.id === normalizedEditingProvider.id);
      if (exists) {
        currentProviders = currentProviders.map(p => p.id === normalizedEditingProvider.id ? normalizedEditingProvider : p);
      } else {
        currentProviders = [...currentProviders, normalizedEditingProvider];
      }

      if (normalizedEditingProvider.type === 'image' && !currentImageId) currentImageId = normalizedEditingProvider.id;
      if (normalizedEditingProvider.type === 'chat' && !currentChatId) currentChatId = normalizedEditingProvider.id;
      if (normalizedEditingProvider.type === 'video' && !currentVideoId) currentVideoId = normalizedEditingProvider.id;

      if (currentImageId === normalizedEditingProvider.id && normalizedEditingProvider.type !== 'image') currentImageId = '';
      if (currentChatId === normalizedEditingProvider.id && normalizedEditingProvider.type !== 'chat') currentChatId = '';
      if (currentVideoId === normalizedEditingProvider.id && normalizedEditingProvider.type !== 'video') currentVideoId = '';
    }

    currentProviders = currentProviders.map(normalizeProvider)

    try {
      const savePayload = {
        providers: currentProviders,
        active_image_provider_id: currentImageId,
        active_chat_provider_id: currentChatId,
        active_video_provider_id: currentVideoId,
        proxy_url: config.proxy_url,
        output_dir: config.output_dir
      };

      // 如果 active id 为空，但存在相应类型的供应商，自动选中第一个
      const imagePs = currentProviders.filter(p => p.type === 'image');
      if (!savePayload.active_image_provider_id && imagePs.length > 0) {
         savePayload.active_image_provider_id = imagePs[0].id;
      }
      const chatPs = currentProviders.filter(p => p.type === 'chat');
      if (!savePayload.active_chat_provider_id && chatPs.length > 0) {
         savePayload.active_chat_provider_id = chatPs[0].id;
      }
      const videoPs = currentProviders.filter(p => p.type === 'video');
      if (!savePayload.active_video_provider_id && videoPs.length > 0) {
         savePayload.active_video_provider_id = videoPs[0].id;
      }

      const result = await updateSystemConfig(savePayload)
      if (result.success) {
        setMessage(isPage ? '✅ 配置已保存！插件下次操作会自动同步' : '配置已保存！')
        await loadConfig()
        // 通知画布上的 ImageNode 刷新模型能力（动态下拉框）
        window.dispatchEvent(new CustomEvent('system-config-updated'))
        // 通知打开本窗口的 opener（Eagle 插件）刷新 providers
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage({ type: 'iws-providers-updated' }, '*')
          }
        } catch (_) {}
        if (onSaved) onSaved()
        // page 模式不自动关闭，用户决定何时关；modal 模式 1.5s 后自动关
        if (!isPage) {
          setTimeout(() => {
            if (onClose) onClose()
          }, 1500)
        }
      } else {
        setMessage('保存失败: ' + (result.error || '未知错误'))
      }
    } catch (err) {
      setMessage('保存失败: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
  <div className={isPage ? 'system-settings-page' : 'system-settings-overlay'}>
    <div className={isPage ? 'system-settings-page-inner' : 'system-settings-panel'}>
      <div className="settings-header">
        <h2>{isPage ? '👥 供应商管理' : '⚙️ 系统设置'}</h2>
        <button className="close-btn" onClick={onClose} title={isPage ? '关闭窗口' : '关闭'}>✕</button>
      </div>

      <div className="settings-body">
        {/* 上半部分：全局编辑供应商 */}
        <div className="settings-section">
          <h3 style={{ marginTop: 0 }}>👥 供应商管理</h3>
          <p className="settings-desc" style={{ marginBottom: '15px' }}>统一在此处添加和配置供应商。编辑完成后，点击「暂存此供应商」，即可在下方指定应用。</p>

          <div className="form-group" style={{ marginBottom: '20px' }}>
            <div style={{ display: 'flex', gap: '10px' }}>
              <select
                value={editingProvider ? editingProvider.id : ''}
                onChange={(e) => handleEditSelect(e.target.value)}
                style={{ flex: 1, minWidth: 0, padding: '8px', borderRadius: '4px', background: '#1a1a1a', color: 'white', border: '1px solid #444' }}
              >
                <option value="" disabled>-- 请选择要编辑的供应商 --</option>
                {editingProvider && !config.providers.some(p => p.id === editingProvider.id) && (
                  <option value={editingProvider.id}>
                    {editingProvider.name} [{editingProvider.type === 'image' ? '图片生成' : editingProvider.type === 'chat' ? '对话模型' : '视频生成'}]（未暂存）
                  </option>
                )}
                {config.providers.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} [{p.type === 'image' ? '图片生成' : p.type === 'chat' ? '对话模型' : '视频生成'}]
                  </option>
                ))}
                <option value="new">➕ 新增空白供应商...</option>
              </select>
              <button type="button" onClick={handleCopyProvider} disabled={!editingProvider} style={{ padding: '0 12px', background: !editingProvider ? '#6c757d' : '#0d6efd', color: 'white', border: 'none', borderRadius: '4px', cursor: !editingProvider ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>📋 复制</button>
              <button type="button" onClick={handleRemoveProvider} disabled={!editingProvider || config.providers.length <= 1} style={{ padding: '0 12px', background: !editingProvider || config.providers.length <= 1 ? '#6c757d' : '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: !editingProvider || config.providers.length <= 1 ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>🗑️ 删除</button>
            </div>
          </div>

          {editingProvider && (
            <div style={{ background: '#222', padding: '15px', borderRadius: '8px', border: '1px solid #333' }}>
              <div className="form-row">
                <div className="form-group flex-1">
                  <label>供应商名称</label>
                  <input
                    value={editingProvider.name}
                    onChange={(e) => setEditingProvider(p => ({...p, name: e.target.value}))}
                    placeholder="如: Google Official / SuXi / Runway 等"
                  />
                </div>
                <div className="form-group flex-1">
                  <label>分类类型</label>
                  <select
                    value={editingProvider.type}
                    onChange={(e) => setEditingProvider(p => ({...p, type: e.target.value}))}
                    style={{ width: '100%', padding: '10px 14px', borderRadius: '6px', background: '#1a1a1a', color: 'white', border: '1px solid #444' }}
                  >
                    <option value="image">🎨 图片生成</option>
                    <option value="chat">💬 对话模型</option>
                    <option value="video">🎬 视频生成</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group flex-1">
                  <label>API Key</label>
                  <div className="input-with-toggle">
                    <input
                       type={showKey ? "text" : "password"}
                       value={editingProvider.api_key || ''}
                       onChange={(e) => setEditingProvider(p => ({...p, api_key: e.target.value}))}
                       placeholder="填入API Key"
                    />
                    <button type="button" className="toggle-visibility-btn" onClick={() => setShowKey(!showKey)}>
                      {showKey ? '👁️' : '👁️‍🗨️'}
                    </button>
                  </div>
                </div>
                <div className="form-group flex-1">
                  <label>默认模型名称</label>
                  <input
                    value={editingProvider.model || ''}
                    onChange={(e) => setEditingProvider(p => ({...p, model: e.target.value}))}
                    placeholder={
                      editingProvider.type === 'image' ? "gpt-image-2 / gemini-3.1-flash-image-preview" :
                      editingProvider.type === 'chat' ? "gpt-4o / claude-3-opus" :
                      "sora-2-all / runway-gen3"
                    }
                  />
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: '15px' }}>
                <label>API 地址（可选）</label>
                <input
                  value={editingProvider.api_url || ''}
                  onChange={(e) => setEditingProvider(p => ({...p, api_url: e.target.value}))}
                  placeholder="留空使用官方默认地址，如需中转可填入类似 https://api.openai.com/v1"
                />
              </div>

              <div className="form-group" style={{ marginBottom: '15px' }}>
                <label>协议类型</label>
                <select
                  value={editingProvider.protocol || ''}
                  onChange={(e) => setEditingProvider(p => ({...p, protocol: e.target.value}))}
                  style={{ width: '100%', padding: '10px 14px', borderRadius: '6px', background: '#1a1a1a', color: 'white', border: '1px solid #444' }}
                >
                  <option value="">自动</option>
                  <option value="gemini">Gemini</option>
                  <option value="openai">OpenAI兼容</option>
                  <option value="flow_web">Flow网页自动化</option>
                </select>
              </div>

              <div className="form-group" style={{ marginBottom: '15px' }}>
                <label>可选模型列表</label>
                <textarea
                  value={Array.isArray(editingProvider.models) ? editingProvider.models.join('\n') : ''}
                  onChange={(e) => setEditingProvider(p => ({
                    ...p,
                    models: e.target.value.split(/\r?\n|,/).map(item => item.trim()).filter(Boolean)
                  }))}
                  placeholder="每行一个模型，例如：&#10;gpt-image-2&#10;dall-e-3"
                  style={{ minHeight: '110px' }}
                />
              </div>

              <button type="button" onClick={handleSaveProviderToList} style={{ width: '100%', padding: '10px', background: '#007bff', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>
                ✅ 暂存此供应商信息
              </button>
            </div>
          )}
        </div>

        <hr style={{ margin: '20px 0', borderTop: '1px solid #444' }} />

        {/* 下半部分：应用选择 */}
        <div className="settings-section">
          <h3>🎯 默认应用配置</h3>
          <p className="settings-desc" style={{ marginBottom: '15px' }}>这里只设置默认供应商，主要用于新节点初始值和后端兜底。图片节点里的模型切换请直接在前台节点上完成；如果下拉列表为空，请先在上方管理区域新增对应类型的供应商并暂存。</p>

          <div className="form-row">
            <div className="form-group flex-1">
              <label>🎨 图片生成默认供应商：</label>
              <select
                value={config.active_image_provider_id || ""}
                onChange={(e) => setConfig(prev => ({...prev, active_image_provider_id: e.target.value}))}
                style={{ width: '100%', padding: '10px 14px', borderRadius: '6px', background: '#1a1a1a', color: 'white', border: '1px solid #444' }}
              >
                <option value="" disabled>-- 请选择图片供应商 --</option>
                {config.providers.filter(p => p.type === 'image').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>

            <div className="form-group flex-1">
              <label>💬 对话模型：</label>
              <select
                value={config.active_chat_provider_id || ""}
                onChange={(e) => setConfig(prev => ({...prev, active_chat_provider_id: e.target.value}))}
                style={{ width: '100%', padding: '10px 14px', borderRadius: '6px', background: '#1a1a1a', color: 'white', border: '1px solid #444' }}
              >
                <option value="" disabled>-- 请选择对话供应商 --</option>
                {config.providers.filter(p => p.type === 'chat').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>

            <div className="form-group flex-1">
              <label>🎬 视频生成：</label>
              <select
                value={config.active_video_provider_id || ""}
                onChange={(e) => setConfig(prev => ({...prev, active_video_provider_id: e.target.value}))}
                style={{ width: '100%', padding: '10px 14px', borderRadius: '6px', background: '#1a1a1a', color: 'white', border: '1px solid #444' }}
              >
                <option value="" disabled>-- 请选择视频供应商 --</option>
                {config.providers.filter(p => p.type === 'video').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
        </div>

        <hr style={{ margin: '20px 0', borderTop: '1px solid #444' }} />

        {/* 通用设置 */}
        <div className="settings-section">
          <h3>🔧 通用设置</h3>
          <div className="form-row">
            <div className="form-group flex-1">
              <label>翻墙代理（图片/视频生成用）</label>
              <input
                type="text"
                value={config.proxy_url}
                onChange={(e) => setConfig({...config, proxy_url: e.target.value})}
                placeholder="socks5://127.0.0.1:10808"
              />
              <small>仅用于访问 Google 官方 API（对话模型不需要）</small>
            </div>
            <div className="form-group flex-1">
              <label>输出目录</label>
              <input
                type="text"
                value={config.output_dir}
                onChange={(e) => setConfig({...config, output_dir: e.target.value})}
                placeholder="默认: backend/outputs"
              />
            </div>
          </div>
        </div>

        {message && (
          <div className={`settings-message ${message.includes('失败') ? 'error' : 'success'}`}>
            {message}
          </div>
        )}
      </div>

      <div className="settings-footer">
        <button className="cancel-btn" onClick={onClose}>{isPage ? '关闭窗口' : '取消'}</button>
        <button className="save-btn" onClick={handleSave} disabled={loading}>
          {loading ? '保存中...' : '💾 保存全部配置并生效'}
        </button>
      </div>
    </div>
  </div>
  )
}

export default SystemSettings
