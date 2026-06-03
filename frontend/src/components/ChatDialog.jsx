import React, { useState, useRef, useEffect } from 'react'
import { chatWithAI } from '../utils/api'

/**
 * ChatDialog - 多轮对话弹窗
 */
function ChatDialog({ isOpen, onClose, initialMessages, systemPrompt, referenceImages, presetName, presetIcon }) {
  const [messages, setMessages] = useState(initialMessages || [])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  // 自动滚动到底部
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // 打开时聚焦输入框
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen])

  // 发送消息
  const handleSend = async () => {
    if (!input.trim() || isLoading) return

    const userMessage = { role: 'user', content: input }
    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsLoading(true)

    try {
      // 构建完整的消息历史
      const allMessages = [...messages, userMessage]

      // 构建对话上下文
      const contextPrompt = allMessages.map(m =>
        `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
      ).join('\n\n')

      const result = await chatWithAI({
        prompt: contextPrompt + '\n\n请继续回复用户的最新问题。',
        system_prompt: systemPrompt,
        reference_images: referenceImages
      })

      if (result.success) {
        setMessages(prev => [...prev, { role: 'assistant', content: result.response }])
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `错误: ${result.error}` }])
      }
    } catch (error) {
      setMessages(prev => [...prev, { role: 'assistant', content: `错误: ${error.message}` }])
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleCopyMessage = (content) => {
    navigator.clipboard.writeText(content)
  }

  if (!isOpen) return null

  return (
    <div className="chat-dialog-overlay" onClick={onClose}>
      <div className="chat-dialog" onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="chat-dialog-header">
          <div className="chat-dialog-title">
            <span className="chat-dialog-icon">{presetIcon || '💬'}</span>
            <span>{presetName || '多轮对话'}</span>
          </div>
          <div className="chat-dialog-info">
            {referenceImages?.length > 0 && (
              <span className="chat-dialog-images">📷 {referenceImages.length} 张参考图</span>
            )}
          </div>
          <button className="chat-dialog-close" onClick={onClose}>✕</button>
        </div>

        {/* 消息列表 */}
        <div className="chat-dialog-messages">
          {messages.length === 0 ? (
            <div className="chat-dialog-empty">
              <p>💬 开始对话</p>
              <p>输入你的问题，AI 会基于参考图和对话历史进行回复</p>
            </div>
          ) : (
            messages.map((msg, index) => (
              <div key={index} className={`chat-message ${msg.role}`}>
                <div className="chat-message-avatar">
                  {msg.role === 'user' ? '👤' : presetIcon || '🤖'}
                </div>
                <div className="chat-message-content">
                  <div className="chat-message-text">{msg.content}</div>
                  <div className="chat-message-actions">
                    <button onClick={() => handleCopyMessage(msg.content)} title="复制">
                      📋
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
          {isLoading && (
            <div className="chat-message assistant">
              <div className="chat-message-avatar">{presetIcon || '🤖'}</div>
              <div className="chat-message-content">
                <div className="chat-message-loading">
                  <div className="typing-indicator">
                    <span></span><span></span><span></span>
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 输入区域 */}
        <div className="chat-dialog-input-area">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            rows={3}
            disabled={isLoading}
          />
          <button
            className="chat-dialog-send"
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
          >
            {isLoading ? '⏳' : '🚀'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ChatDialog
