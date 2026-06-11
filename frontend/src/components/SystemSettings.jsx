import React, { useState, useEffect } from 'react'
import { getSystemConfig, updateSystemConfig } from '../utils/api'
import { setFeatureFlag, getAllFeatureFlags, FLAGS } from '../utils/featureFlags'

function SystemSettings({ onClose, onSaved }) {
  const [config, setConfig] = useState({
    providers: [],
    active_image_provider_id: '',
    active_chat_provider_id: '',
    active_video_provider_id: '',
    proxy_url: '',
    output_dir: '',
    // Task 27 / Requirement C4 Open Q4：生图历史机器身份
    machine_id: '',
    peer_machines: [],
    history_store_path: '',
    history_store_max_mb: 50,
    history_recorder_enabled: true,
  })

  // 当前正在编辑的供应商，暂存在这里，点击保存到列表才生效
  const [editingProvider, setEditingProvider] = useState(null)

  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [showKey, setShowKey] = useState(false)

  // 实验功能开关 - localStorage 持久化，跟后端 system_config.json 解耦
  const [featureFlags, setFeatureFlagsState] = useState(() => getAllFeatureFlags())

  const handleToggleFlag = (key, value) => {
    const next = setFeatureFlag(key, value)
    setFeatureFlagsState(next)
  }

  useEffect(() => {
    loadConfig()
  }, [])

  const loadConfig = async () => {
    const result = await getSystemConfig()
    if (result.success && result.config) {
      const providers = result.config.providers || [];
      setConfig({
        providers: providers,
        active_image_provider_id: result.config.active_image_provider_id || '',
        active_chat_provider_id: result.config.active_chat_provider_id || '',
        active_video_provider_id: result.config.active_video_provider_id || '',
        proxy_url: result.config.proxyUrl || '',
        output_dir: result.config.outputDir || '',
        // Task 27：机器身份字段
        machine_id: result.config.machine_id || '',
        peer_machines: Array.isArray(result.config.peer_machines)
          ? result.config.peer_machines.map(p => ({
              machine_id: p?.machine_id || '',
              base_url: p?.base_url || ''
            }))
          : [],
        history_store_path: result.config.history_store_path || '',
        history_store_max_mb:
          typeof result.config.history_store_max_mb === 'number'
            ? result.config.history_store_max_mb
            : 50,
        history_recorder_enabled:
          result.config.history_recorder_enabled !== false, // 默认开启
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
        model: '',
        protocol: '',
        provider_channel: '',
        poll_timeout_seconds: '',
        poll_interval_ms: '',
        input_fidelity: '',
        response_format: 'url',
        hasKey: false,
      });
    } else {
      const p = config.providers.find(x => x.id === id);
      if (p) setEditingProvider({ ...p });
    }
    setShowKey(false);
  }

  const handleSaveProviderToList = () => {
    if (!editingProvider.name.trim()) {
      alert("请输入供应商名称");
      return;
    }

    setConfig(prev => {
      const exists = prev.providers.some(p => p.id === editingProvider.id);
      let newProviders;
      if (exists) {
        newProviders = prev.providers.map(p => p.id === editingProvider.id ? editingProvider : p);
      } else {
        newProviders = [...prev.providers, editingProvider];
      }

      let newImageId = prev.active_image_provider_id;
      let newChatId = prev.active_chat_provider_id;
      let newVideoId = prev.active_video_provider_id;

      // 如果当前类型的 active 是空，自动选中它
      if (editingProvider.type === 'image' && !newImageId) newImageId = editingProvider.id;
      if (editingProvider.type === 'chat' && !newChatId) newChatId = editingProvider.id;
      if (editingProvider.type === 'video' && !newVideoId) newVideoId = editingProvider.id;

      // 如果修改了分类类型，旧的激活态需要清空（比如原来是图片，现在改成视频，那么不能让它继续作为图片生图的选项）
      if (newImageId === editingProvider.id && editingProvider.type !== 'image') newImageId = '';
      if (newChatId === editingProvider.id && editingProvider.type !== 'chat') newChatId = '';
      if (newVideoId === editingProvider.id && editingProvider.type !== 'video') newVideoId = '';

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

  // ============ Task 27：机器身份字段操作 ============
  const handleAddPeer = () => {
    setConfig(prev => ({
      ...prev,
      peer_machines: [...(prev.peer_machines || []), { machine_id: '', base_url: '' }]
    }))
  }

  const handleRemovePeer = (idx) => {
    setConfig(prev => ({
      ...prev,
      peer_machines: (prev.peer_machines || []).filter((_, i) => i !== idx)
    }))
  }

  const handleUpdatePeer = (idx, field, value) => {
    setConfig(prev => ({
      ...prev,
      peer_machines: (prev.peer_machines || []).map((p, i) =>
        i === idx ? { ...p, [field]: value } : p
      )
    }))
  }

  // Requirement 22.3：base_url 必须以 http:// 或 https:// 开头，否则后端会跳过
  const isValidPeerUrl = (url) => {
    if (!url) return true // 空串不提示，交给保存时过滤
    return /^https?:\/\//i.test(url)
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
      const exists = currentProviders.some(p => p.id === editingProvider.id);
      if (exists) {
        currentProviders = currentProviders.map(p => p.id === editingProvider.id ? editingProvider : p);
      } else {
        currentProviders = [...currentProviders, editingProvider];
      }

      if (editingProvider.type === 'image' && !currentImageId) currentImageId = editingProvider.id;
      if (editingProvider.type === 'chat' && !currentChatId) currentChatId = editingProvider.id;
      if (editingProvider.type === 'video' && !currentVideoId) currentVideoId = editingProvider.id;

      if (currentImageId === editingProvider.id && editingProvider.type !== 'image') currentImageId = '';
      if (currentChatId === editingProvider.id && editingProvider.type !== 'chat') currentChatId = '';
      if (currentVideoId === editingProvider.id && editingProvider.type !== 'video') currentVideoId = '';
    }

    try {
      const savePayload = {
        providers: currentProviders,
        active_image_provider_id: currentImageId,
        active_chat_provider_id: currentChatId,
        active_video_provider_id: currentVideoId,
        proxy_url: config.proxy_url,
        output_dir: config.output_dir,
        // Task 27 / Requirement C4 Open Q4：机器身份
        machine_id: (config.machine_id || '').trim(),
        peer_machines: (config.peer_machines || [])
          .map(p => ({
            machine_id: (p?.machine_id || '').trim(),
            base_url: (p?.base_url || '').trim()
          }))
          // 两个字段都空的行直接丢掉，不污染配置
          .filter(p => p.machine_id || p.base_url),
        history_store_max_mb: Number(config.history_store_max_mb) || 50,
        history_recorder_enabled: config.history_recorder_enabled !== false,
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
        setMessage('配置已保存！')
        await loadConfig()
        // 通知画布上的 ImageNode 刷新模型能力（动态下拉框）
        window.dispatchEvent(new CustomEvent('system-config-updated'))
        if (onSaved) onSaved()
        setTimeout(() => {
          if (onClose) onClose()
        }, 1500)
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
    <div className="system-settings-overlay">
      <div className="system-settings-panel">
        <div className="settings-header">
          <h2>⚙️ 系统设置</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
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
                  style={{ flex: 1, padding: '8px', borderRadius: '4px', background: '#1a1a1a', color: 'white', border: '1px solid #444' }}
                >
                  <option value="" disabled>-- 请选择要编辑的供应商 --</option>
                  {config.providers.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} [{p.type === 'image' ? '图片生成' : p.type === 'chat' ? '对话模型' : '视频生成'}]
                    </option>
                  ))}
                  <option value="new">➕ 新增空白供应商...</option>
                </select>
                <button type="button" onClick={handleRemoveProvider} disabled={!editingProvider || config.providers.length <= 1} style={{ padding: '0 12px', background: !editingProvider || config.providers.length <= 1 ? '#6c757d' : '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: !editingProvider || config.providers.length <= 1 ? 'not-allowed' : 'pointer' }}>🗑️ 删除</button>
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
                      value={editingProvider.model}
                      onChange={(e) => setEditingProvider(p => ({...p, model: e.target.value}))}
                      placeholder={
                        editingProvider.type === 'image' ? "gemini-3-pro-image-preview" :
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

                <div className="form-row">
                  <div className="form-group flex-1">
                    <label>Protocol</label>
                    <input
                      value={editingProvider.protocol || ''}
                      onChange={(e) => setEditingProvider(p => ({...p, protocol: e.target.value}))}
                      placeholder="openai_images_async"
                    />
                  </div>
                  <div className="form-group flex-1">
                    <label>Provider Channel</label>
                    <input
                      value={editingProvider.provider_channel || ''}
                      onChange={(e) => setEditingProvider(p => ({...p, provider_channel: e.target.value}))}
                      placeholder="main / backup / fast"
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group flex-1">
                    <label>Poll Timeout Seconds</label>
                    <input
                      type="number"
                      value={editingProvider.poll_timeout_seconds || ''}
                      onChange={(e) => setEditingProvider(p => ({...p, poll_timeout_seconds: e.target.value}))}
                      placeholder="1800"
                    />
                  </div>
                  <div className="form-group flex-1">
                    <label>Poll Interval Ms</label>
                    <input
                      type="number"
                      value={editingProvider.poll_interval_ms || ''}
                      onChange={(e) => setEditingProvider(p => ({...p, poll_interval_ms: e.target.value}))}
                      placeholder="1500"
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group flex-1">
                    <label>Input Fidelity</label>
                    <input
                      value={editingProvider.input_fidelity || ''}
                      onChange={(e) => setEditingProvider(p => ({...p, input_fidelity: e.target.value}))}
                      placeholder="low / high"
                    />
                  </div>
                  <div className="form-group flex-1">
                    <label>Response Format</label>
                    <select
                      value={editingProvider.response_format || 'url'}
                      onChange={(e) => setEditingProvider(p => ({...p, response_format: e.target.value}))}
                    >
                      <option value="url">url</option>
                      <option value="b64_json">b64_json</option>
                    </select>
                  </div>
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
            <h3>🎯 当前应用配置</h3>
            <p className="settings-desc" style={{ marginBottom: '15px' }}>在下方选择不同功能要调用的供应商。如果下拉列表为空，请先在上方管理区域新增对应类型的供应商并暂存。</p>

            <div className="form-row">
              <div className="form-group flex-1">
                <label>🎨 图片生成：</label>
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

          <hr style={{ margin: '20px 0', borderTop: '1px solid #444' }} />

          {/* Task 27 / Requirement C4 Open Q4：机器身份 + 生图历史聚合 */}
          <div className="settings-section">
            <h3>🖥️ 机器身份（生图历史聚合）</h3>
            <p className="settings-desc" style={{ marginBottom: '15px' }}>
              配置本机标识和跨机聚合。保存后需要<b>重启后端</b>才能生效（启动时读取）。
              查看实际生效配置：<code>GET /api/history/config</code>
            </p>

            <div className="form-row">
              <div className="form-group flex-1">
                <label>本机 machine_id</label>
                <input
                  type="text"
                  value={config.machine_id}
                  onChange={(e) => setConfig({ ...config, machine_id: e.target.value })}
                  placeholder="例如: pc1 / pc2（留空则用主机名小写兜底）"
                />
                <small>写入生图历史记录的 machine_id 字段，用于区分来自哪台机器</small>
              </div>
              <div className="form-group flex-1">
                <label>JSONL 单文件上限 (MB)</label>
                <input
                  type="number"
                  min="1"
                  value={config.history_store_max_mb}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      history_store_max_mb: parseInt(e.target.value, 10) || 50,
                    })
                  }
                  placeholder="默认 50"
                />
                <small>超过上限自动滚动切分为历史文件</small>
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: '15px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={config.history_recorder_enabled !== false}
                  onChange={(e) =>
                    setConfig({ ...config, history_recorder_enabled: e.target.checked })
                  }
                  style={{ width: '16px', height: '16px' }}
                />
                <span>启用生图历史记录（Recorder）</span>
              </label>
              <small style={{ display: 'block', marginTop: '4px' }}>
                关闭后 /api/generate 不再写入 JSONL（紧急降级开关，Req C4）
              </small>
            </div>

            {config.history_store_path && (
              <div className="form-group" style={{ marginBottom: '15px' }}>
                <label>历史文件路径（只读）</label>
                <input
                  type="text"
                  value={config.history_store_path}
                  disabled
                  style={{ opacity: 0.7 }}
                />
                <small>需要改路径请直接编辑 system_config.json 里的 history_store_path</small>
              </div>
            )}

            <div style={{ marginTop: '20px' }}>
              <label style={{ display: 'block', marginBottom: '10px' }}>
                其他机器（peer_machines）
              </label>
              <p className="settings-desc" style={{ marginBottom: '10px', fontSize: '12px' }}>
                配置要聚合历史记录的其他机器。<code>base_url</code> 必须以 <code>http://</code> 或 <code>https://</code> 开头，否则后端启动时会跳过。
              </p>

              {(config.peer_machines || []).length === 0 && (
                <div style={{ padding: '12px', background: '#1a1a1a', borderRadius: '6px', color: '#888', fontSize: '13px' }}>
                  暂无 peer，点击下方"➕ 添加 peer"新增一行
                </div>
              )}

              {(config.peer_machines || []).map((peer, idx) => {
                const urlValid = isValidPeerUrl(peer.base_url)
                return (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      gap: '10px',
                      alignItems: 'flex-start',
                      marginBottom: '10px',
                      padding: '10px',
                      background: '#1a1a1a',
                      borderRadius: '6px',
                      border: '1px solid #333',
                    }}
                  >
                    <div style={{ flex: '0 0 140px' }}>
                      <input
                        type="text"
                        value={peer.machine_id || ''}
                        onChange={(e) => handleUpdatePeer(idx, 'machine_id', e.target.value)}
                        placeholder="machine_id (pc2)"
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <input
                        type="text"
                        value={peer.base_url || ''}
                        onChange={(e) => handleUpdatePeer(idx, 'base_url', e.target.value)}
                        placeholder="base_url (http://192.168.110.120:5001)"
                        style={{
                          width: '100%',
                          border: urlValid ? undefined : '1px solid #ff9800',
                        }}
                      />
                      {!urlValid && (
                        <small style={{ color: '#ff9800', display: 'block', marginTop: '4px' }}>
                          ⚠️ 必须以 http:// 或 https:// 开头，否则后端会跳过此 peer
                        </small>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemovePeer(idx)}
                      style={{
                        padding: '8px 12px',
                        background: '#dc3545',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                      title="删除此 peer"
                    >
                      ✕
                    </button>
                  </div>
                )
              })}

              <button
                type="button"
                onClick={handleAddPeer}
                style={{
                  padding: '8px 14px',
                  background: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                ➕ 添加 peer
              </button>
            </div>
          </div>

          <hr style={{ margin: '20px 0', borderTop: '1px solid #444' }} />

          {/* 实验功能 (Feature Flags) - 存 localStorage，不写后端配置 */}
          <div className="settings-section">
            <h3>🧪 实验功能 (Beta)</h3>
            <p className="settings-desc" style={{ marginBottom: '15px' }}>
              这些功能正在开发中，可能不稳定。开关<b>本地立即生效</b>，跟下方「保存配置」按钮无关；PC1/PC2 各自独立设置。
            </p>

            <div className="form-group" style={{ marginBottom: '15px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!featureFlags.storyboardEnabled}
                  onChange={(e) => handleToggleFlag(FLAGS.STORYBOARD_ENABLED, e.target.checked)}
                  style={{ width: '16px', height: '16px' }}
                />
                <span>📑 启用故事板 (v2.3.0-beta)</span>
              </label>
              <small style={{ display: 'block', marginTop: '4px' }}>
                开启后可在画布<b>右键</b>菜单看到「创建故事板组」入口，支持多分镜套图 + 抽卡。
                关闭后该入口完全隐藏，行为跟现在 100% 一致。
              </small>
            </div>
          </div>

          {message && (
            <div className={`settings-message ${message.includes('失败') ? 'error' : 'success'}`}>
              {message}
            </div>
          )}
        </div>

        <div className="settings-footer">
          <button className="cancel-btn" onClick={onClose}>取消</button>
          <button className="save-btn" onClick={handleSave} disabled={loading}>
            {loading ? '保存中...' : '💾 保存全部配置并生效'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default SystemSettings
