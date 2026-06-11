// 故事板创建弹窗
//
// 用法：
//   <StoryboardCreateModal
//     anchor={{ x: 100, y: 200 }}  // 画布坐标系下的锚点
//     onClose={() => setModal(null)}
//     onConfirm={(payload) => handleCreateStoryboard(payload)}
//   />
//
// onConfirm 回调参数 (payload):
//   {
//     layoutId: '1x4' | '2x2' | '3x2' | '3x3',
//     providerId: string,
//     model: string,
//     aspectRatio: string,
//     resolution: string,
//     anchor: { x, y },
//   }

import React, { useEffect, useMemo, useState } from 'react'
import { getSystemConfig } from '../../utils/api'
import { getModelCapabilities, ensureSupported } from '../../utils/modelCapabilities'
import {
  LAYOUTS,
  DEFAULT_LAYOUT_ID,
  getSlotCount,
} from './storyboardLayouts'
import './Storyboard.css'

function StoryboardCreateModal({ anchor, onClose, onConfirm }) {
  const [providers, setProviders] = useState([])
  const [activeProviderId, setActiveProviderId] = useState('')
  const [layoutId, setLayoutId] = useState(DEFAULT_LAYOUT_ID)
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [aspectRatio, setAspectRatio] = useState('1:1')
  const [resolution, setResolution] = useState('2K')
  const [loading, setLoading] = useState(true)

  // 加载 system_config 的 image providers
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const result = await getSystemConfig()
        if (cancelled) return
        if (result.success && result.config) {
          const all = result.config.providers || []
          const imageOnly = all.filter((p) => p.type === 'image')
          const active = result.config.active_image_provider_id || ''
          setProviders(imageOnly)
          setActiveProviderId(active)
          // 默认选 active；如果 active 不在 image 列表里，回退到第一个
          const pick = imageOnly.find((p) => p.id === active)
            ? active
            : (imageOnly[0]?.id || '')
          setSelectedProviderId(pick)
        }
      } catch (e) {
        console.warn('[Storyboard] 加载 system_config 失败:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // 选中的 provider 对象（模型名 + 能力）
  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId) || null,
    [providers, selectedProviderId]
  )
  const capabilities = useMemo(
    () => getModelCapabilities(selectedProvider?.model || ''),
    [selectedProvider]
  )

  // provider 变化时，校验当前比例/分辨率是否还支持，不支持就 fallback
  useEffect(() => {
    if (!selectedProvider) return
    setAspectRatio((prev) => ensureSupported(prev, capabilities.aspectRatios, '1:1'))
    setResolution((prev) => ensureSupported(prev, capabilities.resolutions, '2K'))
  }, [selectedProvider, capabilities.aspectRatios, capabilities.resolutions])

  // 排序：active 排第一，其他按名字升序
  const sortedProviders = useMemo(() => {
    if (!providers.length) return []
    const active = providers.find((p) => p.id === activeProviderId)
    const others = providers
      .filter((p) => p.id !== activeProviderId)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    return active ? [active, ...others] : others
  }, [providers, activeProviderId])

  const slotCount = getSlotCount(layoutId)
  const canSubmit = !!selectedProviderId && slotCount > 0

  const handleConfirm = () => {
    if (!canSubmit) return
    onConfirm({
      layoutId,
      providerId: selectedProviderId,
      model: selectedProvider?.model || '',
      aspectRatio,
      resolution,
      anchor,
    })
  }

  // ESC 关闭
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="storyboard-modal-overlay" onClick={onClose}>
      <div className="storyboard-modal" onClick={(e) => e.stopPropagation()}>
        <div className="storyboard-modal-header">
          <h3>📑 创建故事板组</h3>
          <button className="storyboard-modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="storyboard-modal-body">
          {/* 1. 选预设布局 */}
          <div className="storyboard-section">
            <div className="storyboard-section-title">📐 预设布局</div>
            <div className="storyboard-layout-list">
              {Object.values(LAYOUTS).map((layout) => (
                <div
                  key={layout.id}
                  className={`storyboard-layout-option ${layoutId === layout.id ? 'selected' : ''}`}
                  onClick={() => setLayoutId(layout.id)}
                >
                  <div className="storyboard-layout-option-name">{layout.name}</div>
                  <div className="storyboard-layout-option-desc">{layout.description}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 2. 默认参数 */}
          <div className="storyboard-section">
            <div className="storyboard-section-title">⚙️ 默认参数（每格仍可单独编辑）</div>

            <div className="storyboard-field" style={{ marginBottom: 10 }}>
              <label>图片供应商</label>
              <select
                value={selectedProviderId}
                onChange={(e) => setSelectedProviderId(e.target.value)}
                disabled={loading || sortedProviders.length === 0}
              >
                {loading && <option value="">加载中...</option>}
                {!loading && sortedProviders.length === 0 && (
                  <option value="">⚠️ 未配置图片供应商（请先到系统设置添加）</option>
                )}
                {sortedProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === activeProviderId ? '⭐ ' : ''}{p.name}
                    {p.model ? ` — ${p.model}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="storyboard-row">
              <div className="storyboard-field">
                <label>比例</label>
                <select
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value)}
                  disabled={loading}
                >
                  {capabilities.aspectRatios.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              <div className="storyboard-field">
                <label>分辨率</label>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  disabled={loading}
                >
                  {capabilities.resolutions.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* 3. 预览摘要 */}
          <div className="storyboard-section">
            <div className="storyboard-summary">
              将在画布上创建 <b>{slotCount}</b> 个空图片节点（{LAYOUTS[layoutId]?.name}），
              {layoutId === '1x4'
                ? <> 自动预填 <b>主图 / 结构图 / 材质图 / 场景图</b> 四段 prompt 骨架，</>
                : <> </>
              }
              每格仍可独立编辑提示词与参考图。
            </div>
          </div>
        </div>

        <div className="storyboard-modal-footer">
          <button className="storyboard-btn storyboard-btn-cancel" onClick={onClose}>
            取消
          </button>
          <button
            className="storyboard-btn storyboard-btn-primary"
            onClick={handleConfirm}
            disabled={!canSubmit}
          >
            创建 {slotCount} 个节点
          </button>
        </div>
      </div>
    </div>
  )
}

export default StoryboardCreateModal
