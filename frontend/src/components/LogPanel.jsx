import React, { useState, useEffect, useRef } from 'react'

function LogPanel({ logs, isVisible, onToggle }) {
  const logEndRef = useRef(null)

  useEffect(() => {
    // 自动滚动到底部
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs])

  return (
    <>
      {/* 切换按钮 */}
      <button
        className={`log-panel-toggle ${isVisible ? 'visible' : ''}`}
        onClick={onToggle}
        title={isVisible ? '隐藏日志' : '显示日志'}
      >
        {isVisible ? '»' : '«'}
      </button>

      {/* 日志面板 */}
      <div className={`log-panel ${isVisible ? 'visible' : 'hidden'}`}>
        <div className="log-panel-header">
          <h3>📋 生成日志</h3>
          <span className="log-count">{logs.length} 条</span>
        </div>

        <div className="log-panel-content">
          {logs.length === 0 ? (
            <div className="log-empty">
              <p>暂无日志</p>
              <small>生成图片时会显示详细日志</small>
            </div>
          ) : (
            <div className="log-list">
              {logs.map((log, index) => (
                <div key={index} className={`log-item log-${log.level}`}>
                  <span className="log-time">{log.time}</span>
                  <span className="log-message">{log.message}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export default LogPanel
