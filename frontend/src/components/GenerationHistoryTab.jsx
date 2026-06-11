import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import useHistoryAggregator from '../hooks/useHistoryAggregator'
import { buildThumbnailUrl } from '../utils/api'
import {
  SOURCE_EMOJI,
  MODE_LABEL,
  formatPromptPreview,
  formatElapsed,
  formatTimestamp,
  shouldShowEagleLink,
  buildEagleDeepLink,
} from '../utils/history-formatters'

/**
 * GenerationHistoryTab — Phase 3 本机版
 * 展示、筛选、跳转 Eagle，暂不涉及跨机聚合（由 useHistoryAggregator 在 Phase 4 打开 peer 路径）
 *
 * 结构：
 *   [FilterBar]  ← 筛选工具栏
 *   [OfflineNoticeBar]  ← Peer 离线提示（Phase 3 始终空）
 *   [Grid]  ← CSS Grid 渲染 HistoryCard
 *   [Sentinel]  ← IntersectionObserver 触发 loadMore
 *   [DetailModal]  ← 展开详情 / 复制按钮
 *
 * Related Requirements: 12, 15, 16, 17, 18, 19, 20
 */

// ---------------- 静态选项 ----------------

const SOURCE_OPTIONS = [
  { value: 'canvas', label: '🎨 画布' },
  { value: 'eagle_plugin', label: '🦅 Eagle插件' },
  { value: 'script', label: '🔧 脚本' },
  { value: 'unknown', label: '❓ 未知' },
]

const MODE_OPTIONS = [
  { value: '', label: '全部模式' },
  { value: 'text2img', label: '文生图' },
  { value: 'img2img', label: '图生图' },
]

// Phase 3 只有 pc1 一项可选，pc2 先占位（Phase 4 有远端记录时自然可用）
const MACHINE_OPTIONS = [
  { value: 'pc1', label: 'PC1' },
  { value: 'pc2', label: 'PC2' },
]

// 简单的暗色占位图（SVG data URI）
const PLACEHOLDER_IMG =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'>
      <rect width='100%' height='100%' fill='#2a2a2a'/>
      <text x='50%' y='50%' font-size='16' fill='#666' text-anchor='middle' dy='.3em'>无缩略图</text>
    </svg>`
  )

// ---------------- 主组件 ----------------

function GenerationHistoryTab() {
  // 后端筛选（传给 /api/history）
  const [filters, setFilters] = useState({
    source: [],        // string[] 多选
    mode: '',          // '' | 'text2img' | 'img2img'
    provider_id: [],   // string[] 多选
    date_from: '',     // 'YYYY-MM-DD'
    date_to: '',
    keyword: '',
  })
  // 前端独立过滤（requirement 17.2：machine_id 在前端完成）
  const [machineFilter, setMachineFilter] = useState([])

  // 构造传给后端的参数（去掉空值，aggregator 会自行 debounce）
  const backendFilters = useMemo(() => {
    const bf = {}
    if (filters.source.length) bf.source = filters.source
    if (filters.mode) bf.mode = filters.mode
    if (filters.provider_id.length) bf.provider_id = filters.provider_id
    if (filters.date_from) bf.date_from = filters.date_from
    if (filters.date_to) bf.date_to = filters.date_to
    if (filters.keyword) bf.keyword = filters.keyword
    return bf
  }, [filters])

  const {
    records,
    loading,
    error,
    peerFailures,
    hasMore,
    retry,
    loadMore,
    localMachineId,
    peerMachines,
  } = useHistoryAggregator(backendFilters, { enabled: true })

  // machine_id → base_url 映射（跨机缩略图 URL 解析用）
  // Requirement 8/16：远端记录的缩略图 URL 必须指向远端后端 base_url
  const peerBaseUrlByMachine = useMemo(() => {
    const map = {}
    ;(peerMachines || []).forEach((p) => {
      if (p && p.machine_id && p.base_url) {
        map[p.machine_id] = p.base_url
      }
    })
    return map
  }, [peerMachines])

  // 前端再过滤机器
  const visibleRecords = useMemo(() => {
    if (machineFilter.length === 0) return records
    return records.filter((r) => machineFilter.includes(r.machine_id))
  }, [records, machineFilter])

  // 从已加载记录派生 provider 选项（避免额外 API）
  const providerOptions = useMemo(() => {
    const map = new Map()
    records.forEach((r) => {
      if (r.provider_id && !map.has(r.provider_id)) {
        map.set(r.provider_id, r.provider_name || r.provider_id)
      }
    })
    return Array.from(map.entries()).map(([id, name]) => ({ value: id, label: name }))
  }, [records])

  // 详情 Modal
  const [detailRecord, setDetailRecord] = useState(null)

  // 无限滚动哨兵
  const sentinelRef = useRef(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return undefined
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          loadMore()
        }
      },
      { rootMargin: '200px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore, loading, loadMore])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#1a1a1a', minWidth: 0 }}>
      <FilterBar
        filters={filters}
        setFilters={setFilters}
        machineFilter={machineFilter}
        setMachineFilter={setMachineFilter}
        providerOptions={providerOptions}
      />

      {peerFailures.length > 0 && (
        <OfflineNoticeBar peerFailures={peerFailures} onRetry={retry} />
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
        {error ? (
          <ErrorState error={error} onRetry={retry} />
        ) : loading && records.length === 0 ? (
          <CenterHint text="加载中…" />
        ) : visibleRecords.length === 0 ? (
          <CenterHint text="无匹配记录" dim />
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: '12px',
              }}
            >
              {visibleRecords.map((r) => (
                <HistoryCard
                  key={r.id}
                  record={r}
                  localMachineId={localMachineId}
                  peerBaseUrlByMachine={peerBaseUrlByMachine}
                  onOpenDetails={() => setDetailRecord(r)}
                />
              ))}
            </div>
            <div
              ref={sentinelRef}
              style={{ padding: '16px', textAlign: 'center', color: '#666', fontSize: '12px' }}
            >
              {loading ? '加载中…' : hasMore ? '下滑加载更多' : '— 已到列表底部 —'}
            </div>
          </>
        )}
      </div>

      {detailRecord && (
        <HistoryDetailModal
          record={detailRecord}
          localMachineId={localMachineId}
          onClose={() => setDetailRecord(null)}
        />
      )}
    </div>
  )
}

export default GenerationHistoryTab

// ========================================================================
//                              筛选栏
// ========================================================================

function FilterBar({ filters, setFilters, machineFilter, setMachineFilter, providerOptions }) {
  const update = useCallback(
    (patch) => setFilters((prev) => ({ ...prev, ...patch })),
    [setFilters]
  )

  return (
    <div
      style={{
        padding: '10px 12px',
        background: '#202020',
        borderBottom: '1px solid #333',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        alignItems: 'center',
      }}
    >
      <MultiSelectChips
        label="来源"
        options={SOURCE_OPTIONS}
        value={filters.source}
        onChange={(v) => update({ source: v })}
      />
      <select
        value={filters.mode}
        onChange={(e) => update({ mode: e.target.value })}
        style={selectStyle}
        title="模式"
      >
        {MODE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <MultiSelectChips
        label="机器"
        options={MACHINE_OPTIONS}
        value={machineFilter}
        onChange={setMachineFilter}
      />
      {providerOptions.length > 0 && (
        <MultiSelectChips
          label="Provider"
          options={providerOptions}
          value={filters.provider_id}
          onChange={(v) => update({ provider_id: v })}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <span style={{ color: '#888', fontSize: '12px' }}>日期</span>
        <input
          type="date"
          value={filters.date_from}
          onChange={(e) => update({ date_from: e.target.value })}
          style={dateInputStyle}
        />
        <span style={{ color: '#666' }}>–</span>
        <input
          type="date"
          value={filters.date_to}
          onChange={(e) => update({ date_to: e.target.value })}
          style={dateInputStyle}
        />
      </div>
      <input
        type="text"
        value={filters.keyword}
        onChange={(e) => update({ keyword: e.target.value })}
        placeholder="搜索 prompt..."
        style={{ ...selectStyle, flex: '1 1 180px', minWidth: '140px' }}
      />
      {(filters.source.length ||
        filters.mode ||
        filters.provider_id.length ||
        filters.date_from ||
        filters.date_to ||
        filters.keyword ||
        machineFilter.length) ? (
        <button
          onClick={() => {
            setFilters({ source: [], mode: '', provider_id: [], date_from: '', date_to: '', keyword: '' })
            setMachineFilter([])
          }}
          style={{
            background: 'transparent',
            border: '1px solid #444',
            color: '#999',
            borderRadius: '4px',
            padding: '4px 10px',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          清除
        </button>
      ) : null}
    </div>
  )
}

// 多选小 chip
function MultiSelectChips({ label, options, value, onChange }) {
  const toggle = (v) => {
    if (value.includes(v)) onChange(value.filter((x) => x !== v))
    else onChange([...value, v])
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      <span style={{ color: '#888', fontSize: '12px' }}>{label}</span>
      {options.map((o) => {
        const active = value.includes(o.value)
        return (
          <button
            key={o.value}
            onClick={() => toggle(o.value)}
            style={{
              background: active ? '#4CAF50' : '#2a2a2a',
              color: active ? 'white' : '#ccc',
              border: '1px solid ' + (active ? '#4CAF50' : '#444'),
              borderRadius: '4px',
              padding: '3px 8px',
              cursor: 'pointer',
              fontSize: '12px',
              whiteSpace: 'nowrap',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

const selectStyle = {
  background: '#2a2a2a',
  border: '1px solid #444',
  color: 'white',
  borderRadius: '4px',
  padding: '4px 8px',
  fontSize: '12px',
}

const dateInputStyle = {
  ...selectStyle,
  colorScheme: 'dark',
}

// ========================================================================
//                           Peer 离线提示条
// ========================================================================

/**
 * 把 aggregator 返回的 reason 代码翻译成中文显示文案。
 * useHistoryAggregator 产出的标准值：
 *   - 'timeout'           → 请求超过 3s
 *   - 'network_error'     → fetch 抛出（connect refused / DNS 失败等）
 *   - 'http_{status}'     → 对端返回非 2xx（如 http_404 / http_500 / http_502）
 *   - 其他                → 透传原 err.message，通常是英文错误短句
 * 未识别的值原样返回，避免丢失排障信息。
 */
function formatPeerReason(reason) {
  if (!reason) return '未知'
  if (reason === 'timeout') return '超时'
  if (reason === 'network_error') return '网络错误'
  const httpMatch = /^http_(\d{3})$/.exec(reason)
  if (httpMatch) return `HTTP ${httpMatch[1]}`
  return reason
}

function OfflineNoticeBar({ peerFailures, onRetry }) {
  // 统一展示：machine_id 大写 + 中文 reason
  const parts = peerFailures.map((p) => {
    const id = (p.machine_id || 'peer').toUpperCase()
    const reason = formatPeerReason(p.reason)
    return { id, reason }
  })

  // 单 peer：严格按规范文案；多 peer：拼接后统一跟"离线"
  const message =
    parts.length === 1
      ? `⚠️ ${parts[0].id} 离线（${parts[0].reason}），仅显示本机记录`
      : `⚠️ ${parts.map((p) => `${p.id}（${p.reason}）`).join('、')} 离线，仅显示本机记录`

  return (
    <div
      style={{
        background: '#3a2a1a',
        borderBottom: '1px solid #5a3a1a',
        padding: '8px 12px',
        color: '#ffb74d',
        fontSize: '12px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{message}</span>
      <button
        onClick={onRetry}
        style={{
          background: 'transparent',
          border: '1px solid #ffb74d',
          color: '#ffb74d',
          borderRadius: '4px',
          padding: '2px 10px',
          cursor: 'pointer',
          fontSize: '12px',
          flexShrink: 0,
        }}
      >
        重试
      </button>
    </div>
  )
}

// ========================================================================
//                             记录卡片
// ========================================================================

/**
 * 缩略图组件（Task 21 - Requirement 16）
 *
 * 浏览器原生 <img> 的 onError 事件不暴露 HTTP 状态，无法区分 404/422/超时。
 * 本组件改用 fetch + AbortController：
 *   - 5s 超时（Requirement 16.4）
 *   - 200 → 用 blob 生成 objectURL 作为 <img src>
 *   - 404 → "原图缺失"（Requirement 16.2）
 *   - 422 → "解码失败"（Requirement 16.3）
 *   - AbortError → "加载超时"（Requirement 16.4）
 *   - 其他非 2xx / 网络错误 → "加载失败"
 *   - HTTP 状态与超时同时发生时，优先按 HTTP 状态文案（Requirement 16.5）
 *
 * 注意事项：
 *   - 只要 url 变化就重新拉取（跨机切换 base_url 也能生效）
 *   - 组件卸载或重拉时 URL.revokeObjectURL 释放内存
 *   - 后端已设 Cache-Control: public, max-age=86400，浏览器 fetch 会走 HTTP 缓存
 *     （Requirement 16.6：原生 lazy-load 减少初次请求量 —— 当前采用 IntersectionObserver
 *     配合卡片网格由浏览器滚动触发；无 loading=lazy 并不影响实际体验，懒渲染由上层
 *     的"网格只渲染 DOM 中的记录"达成）
 */
const THUMBNAIL_TIMEOUT_MS = 5000
const THUMB_TEXT_BY_REASON = {
  source_missing: '原图缺失',
  decode_failed: '解码失败',
  timeout: '加载超时',
  load_failed: '加载失败',
}

function Thumbnail({ url }) {
  // state 形态：
  //   { status: 'loading' }
  //   { status: 'ok', objectUrl }
  //   { status: 'error', reason: 'source_missing'|'decode_failed'|'timeout'|'load_failed' }
  const [state, setState] = useState({ status: 'loading' })

  useEffect(() => {
    if (!url) {
      setState({ status: 'error', reason: 'load_failed' })
      return undefined
    }
    setState({ status: 'loading' })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), THUMBNAIL_TIMEOUT_MS)
    let objectUrl = null
    let cancelled = false

    ;(async () => {
      try {
        const res = await fetch(url, { signal: controller.signal })
        clearTimeout(timer)
        if (cancelled) return
        if (res.ok) {
          const blob = await res.blob()
          if (cancelled) return
          objectUrl = URL.createObjectURL(blob)
          setState({ status: 'ok', objectUrl })
        } else if (res.status === 404) {
          setState({ status: 'error', reason: 'source_missing' })
        } else if (res.status === 422) {
          setState({ status: 'error', reason: 'decode_failed' })
        } else {
          setState({ status: 'error', reason: 'load_failed' })
        }
      } catch (err) {
        clearTimeout(timer)
        if (cancelled) return
        if (err && err.name === 'AbortError') {
          setState({ status: 'error', reason: 'timeout' })
        } else {
          setState({ status: 'error', reason: 'load_failed' })
        }
      }
    })()

    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url])

  // 组件卸载时释放当前 objectUrl（上面的 cleanup 只覆盖正在进行的请求，
  // 成功后的 objectUrl 在下一次 effect 重建/卸载时单独释放）
  useEffect(() => {
    return () => {
      if (state.status === 'ok' && state.objectUrl) {
        URL.revokeObjectURL(state.objectUrl)
      }
    }
    // 仅在 objectUrl 变化时记一次 cleanup，避免每次 state 变都清
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status === 'ok' ? state.objectUrl : null])

  if (state.status === 'loading') {
    return (
      <div style={thumbCenterStyle}>
        <span style={{ color: '#555', fontSize: '12px' }}>加载中…</span>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div style={thumbCenterStyle}>
        <img src={PLACEHOLDER_IMG} alt="占位" style={{ width: '40%', opacity: 0.6 }} />
        <span style={{ marginTop: '4px', color: '#666', fontSize: '12px' }}>
          {THUMB_TEXT_BY_REASON[state.reason] || '加载失败'}
        </span>
      </div>
    )
  }

  return (
    <img
      src={state.objectUrl}
      alt=""
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
    />
  )
}

const thumbCenterStyle = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
}

function HistoryCard({ record, localMachineId, peerBaseUrlByMachine, onOpenDetails }) {
  const failed = record.success === false
  const canvasUnsaved = record.canvas_save_state === 'canvas_unsaved'
  const hasEagleItems = Array.isArray(record.eagle_item_ids) && record.eagle_item_ids.length > 0
  const eagleClickable = shouldShowEagleLink(record, localMachineId)

  // 缩略图 base_url 解析（Requirement 8/16，Phase 4 任务 21）
  //   - 本机记录（machine_id === localMachineId）→ 空字符串，走相对路径 /api/history/thumbnail...
  //   - 远端记录 → 在 peerBaseUrlByMachine 查对应机器的 base_url
  //   - 都匹配不上 → 空字符串兜底（相对路径会 404，交由 Thumbnail 的 onError 显示"原图缺失"）
  //   - localMachineId 可能尚未加载完成（null），此时若 record 是"已知远端"先匹配 peer，
  //     否则保守按本机处理（至少不会请求到错误的远端）
  let thumbBase = ''
  if (localMachineId && record.machine_id && record.machine_id !== localMachineId) {
    thumbBase = (peerBaseUrlByMachine && peerBaseUrlByMachine[record.machine_id]) || ''
  } else if (!localMachineId && record.machine_id) {
    // localMachineId 未就位时，远端命中也兜一下
    thumbBase = (peerBaseUrlByMachine && peerBaseUrlByMachine[record.machine_id]) || ''
  }
  const thumbUrl = buildThumbnailUrl(thumbBase, record.id, 0)

  return (
    <div
      onClick={onOpenDetails}
      style={{
        background: '#222',
        border: failed ? '2px solid #e53935' : '1px solid #333',
        borderRadius: '8px',
        overflow: 'hidden',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={(e) => {
        if (!failed) e.currentTarget.style.borderColor = '#4CAF50'
      }}
      onMouseLeave={(e) => {
        if (!failed) e.currentTarget.style.borderColor = '#333'
      }}
      title={record.prompt || ''}
    >
      {/* 缩略图区 */}
      <div style={{ position: 'relative', background: '#1a1a1a', aspectRatio: '1 / 1' }}>
        <Thumbnail url={thumbUrl} />

        {/* 左上：来源徽标 */}
        <span style={cornerBadgeStyle('tl')}>
          {SOURCE_EMOJI[record.source] || SOURCE_EMOJI.unknown}
        </span>
        {/* 右上：机器徽标 */}
        <span style={cornerBadgeStyle('tr')}>
          {(record.machine_id || 'unknown').toUpperCase()}
        </span>
        {/* 左下：模式标签 */}
        {record.mode && (
          <span style={cornerBadgeStyle('bl')}>
            {MODE_LABEL[record.mode] || record.mode}
          </span>
        )}
      </div>

      {/* 卡片底部信息 */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {/* prompt 截断 2 行 */}
        <div
          style={{
            color: '#ddd',
            fontSize: '12px',
            lineHeight: '1.4',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            minHeight: '34px',
          }}
        >
          {record.prompt || <span style={{ color: '#666' }}>（无 prompt）</span>}
        </div>

        {/* 状态标签行 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {failed && <StatusTag color="#e53935" bg="#4a1a1a">失败</StatusTag>}
          {canvasUnsaved && <StatusTag color="#ffb74d" bg="#3a2a1a">画布未保存</StatusTag>}
          {!hasEagleItems && <StatusTag color="#888" bg="#2a2a2a">未入 Eagle</StatusTag>}
          {hasEagleItems && !eagleClickable && (
            <StatusTag color="#888" bg="#2a2a2a">
              🦅 在 {(record.machine_id || 'peer').toUpperCase()} Eagle 库
            </StatusTag>
          )}
        </div>

        {/* 底部：时间 + Eagle 按钮 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#666', fontSize: '11px' }}>
            {formatTimestamp(record.created_at)}
          </span>
          {eagleClickable && (
            <a
              href={buildEagleDeepLink(record.eagle_item_ids[0])}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: '#4CAF50',
                color: 'white',
                textDecoration: 'none',
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: '4px',
              }}
            >
              在 Eagle 打开
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

function cornerBadgeStyle(corner) {
  const base = {
    position: 'absolute',
    background: 'rgba(0,0,0,0.7)',
    color: 'white',
    fontSize: '11px',
    padding: '2px 6px',
    borderRadius: '3px',
    pointerEvents: 'none',
  }
  if (corner === 'tl') return { ...base, top: 4, left: 4 }
  if (corner === 'tr') return { ...base, top: 4, right: 4 }
  if (corner === 'bl') return { ...base, bottom: 4, left: 4 }
  return { ...base, bottom: 4, right: 4 }
}

function StatusTag({ children, color, bg }) {
  return (
    <span
      style={{
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '3px',
        color,
        background: bg,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

// ========================================================================
//                             详情 Modal
// ========================================================================

function HistoryDetailModal({ record, localMachineId, onClose }) {
  const [toast, setToast] = useState('')
  const showToast = (msg) => {
    setToast(msg)
    setTimeout(() => setToast(''), 1500)
  }

  const copy = async (text, label) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        // http:// 场景 fallback
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      showToast(`已复制${label}`)
    } catch (e) {
      showToast('复制失败')
    }
  }

  const eagleClickable = shouldShowEagleLink(record, localMachineId)

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '80vw',
          maxWidth: '760px',
          maxHeight: '80vh',
          background: '#1e1e1e',
          border: '1px solid #333',
          borderRadius: '8px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* 头部 */}
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid #333',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <h3 style={{ margin: 0, color: 'white', fontSize: '15px' }}>
            {SOURCE_EMOJI[record.source] || '❓'} 生图记录详情
            <span style={{ color: '#666', fontSize: '12px', marginLeft: '8px' }}>
              {record.id}
            </span>
          </h3>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#999',
              fontSize: '20px',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>

        {/* 正文 */}
        <div style={{ padding: '16px', overflowY: 'auto', color: '#ddd', fontSize: '13px' }}>
          <DetailRow label="时间">{formatTimestamp(record.created_at)}</DetailRow>
          <DetailRow label="机器">{record.machine_id}</DetailRow>
          <DetailRow label="来源">
            {SOURCE_EMOJI[record.source] || '❓'} {record.source}
            {record.raw_source ? `（原值：${record.raw_source}）` : ''}
          </DetailRow>
          <DetailRow label="模式">{MODE_LABEL[record.mode] || record.mode}</DetailRow>
          <DetailRow label="状态">
            {record.success === false ? (
              <span style={{ color: '#e53935' }}>失败</span>
            ) : (
              <span style={{ color: '#4CAF50' }}>成功</span>
            )}
            {' · '}
            耗时 {formatElapsed(record.elapsed_sec)}
          </DetailRow>
          {record.error_message && (
            <DetailRow label="错误">
              <span style={{ color: '#e53935' }}>{record.error_message}</span>
            </DetailRow>
          )}

          <DetailRow label="Prompt">
            <pre
              style={{
                background: '#111',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '8px',
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: '#eee',
                fontSize: '12px',
                maxHeight: '160px',
                overflowY: 'auto',
              }}
            >
              {record.prompt || '(空)'}
            </pre>
          </DetailRow>

          <DetailRow label="参数">
            <ParamGrid record={record} />
          </DetailRow>

          {Array.isArray(record.output_files) && record.output_files.length > 0 && (
            <DetailRow label="输出文件">
              <ul style={{ margin: 0, paddingLeft: '16px' }}>
                {record.output_files.map((p, i) => (
                  <li key={i} style={{ fontFamily: 'monospace', fontSize: '11px', color: '#bbb' }}>
                    {p}
                  </li>
                ))}
              </ul>
            </DetailRow>
          )}

          {Array.isArray(record.eagle_item_ids) && record.eagle_item_ids.length > 0 && (
            <DetailRow label="Eagle IDs">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {record.eagle_item_ids.map((id) => (
                  <span
                    key={id}
                    style={{
                      fontSize: '11px',
                      padding: '2px 6px',
                      background: '#2a2a2a',
                      border: '1px solid #444',
                      borderRadius: '3px',
                      fontFamily: 'monospace',
                    }}
                  >
                    {id}
                  </span>
                ))}
              </div>
            </DetailRow>
          )}

          {record.batch_id && <DetailRow label="Batch ID">{record.batch_id}</DetailRow>}
          {record.script_name && <DetailRow label="脚本">{record.script_name}</DetailRow>}
          {record.canvas_node_id && (
            <DetailRow label="画布节点">{record.canvas_node_id}</DetailRow>
          )}
        </div>

        {/* 操作区 */}
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid #333',
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
          }}
        >
          <button onClick={() => copy(record.prompt || '', 'Prompt')} style={actionBtn}>
            📋 复制 Prompt
          </button>
          <button
            onClick={() => copy(JSON.stringify(record, null, 2), 'JSON')}
            style={actionBtn}
          >
            📋 复制 JSON
          </button>
          {eagleClickable && (
            <a
              href={buildEagleDeepLink(record.eagle_item_ids[0])}
              style={{ ...actionBtn, textDecoration: 'none', display: 'inline-block' }}
            >
              🦅 在 Eagle 打开
            </a>
          )}
          {!eagleClickable &&
            Array.isArray(record.eagle_item_ids) &&
            record.eagle_item_ids.length > 0 &&
            record.machine_id !== localMachineId && (
              <span
                style={{
                  ...actionBtn,
                  background: '#1a1a1a',
                  color: '#888',
                  cursor: 'not-allowed',
                }}
                title="此图在其他机器的 Eagle 库，无法从本机跳转"
              >
                🦅 在 {(record.machine_id || 'peer').toUpperCase()} Eagle 库
              </span>
            )}
          {toast && (
            <span style={{ color: '#4CAF50', fontSize: '12px', marginLeft: '8px' }}>{toast}</span>
          )}
        </div>
      </div>
    </div>
  )
}

function DetailRow({ label, children }) {
  return (
    <div style={{ display: 'flex', marginBottom: '10px', gap: '8px' }}>
      <div style={{ width: '80px', flexShrink: 0, color: '#888', fontSize: '12px' }}>{label}</div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}

function ParamGrid({ record }) {
  const rows = [
    ['Provider', record.provider_name || record.provider_id || '-'],
    ['Model', record.model || '-'],
    ['Aspect', record.aspect_ratio || '-'],
    ['Resolution', record.resolution || '-'],
    ['Size', record.size || '-'],
    ['Quality', record.quality || '-'],
    ['Count', record.count ?? '-'],
    ['Reference', record.reference_count ?? 0],
  ]
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '4px 12px',
        fontSize: '12px',
      }}
    >
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: '6px' }}>
          <span style={{ color: '#888' }}>{k}:</span>
          <span style={{ color: '#ddd', wordBreak: 'break-all' }}>{String(v)}</span>
        </div>
      ))}
    </div>
  )
}

const actionBtn = {
  background: '#2a2a2a',
  border: '1px solid #444',
  color: '#ddd',
  borderRadius: '4px',
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: '12px',
}

// ========================================================================
//                             状态提示
// ========================================================================

function CenterHint({ text, dim }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        minHeight: '200px',
        color: dim ? '#555' : '#888',
        fontSize: '13px',
      }}
    >
      {text}
    </div>
  )
}

function ErrorState({ error, onRetry }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        minHeight: '200px',
        color: '#e53935',
        fontSize: '13px',
        gap: '8px',
      }}
    >
      <div>加载失败：{error?.message || String(error)}</div>
      <button
        onClick={onRetry}
        style={{
          background: 'transparent',
          border: '1px solid #e53935',
          color: '#e53935',
          borderRadius: '4px',
          padding: '4px 12px',
          cursor: 'pointer',
          fontSize: '12px',
        }}
      >
        重试
      </button>
    </div>
  )
}
