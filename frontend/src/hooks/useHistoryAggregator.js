/**
 * useHistoryAggregator
 *
 * 生图历史面板的数据聚合 hook。负责：
 *   - 调用本机 GET /api/history 拉取记录（分页 100 条）
 *   - 同时并发拉取 system_config.peer_machines 中每台对端机器的 /api/history，
 *     每个 peer 用 AbortController 3s 超时，失败写入 peerFailures，不影响本机展示
 *   - filters 变更时 debounce 300ms 重置到 page=0
 *   - loadMore 追加下一页（仅本机，Peer 分页独立，Phase 5 再优化）
 *   - retry 重置到 page=0，重新并发拉取本机 + Peer
 *   - 返回 localMachineId 供 UI 层判断 Eagle 跳转 / 机器徽标
 *   - 返回 peerMachines 供 UI 层根据 record.machine_id 解析跨机缩略图 base_url（Requirement 8/16）
 *
 * 设计要点：
 *   - filters 对象每次渲染引用通常会变，依赖项用 JSON.stringify 稳定 key 避免无意义重拉
 *   - 并发请求用 requestSeq 守卫避免"旧请求晚到覆盖新结果"
 *   - 合并排序按 created_at 字符串 localeCompare 降序
 *     （记录写入时是 ISO 8601 + 时区偏移，字符串比较和 UTC 比较一致，见 design.md）
 *   - has_more 仅以本机响应为准（Peer 分页独立未做）
 *   - page>0 只拉本机、追加记录；不重置 peerFailures，保持顶部离线提示稳定
 *
 * Related Requirements: 13, 14, 17.3, 18.1-18.3, 22
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getHistory, getHistoryConfig } from '../utils/api'

const PAGE_SIZE = 100
const FILTER_DEBOUNCE_MS = 300
const PEER_TIMEOUT_MS = 3000

// ---- 模块内辅助 ----

/**
 * 构建查询串（与 api.js._buildQuery 行为一致）
 * 过滤 undefined/null/''，数组按逗号拼接
 */
function buildQueryString(params) {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      sp.append(key, value.join(','))
    } else {
      sp.append(key, String(value))
    }
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

/**
 * 用 AbortController 带超时拉取一台 Peer 的 /api/history
 * 返回值永远 resolve：
 *   { ok: true, machine_id, records }
 *   { ok: false, machine_id, reason: 'timeout' | 'http_404' | 'network_error' | <msg> }
 */
async function fetchPeerWithTimeout(peer, params, timeoutMs = PEER_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const base = String(peer.base_url || '').replace(/\/$/, '')
  const url = `${base}/api/history${buildQueryString(params)}`
  try {
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) {
      return { ok: false, machine_id: peer.machine_id, reason: `http_${res.status}` }
    }
    const data = await res.json()
    const records = (data && data.records) || []
    return { ok: true, machine_id: peer.machine_id, records }
  } catch (err) {
    clearTimeout(timer)
    if (err && err.name === 'AbortError') {
      return { ok: false, machine_id: peer.machine_id, reason: 'timeout' }
    }
    return {
      ok: false,
      machine_id: peer.machine_id,
      reason: (err && err.message) || 'network_error',
    }
  }
}

export default function useHistoryAggregator(filters, { enabled = true } = {}) {
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [peerFailures, setPeerFailures] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState(0)
  const [localMachineId, setLocalMachineId] = useState(null)
  // 暴露给 UI 层：UI 要用 machine_id → base_url 解析跨机缩略图 URL（Requirement 8/16 Phase 4）
  // 与 peerMachinesRef 内容保持同步，但 state 触发组件重渲染，ref 仅供 fetchPage 闭包读取
  const [peerMachines, setPeerMachines] = useState([])

  // 最新 filters 引用，fetchPage 通过 ref 读取避免把 filters 加进依赖导致重建
  const latestFiltersRef = useRef(filters)
  useEffect(() => {
    latestFiltersRef.current = filters
  }, [filters])

  // Peer 机器列表（来自 /api/history/config.peer_machines）
  const peerMachinesRef = useRef([])

  // debounce 定时器
  const debounceTimerRef = useRef(null)

  // 请求序号，用于识别并忽略过期响应
  const requestSeqRef = useRef(0)

  // ---- 一次性拉取机器配置（localMachineId + peer_machines） ----
  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    getHistoryConfig()
      .then((data) => {
        if (cancelled || !data) return
        // 后端成功响应可能不带 success 字段，只要有 machine_id 就视为可用
        if (data.machine_id) {
          setLocalMachineId(data.machine_id)
        }
        if (Array.isArray(data.peer_machines)) {
          // 过滤掉字段缺失的畸形项，避免 fetch undefined/api/history
          const filtered = data.peer_machines.filter(
            (p) => p && p.base_url && p.machine_id
          )
          peerMachinesRef.current = filtered
          setPeerMachines(filtered)
        }
      })
      .catch((err) => {
        // 配置拉不到不影响本机面板展示，记录到 console 即可
        // 具体错误会在本机 fetch 失败时通过 error state 暴露
        console.warn('[useHistoryAggregator] getHistoryConfig failed:', err)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  // ---- 核心：拉取指定页 ----
  const fetchPage = useCallback(
    async (targetPage = 0) => {
      if (!enabled) return
      const seq = ++requestSeqRef.current
      const reqFilters = latestFiltersRef.current || {}

      setLoading(true)
      if (targetPage === 0) {
        // 重置时先清错误，保留 records 直到新结果到来（避免 UI 闪空）
        setError(null)
      }

      const params = {
        ...reqFilters,
        limit: PAGE_SIZE,
        offset: targetPage * PAGE_SIZE,
      }

      try {
        if (targetPage === 0) {
          // ===== Page 0：本机 + Peer 并发拉取 =====
          const peers = peerMachinesRef.current
          // local 包一层，避免 Promise.all 因 local 抛出直接短路丢掉 peer 结果
          const localPromise = getHistory(params).then(
            (d) => ({ ok: true, data: d }),
            (err) => ({ ok: false, error: err })
          )
          const peerPromises = peers.map((p) => fetchPeerWithTimeout(p, params))
          const [localResult, ...peerResults] = await Promise.all([
            localPromise,
            ...peerPromises,
          ])

          if (seq !== requestSeqRef.current) return // 过期响应，丢弃

          // 本机失败 → 进入错误态（Requirement 14.4）
          if (!localResult.ok) throw localResult.error

          const localData = localResult.data
          const localRecords = (localData && localData.records) || []
          const localHasMore = Boolean(localData && localData.has_more)

          // 合并：本机 records（已带 machine_id）+ 成功 peer 的 records
          const merged = [...localRecords]
          const failures = []
          for (const r of peerResults) {
            if (r.ok) {
              merged.push(...r.records)
            } else {
              failures.push({ machine_id: r.machine_id, reason: r.reason })
            }
          }
          merged.sort((a, b) =>
            (b.created_at || '').localeCompare(a.created_at || '')
          )

          setRecords(merged)
          setHasMore(localHasMore)
          setPage(0)
          setPeerFailures(failures)
        } else {
          // ===== Page > 0：只拉本机、追加到末尾 =====
          // has_more 仍以本机为准；peerFailures 保持不变，顶部离线提示条稳定
          const localData = await getHistory(params)
          if (seq !== requestSeqRef.current) return

          const localRecords = (localData && localData.records) || []
          const localHasMore = Boolean(localData && localData.has_more)
          setRecords((prev) => [...prev, ...localRecords])
          setHasMore(localHasMore)
          setPage(targetPage)
        }
      } catch (err) {
        if (seq !== requestSeqRef.current) return // 过期响应，忽略错误
        setError(err)
        if (targetPage === 0) {
          // 首页失败：清空记录，让 UI 进入错误态而不是展示旧数据
          setRecords([])
          setHasMore(false)
        }
      } finally {
        if (seq === requestSeqRef.current) setLoading(false)
      }
    },
    [enabled]
  )

  // ---- filters 变化 debounce 重置到 page=0 ----
  // 依赖用 JSON 序列化的稳定 key，避免 filters 引用变化但内容未变的无意义重拉
  const filtersKey = JSON.stringify(filters || {})
  useEffect(() => {
    if (!enabled) return undefined
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => {
      fetchPage(0)
    }, FILTER_DEBOUNCE_MS)
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    }
  }, [filtersKey, enabled, fetchPage])

  // ---- 对外动作 ----
  const retry = useCallback(() => {
    fetchPage(0)
  }, [fetchPage])

  const loadMore = useCallback(() => {
    if (loading || !hasMore) return
    fetchPage(page + 1)
  }, [fetchPage, loading, hasMore, page])

  return {
    records,
    loading,
    error,
    peerFailures,
    hasMore,
    page,
    fetchPage,
    retry,
    loadMore,
    localMachineId,
    peerMachines,
  }
}
