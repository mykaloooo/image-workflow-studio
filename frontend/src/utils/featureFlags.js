// 实验功能开关 — Feature Flags
//
// 设计原则（2026-05-13）：
// - 存 localStorage，跟 system_config.json 完全解耦（不碰 AGENTS.md L3 锁定区）
// - 浏览器本地生效，PC1/PC2 各自独立设置
// - 提供 React hook 用法，组件可订阅变化
// - 关闭状态下，依赖此 flag 的 UI 入口完全不渲染
//
// 用法:
//   import { useFeatureFlag, FLAGS } from '../utils/featureFlags'
//   const enabled = useFeatureFlag(FLAGS.STORYBOARD_ENABLED)
//
//   import { setFeatureFlag, FLAGS } from '../utils/featureFlags'
//   setFeatureFlag(FLAGS.STORYBOARD_ENABLED, true)

import { useEffect, useState } from 'react'

const STORAGE_KEY = 'image-workflow-studio:feature-flags'
const UPDATE_EVENT = 'feature-flags-updated'

// 默认值 — 所有实验功能默认关闭
const DEFAULTS = {
  storyboardEnabled: false,
}

// 已注册的 flag key（避免拼写错误）
export const FLAGS = {
  STORYBOARD_ENABLED: 'storyboardEnabled',
}

function readFlags() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    return { ...DEFAULTS, ...parsed }
  } catch (e) {
    console.warn('[featureFlags] read failed, falling back to defaults:', e)
    return { ...DEFAULTS }
  }
}

function writeFlags(partial) {
  try {
    const merged = { ...readFlags(), ...partial }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: merged }))
    return merged
  } catch (e) {
    console.warn('[featureFlags] write failed:', e)
    return readFlags()
  }
}

// 同步读取（非 React 环境也能用）
export function getFeatureFlag(key) {
  return readFlags()[key]
}

// 同步写入（立即生效，立即广播）
export function setFeatureFlag(key, value) {
  return writeFlags({ [key]: value })
}

// 一次性读取全部（用于 debug / 系统设置面板）
export function getAllFeatureFlags() {
  return readFlags()
}

// React hook — 订阅单个 flag 的变化（本标签页 + 跨标签页）
export function useFeatureFlag(key) {
  const [value, setValue] = useState(() => readFlags()[key])

  useEffect(() => {
    const handleUpdate = (e) => {
      const flags = e?.detail || readFlags()
      setValue(flags[key])
    }
    const handleStorage = (e) => {
      if (e.key === STORAGE_KEY) {
        setValue(readFlags()[key])
      }
    }
    window.addEventListener(UPDATE_EVENT, handleUpdate)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(UPDATE_EVENT, handleUpdate)
      window.removeEventListener('storage', handleStorage)
    }
  }, [key])

  return value
}
