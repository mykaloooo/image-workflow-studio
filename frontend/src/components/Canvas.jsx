import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  useReactFlow,
} from 'reactflow'
import 'reactflow/dist/style.css'

import ImageNode from './ImageNode'
import ChatNode from './ChatNode'
import VideoNode from './VideoNode'
import Toolbar from './Toolbar'
import LogPanel from './LogPanel'
import ProjectManager from './ProjectManager'
import ProjectConfig from './ProjectConfig'
import { generateImage, uploadImage, createVideoTask, getVideoTaskStatus as pollVideoStatus, getRuntimeLogs, getFlowBridgeJob, redownloadFlowImage } from '../utils/api'
import { projectDB, createNewProject, generateProjectId } from '../utils/projectDB'
import { browserFS, isFileSystemSupported } from '../utils/browserFileSystem'
import { NodesProvider } from '../contexts/NodesContext'
import { getModelCapabilities } from '../utils/modelCapabilities'

const nodeTypes = {
  imageNode: ImageNode,
  chatNode: ChatNode,
  videoNode: VideoNode,
}

// ChatNode 的默认配置 - 只能通过标题栏拖动
const defaultChatNodeOptions = {
  dragHandle: '.chat-node-drag-handle',
}

function Canvas({ apiConfig, onOpenSettings, onOpenAgentManager, onOpenTemplateManager }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [logs, setLogs] = useState([])
  const [logPanelVisible, setLogPanelVisible] = useState(true)
  const [projectManagerOpen, setProjectManagerOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [currentProjectId, setCurrentProjectId] = useState(null)
  const [currentProjectName, setCurrentProjectName] = useState('未命名项目')
  const [contextMenu, setContextMenu] = useState(null)
  const [canvasKey, setCanvasKey] = useState(0)
  const nodeIdCounter = useRef(0)
  const sequenceNumCounter = useRef(0)
  const canvasRef = useRef(null)
  const middlePanRef = useRef(null)
  const lastRuntimeLogIdRef = useRef(0)
  const flowBridgePollInFlightRef = useRef(new Set())

  // 剪贴板 - 存储复制的节点和边
  const clipboardRef = useRef({ nodes: [], edges: [] })

  // 使用 ref 存储最新的 nodes 和 edges，避免回调依赖导致的循环更新
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges
  const { project, getViewport, setViewport } = useReactFlow()

  // 添加日志 - 限制最大条数防止内存泄漏
  const MAX_LOGS = 100
  const addLog = useCallback((message, level = 'info') => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setLogs(prev => {
      const newLogs = [...prev, { time, message, level }]
      // 超过最大条数时，删除旧日志
      if (newLogs.length > MAX_LOGS) {
        return newLogs.slice(-MAX_LOGS)
      }
      return newLogs
    })
  }, [])

  const normalizeImageParams = useCallback((formData = {}, options = {}) => {
    const model = String(formData.model || '').trim()
    const providerId = String(formData.providerId || formData.provider_id || '').trim()
    const requestedAspectRatio = formData.aspectRatio || '1:1'
    const hasReferenceImage = options.hasReferenceImage ?? (Boolean(formData.referenceImageUrl) || (Array.isArray(formData.referenceImages) && formData.referenceImages.length > 0))
    const baseCapabilities = getModelCapabilities(model, {
      aspectRatio: requestedAspectRatio,
      hasReferenceImage,
    })
    const aspectRatio = baseCapabilities.aspectRatios.includes(requestedAspectRatio) ? requestedAspectRatio : baseCapabilities.defaultAspectRatio
    const capabilities = getModelCapabilities(model, {
      aspectRatio,
      hasReferenceImage,
    })
    const requestedResolution = String(formData.size || formData.resolution || capabilities.defaultResolution || '').trim()
    const resolution = capabilities.resolutions.includes(requestedResolution) ? requestedResolution : capabilities.defaultResolution

    return {
      ...formData,
      aspectRatio,
      resolution,
      size: capabilities.requestField === 'size' ? resolution : '',
      providerId,
      model,
    }
  }, [])

  const buildGeneratePayload = useCallback((formData = {}, prompt, referenceImages = []) => {
    const normalized = normalizeImageParams(formData, { hasReferenceImage: referenceImages.length > 0 })
    const payload = {
      prompt,
      aspect_ratio: normalized.aspectRatio,
      resolution: normalized.resolution,
      provider_id: normalized.providerId,
      model: normalized.model,
      count: normalized.count,
      reference_images: referenceImages,
    }

    if (normalized.size) {
      payload.size = normalized.size
    }

    return { normalized, payload }
  }, [normalizeImageParams])

  const hydrateLoadedNode = useCallback((node) => ({
    ...node,
    dragHandle: node.type === 'imageNode' ? '.image-node-drag-handle' :
               node.type === 'chatNode' ? '.chat-node-drag-handle' : undefined,
    data: {
      ...node.data,
      aspectRatio: node.data?.aspectRatio || '1:1',
      resolution: node.data?.size || node.data?.resolution || '2K',
      size: node.data?.size || '',
      model: node.data?.model || '',
      providerId: node.data?.providerId || node.data?.provider_id || '',
      onGenerate: node.type === 'videoNode'
        ? (...args) => callbacksRef.current.handleGenerateVideo(...args)
        : (...args) => callbacksRef.current.handleGenerate(...args),
      onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
      onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
      onChat: (...args) => callbacksRef.current.handleChat?.(...args),
      onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
    }
  }), [])

  useEffect(() => {
    let cancelled = false
    const pullRuntimeLogs = async () => {
      const result = await getRuntimeLogs({ since: lastRuntimeLogIdRef.current, limit: 100 })
      if (cancelled || !result.success || !Array.isArray(result.logs)) return
      if (result.logs.length === 0) {
        if (typeof result.latest_id === 'number') {
          lastRuntimeLogIdRef.current = result.latest_id
        }
        return
      }
      lastRuntimeLogIdRef.current = result.latest_id || result.logs[result.logs.length - 1]?.id || lastRuntimeLogIdRef.current
      setLogs(prev => {
        const existingKeys = new Set(prev.map(log => `${log.time}|${log.level}|${log.message}`))
        const appended = result.logs
          .map(log => ({
            time: log.time || new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            message: `[后端] ${log.message}`,
            level: log.level || 'info',
          }))
          .filter(log => !existingKeys.has(`${log.time}|${log.level}|${log.message}`))
        if (appended.length === 0) return prev
        const merged = [...prev, ...appended]
        return merged.length > MAX_LOGS ? merged.slice(-MAX_LOGS) : merged
      })
    }

    pullRuntimeLogs()
    const timer = window.setInterval(pullRuntimeLogs, 1500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  // 压缩图片到 90%
  const compressImage = useCallback((file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = img.width
          canvas.height = img.height
          const ctx = canvas.getContext('2d')
          ctx.drawImage(img, 0, 0)

          // 压缩到 90% 质量
          canvas.toBlob(
            (blob) => {
              const reader2 = new FileReader()
              reader2.onload = (e2) => {
                resolve(e2.target.result)
              }
              reader2.readAsDataURL(blob)
            },
            'image/jpeg',
            0.9
          )
        }
        img.src = e.target.result
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }, [])

  // 生成图片 - 使用 ref 避免依赖 nodes/edges 导致循环更新
  const handleGenerate = useCallback(async (nodeId, formData) => {
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current

    const node = currentNodes.find((n) => n.id === nodeId)
    if (!node) return

    addLog('开始生成图片...', 'info')
    addLog(`提示词: ${formData.prompt}`, 'info')
    addLog(`参数: ${formData.aspectRatio} / ${formData.resolution}`, 'info')

    // 查找所有父节点（参考图）
    const parentEdges = currentEdges.filter((e) => e.target === nodeId)
    const referenceImages = []
    const weightedReferences = []

    for (let i = 0; i < parentEdges.length; i++) {
      const edge = parentEdges[i]
      const parentNode = currentNodes.find((n) => n.id === edge.source)
      if (parentNode && parentNode.data.type === 'image' && parentNode.data.imageUrl) {
        referenceImages.push(parentNode.data.imageUrl)

        // 权重模拟：连接顺序决定权重（越早连接权重越高）
        const weight = parentEdges.length - i
        const referencePrompt = parentNode.data.prompt || `参考图${i + 1}`
        weightedReferences.push(`[${referencePrompt}] 权重:${weight}`)
      }
    }

    if (referenceImages.length > 0) {
      addLog(`使用 ${referenceImages.length} 张参考图`, 'info')
      console.log('🖼️ 参考图路径:', referenceImages)
      if (weightedReferences.length > 0) {
        addLog(`参考图权重: ${weightedReferences.join(' | ')}`, 'info')
      }
    }

    // 构建增强提示词（包含权重信息）
    let enhancedPrompt = formData.prompt
    if (weightedReferences.length > 0) {
      enhancedPrompt = `${formData.prompt}\n\n参考要求：\n${weightedReferences.join('\n')}`
    }

    const { normalized, payload } = buildGeneratePayload(formData, enhancedPrompt, referenceImages)

    // 更新节点状态为生成中
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              data: {
                ...n.data,
                status: 'generating',
              },
            }
          : n
      )
    )

    // 调用 API 生成图片
    try {
      addLog('正在调用图片生成接口...', 'info')
      console.log('📤 发送给后端的参数:', payload)

      const result = await generateImage(payload)

      if (result.success && result.pending) {
        addLog(`✓ Flow任务已排队: ${result.task_id}`, 'success')
        if (result.jobs_file) {
          addLog(`队列文件: ${result.jobs_file}`, 'info')
        }
        setNodes((nds) =>
          nds.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    status: 'queued',
                    flowBridge: {
                      taskId: result.task_id,
                      jobId: result.job_id,
                      jobsFile: result.jobs_file,
                      bridgeUrl: result.bridge_url,
                      stage: 'queued',
                      state: 'queued',
                      statusText: '已提交到 Flow 队列',
                      statusDetail: '等待队列导出和执行器接手',
                      submittedAt: new Date().toISOString(),
                      downloadResolution: result.download_resolution || '1K',
                    },
                    prompt: formData.prompt,
                    aspectRatio: normalized.aspectRatio,
                    resolution: normalized.resolution,
                    size: normalized.size,
                    providerId: normalized.providerId,
                    model: normalized.model,
                    sourceReferenceImages: referenceImages.map(url => ({ url })),
                    onGenerate: n.data.onGenerate,
                    onAddChild: n.data.onAddChild,
                    onRegenerate: n.data.onRegenerate,
                    onUpdateImage: n.data.onUpdateImage,
                  },
                }
              : n
          )
        )
        return
      }

      if (result.success && result.images?.length > 0) {
        addLog(`✓ 生成成功！共 ${result.images.length} 张图片`, 'success')

        const mainSequenceNum = ++sequenceNumCounter.current

        // v2: 存储路径而非 base64
        setNodes((nds) =>
          nds.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    type: 'image',
                    status: 'completed',
                    imageUrl: result.images[0].url,  // v2: 使用路径
                    thumbnail: result.images[0].thumbnail,
                    filename: result.images[0].filename,
                    prompt: formData.prompt,
                    sequenceNum: mainSequenceNum,
                    aspectRatio: normalized.aspectRatio,
                    resolution: normalized.resolution,
                    size: normalized.size,
                    providerId: normalized.providerId,
                    model: normalized.model,
                    createdAt: new Date().toISOString(),
                    // 保存参考图信息（用于生成记录显示）
                    sourceReferenceImages: referenceImages.map(url => ({ url })),
                    // 保留回调函数
                    onGenerate: n.data.onGenerate,
                    onAddChild: n.data.onAddChild,
                    onRegenerate: n.data.onRegenerate,
                    onUpdateImage: n.data.onUpdateImage,
                  },
                }
              : n
          )
        )

        // 如果生成了多张图片，创建额外的节点
        for (let i = 1; i < result.images.length; i++) {
          const additionalNodeId = `node_${nodeIdCounter.current++}`
          const additionalSequenceNum = ++sequenceNumCounter.current
          const additionalNode = {
            id: additionalNodeId,
            type: 'imageNode',
            position: {
              x: node.position.x + i * 320,  // 横向排列，间距 320px
              y: node.position.y,
            },
            dragHandle: '.image-node-drag-handle',
            data: {
              type: 'image',
              status: 'completed',
              imageUrl: result.images[i].url,  // v2: 使用路径
              thumbnail: result.images[i].thumbnail,
              filename: result.images[i].filename,
              prompt: formData.prompt,
              sequenceNum: additionalSequenceNum,
              aspectRatio: normalized.aspectRatio,
              resolution: normalized.resolution,
              size: normalized.size,
              providerId: normalized.providerId,
              model: normalized.model,
              createdAt: new Date().toISOString(),
              // 保存参考图信息（用于生成记录显示）
              sourceReferenceImages: referenceImages.map(url => ({ url })),
              // 添加回调函数
              onGenerate: (...args) => callbacksRef.current.handleGenerate(...args),
              onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
              onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
              onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
            },
            connectable: true,
            draggable: true,
          }

          setNodes((nds) => [...nds, additionalNode])
        }
      } else {
        // 生成失败
        const errorMsg = result.error || '生成失败'
        addLog(`✗ ${errorMsg}`, 'error')
        if (result.detail) {
          addLog(`详情: ${result.detail}`, 'error')
        }

        setNodes((nds) =>
          nds.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    status: 'failed',
                    error: errorMsg,
                  },
                }
              : n
          )
        )
      }
    } catch (error) {
      console.error('生成失败:', error)
      addLog(`✗ 生成失败: ${error.message}`, 'error')

      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  status: 'failed',
                  error: error.message,
                },
              }
            : n
        )
      )
    }
  }, [addLog, buildGeneratePayload])  // 移除 nodes, edges 依赖，使用 ref 代替

  // 添加子节点
  const handleAddChild = useCallback((parentId) => {
    const parentNode = nodes.find((n) => n.id === parentId)
    if (!parentNode) return

    // 创建新的提示词节点
    const childCount = edges.filter((e) => e.source === parentId).length
    const newPosition = {
      x: parentNode.position.x + 400,
      y: parentNode.position.y + childCount * 300,
    }

    const newNodeId = `node_${nodeIdCounter.current++}`
    const newNode = {
      id: newNodeId,
      type: 'imageNode',
      position: newPosition,
      dragHandle: '.image-node-drag-handle',
      data: {
        type: 'prompt',
        label: '提示词节点',
        status: 'idle',
        hasParent: true,
        aspectRatio: '1:1',
        resolution: '2K',
        size: '',
        model: '',
        providerId: '',
        onGenerate: (...args) => callbacksRef.current.handleGenerate(...args),
        onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
        onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
        onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
      },
      connectable: true,
      draggable: true,
    }

    const newEdge = {
      id: `edge_${Date.now()}`,
      source: parentId,
      target: newNodeId,
      type: 'smoothstep',
    }

    setNodes((nds) => [...nds, newNode])
    setEdges((eds) => [...eds, newEdge])
  }, [nodes, edges])

  // v2: 创建图片节点 - 上传到后端，返回路径
  const createImageNode = useCallback(async (file, position) => {
    try {
      // 上传图片到后端
      const uploadResult = await uploadImage(file)

      const newNodeId = `node_${nodeIdCounter.current++}`
      const sequenceNum = ++sequenceNumCounter.current
      const newNode = {
        id: newNodeId,
        type: 'imageNode',
        position: position,
        dragHandle: '.image-node-drag-handle',
        data: {
          type: 'image',
          status: 'completed',
          imageUrl: uploadResult.url,  // v2: 存储路径
          filename: uploadResult.filename,
          prompt: '导入的图片',
          sequenceNum: sequenceNum,
          aspectRatio: '1:1',
          resolution: '2K',
          size: '',
          model: '',
          providerId: '',
          // 添加回调函数
          onGenerate: (...args) => callbacksRef.current.handleGenerate(...args),
          onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
          onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
          onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
        },
        connectable: true,
        draggable: true,
      }
      setNodes((nds) => [...nds, newNode])
      addLog(`✓ 已导入图片 #${sequenceNum}`, 'success')
    } catch (error) {
      console.error('导入图片失败:', error)
      addLog(`✗ 导入失败: ${error.message}`, 'error')
    }
  }, [addLog])

  // v2: 处理拖拽到画布 - 支持 ReactFlow 和原生 DOM 事件
  const handleDragOver = useCallback((event) => {
    // ReactFlow 事件或原生 DOM 事件
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy'
    }
    event.preventDefault()
    event.stopPropagation()
    if (canvasRef.current) {
      canvasRef.current.classList.add('drag-over-canvas')
    }
  }, [])

  const handleDrop = useCallback(async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (canvasRef.current) {
      canvasRef.current.classList.remove('drag-over-canvas')
    }

    // 获取文件列表
    let files = []
    if (event.dataTransfer && event.dataTransfer.files.length > 0) {
      // ReactFlow 或原生 DOM 事件
      files = Array.from(event.dataTransfer.files)
    } else if (event.nativeEvent && event.nativeEvent.dataTransfer) {
      files = Array.from(event.nativeEvent.dataTransfer.files)
    }

    const imageFiles = files.filter(f => f.type.startsWith('image/'))

    if (imageFiles.length === 0) return

    // 获取鼠标位置
    let x, y
    if (event.clientX !== undefined) {
      // 原生 DOM 事件
      const rect = canvasRef.current.getBoundingClientRect()
      x = event.clientX - rect.left
      y = event.clientY - rect.top
    } else if (event.position) {
      // ReactFlow 事件
      const rect = canvasRef.current.getBoundingClientRect()
      const flowBounds = event.position
      x = flowBounds.x + rect.left
      y = flowBounds.y + rect.top
    } else {
      // 默认位置
      x = 400
      y = 300
    }

    // 转换为画布坐标
    const position = project({ x, y })

    // v2: 直接上传文件到后端（防重复处理）
    const processedFiles = new Set()
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i]
      const fileKey = `${file.name}_${file.size}`
      if (processedFiles.has(fileKey)) continue
      processedFiles.add(fileKey)

      try {
        await createImageNode(file, {
          x: position.x + i * 250,
          y: position.y
        })
      } catch (error) {
        console.error('上传图片失败:', error)
      }
    }
  }, [createImageNode, project])

  // 处理粘贴
  useEffect(() => {
    const handlePaste = async (e) => {
      const items = e.clipboardData.items
      const imageItems = []

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          imageItems.push(items[i])
        }
      }

      if (imageItems.length === 0) return

      // 在画布中心创建节点
      const centerPosition = {
        x: 400,
        y: 300
      }

      // v2: 直接上传文件到后端（添加防重复处理）
      const processedFiles = new Set()
      for (let i = 0; i < imageItems.length; i++) {
        const file = imageItems[i].getAsFile()
        if (!file) continue
        const fileKey = `${file.name}_${file.size}`
        if (processedFiles.has(fileKey)) continue
        processedFiles.add(fileKey)

        try {
          await createImageNode(file, {
            x: centerPosition.x + i * 250,
            y: centerPosition.y
          })
        } catch (error) {
          console.error('上传图片失败:', error)
        }
      }
    }

    document.addEventListener('paste', handlePaste)
    return () => {
      document.removeEventListener('paste', handlePaste)
    }
  }, [createImageNode])

  // 连接节点
  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  )

  // 拖线创建节点 - 当拖线松开在空白处时弹出菜单
  const [connectMenu, setConnectMenu] = useState(null)
  const connectingNodeId = useRef(null)

  const onConnectStart = useCallback((event, { nodeId }) => {
    connectingNodeId.current = nodeId
  }, [])

  const onConnectEnd = useCallback((event) => {
    // 检查是否松开在节点上（如果是则不弹出菜单）
    const targetIsPane = event.target.classList.contains('react-flow__pane')

    if (targetIsPane && connectingNodeId.current) {
      // 获取鼠标位置
      const { clientX, clientY } = event

      // 显示创建节点菜单
      setConnectMenu({
        sourceNodeId: connectingNodeId.current,
        x: clientX,
        y: clientY
      })
    }
    connectingNodeId.current = null
  }, [])

  // 从拖线菜单创建节点
  const handleCreateNodeFromConnect = useCallback((nodeType) => {
    if (!connectMenu) return

    const { sourceNodeId, x, y } = connectMenu

    // 转换屏幕坐标到画布坐标
    const position = project({ x: x - 150, y: y - 50 })

    const newNodeId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    let newNode
    if (nodeType === 'image') {
      // 创建图片生成节点
      newNode = {
        id: newNodeId,
        type: 'imageNode',
        position,
        dragHandle: '.image-node-drag-handle',
        data: {
          type: 'prompt',
          status: 'idle',
          prompt: '',
          aspectRatio: '1:1',
          resolution: '2K',
          size: '',
          model: '',
          providerId: '',
          onGenerate: (...args) => callbacksRef.current.handleGenerate(...args),
          onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
          onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
          onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
        },
        connectable: true,
        draggable: true,
      }
    } else if (nodeType === 'chat') {
      // 创建对话节点
      newNode = {
        id: newNodeId,
        type: 'chatNode',  // 使用 ChatNode 组件
        position,
        dragHandle: '.chat-node-drag-handle',  // 只能通过标题栏拖动
        data: {
          type: 'chat',
          status: 'idle',
          prompt: '',
          response: '',
          preset: 'default',
          referenceImages: [],
          onChat: (...args) => callbacksRef.current.handleChat?.(...args),
        },
        connectable: true,
        draggable: true,
      }
    } else if (nodeType === 'video') {
      // 创建视频节点
      newNode = {
        id: newNodeId,
        type: 'videoNode', // 修正：使用正确的节点组件
        position,
        dragHandle: '.image-node-drag-handle',
        data: {
          type: 'video',
          status: 'idle',
          prompt: '',
          model: 'sora-2-all', // 修正默认模型
          onGenerate: (...args) => callbacksRef.current.handleGenerateVideo?.(...args),
          onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
          onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
        },
        connectable: true,
        draggable: true,
      }
    }

    if (newNode) {
      // 添加节点
      setNodes((nds) => [...nds, newNode])

      // 自动创建连线
      setEdges((eds) => addEdge({
        id: `edge_${Date.now()}`,
        source: sourceNodeId,
        target: newNodeId,
      }, eds))

      addLog(`✓ 创建${nodeType === 'image' ? '图片生成' : nodeType === 'chat' ? 'AI对话' : '视频生成'}节点`, 'success')
    }

    setConnectMenu(null)
  }, [connectMenu, project, setNodes, setEdges, addLog])

  // 右键菜单处理
  const onContextMenu = useCallback((event) => {
    event.preventDefault()

    const target = event.target

    // 检查是否点击在节点上
    const nodeElement = target.closest('.react-flow__node')
    if (nodeElement) {
      const nodeId = nodeElement.getAttribute('data-id') ||
                     target.closest('[data-testid]')?.getAttribute('data-testid')?.replace('node-', '') ||
                     nodes.find(n => {
                       const nodePos = nodeElement.getBoundingClientRect()
                       return nodePos.left <= event.clientX && event.clientX <= nodePos.right &&
                              nodePos.top <= event.clientY && event.clientY <= nodePos.bottom
                     })?.id

      if (nodeId) {
        setContextMenu({
          type: 'node',
          nodeId: nodeId,
          x: event.clientX,
          y: event.clientY
        })
        return
      }
    }

    // 检查是否点击在连线上
    const edgeElement = target.closest('.react-flow__edge')
    if (edgeElement) {
      const edgeId = edgeElement.getAttribute('data-testid')?.replace('rf__edge-', '')
      if (edgeId) {
        setContextMenu({
          type: 'edge',
          edgeId: edgeId,
          x: event.clientX,
          y: event.clientY
        })
        return
      }
    }

    // 点击在画布空白处
    setContextMenu({
      type: 'canvas',
      x: event.clientX,
      y: event.clientY
    })
  }, [nodes])

  // 右键菜单 - 新建文生图节点
  const handleNewPromptNodeFromMenu = useCallback((event) => {
    event.preventDefault()

    // 获取点击位置
    const rect = canvasRef.current.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const position = project({ x, y })

    const newNodeId = `node_${nodeIdCounter.current++}`
    const newNode = {
      id: newNodeId,
      type: 'imageNode',
      position: {
        x: position.x - 150,
        y: position.y - 100
      },
      dragHandle: '.image-node-drag-handle',
      data: {
        type: 'prompt',
        label: '文生图节点',
        status: 'idle',
        hasParent: false,
        aspectRatio: '1:1',
        resolution: '2K',
        size: '',
        model: '',
        providerId: '',
        onGenerate: (...args) => callbacksRef.current.handleGenerate(...args),
        onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
        onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
        onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
      },
      connectable: true,
      draggable: true,
    }

    setNodes((nds) => [...nds, newNode])
    addLog('✓ 已创建文生图节点', 'info')
    setContextMenu(null)
  }, [project, addLog])

  // 右键菜单 - 在画布创建节点（无连线）
  const handleCreateNodeFromCanvas = useCallback((nodeType) => {
    if (!contextMenu) return

    const { x, y } = contextMenu

    // 转换屏幕坐标到画布坐标
    const rect = canvasRef.current.getBoundingClientRect()
    const position = project({ x: x - rect.left - 150, y: y - rect.top - 50 })

    const newNodeId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    let newNode
    if (nodeType === 'image') {
      // 创建图片生成节点
      newNode = {
        id: newNodeId,
        type: 'imageNode',
        position,
        dragHandle: '.image-node-drag-handle',
        data: {
          type: 'prompt',
          status: 'idle',
          prompt: '',
          aspectRatio: '1:1',
          resolution: '2K',
          size: '',
          providerId: '',
          model: '',
          onGenerate: (...args) => callbacksRef.current.handleGenerate(...args),
          onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
          onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
          onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
        },
        connectable: true,
        draggable: true,
      }
      addLog('✓ 创建图片生成节点', 'success')
    } else if (nodeType === 'chat') {
      newNode = {
        id: newNodeId,
        type: 'chatNode',
        position,
        dragHandle: '.chat-node-drag-handle',  // 只能通过标题栏拖动
        data: {
          type: 'chat',
          status: 'idle',
          prompt: '',
          response: '',
          preset: 'default',
          referenceImages: [],
          onChat: (...args) => callbacksRef.current.handleChat?.(...args),
        },
        connectable: true,
        draggable: true,
      }
      addLog('✓ 创建AI对话节点', 'success')
    } else if (nodeType === 'video') {
      newNode = {
        id: newNodeId,
        type: 'videoNode',
        position,
        dragHandle: '.image-node-drag-handle',
        data: {
          type: 'video',
          status: 'idle',
          prompt: '',
          model: 'sora-2-all', // 修正默认模型
          onGenerate: (...args) => callbacksRef.current.handleGenerateVideo?.(...args),
          onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
          onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
        },
        connectable: true,
        draggable: true,
      }
      addLog('✓ 创建视频生成节点', 'success')
    }

    if (newNode) {
      setNodes((nds) => [...nds, newNode])
    }

    setContextMenu(null)
  }, [contextMenu, project, addLog])

  // 右键菜单 - 清空画布
  const handleClearCanvasFromMenu = useCallback((event) => {
    event.preventDefault()

    if (nodes.length > 0) {
      if (!confirm('确定要清空画布吗？此操作不可撤销。')) {
        setContextMenu(null)
        return
      }
    }

    setNodes([])
    setEdges([])
    nodeIdCounter.current = 0
    addLog('✓ 画布已清空', 'success')
    setContextMenu(null)
  }, [nodes, addLog])

  // 添加初始节点
  const addInitialNode = useCallback(() => {
    const newNodeId = `node_${nodeIdCounter.current++}`
    const newNode = {
      id: newNodeId,
      type: 'imageNode',
      position: { x: 250, y: 100 },
      dragHandle: '.image-node-drag-handle',
      data: {
        type: 'prompt',
        label: '提示词节点',
        status: 'idle',
        hasParent: false,
        aspectRatio: '1:1',
        resolution: '2K',
        size: '',
        model: '',
        providerId: '',
        onGenerate: (...args) => callbacksRef.current.handleGenerate(...args),
        onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
        onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
        onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
      },
      connectable: true,
      draggable: true,
    }
    setNodes((nds) => [...nds, newNode])
  }, [])

  // 对话节点处理
  const handleChat = useCallback(async (nodeId, formData) => {
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current

    addLog(`💬 对话请求: ${formData.prompt.substring(0, 50)}...`, 'info')
    addLog(`使用预设: ${formData.preset}`, 'info')

    // 查找父节点的图片作为参考
    const parentEdges = currentEdges.filter((e) => e.target === nodeId)
    const referenceImages = []

    for (const edge of parentEdges) {
      const parentNode = currentNodes.find((n) => n.id === edge.source)
      if (parentNode && parentNode.data.imageUrl) {
        referenceImages.push(parentNode.data.imageUrl)
      }
    }

    if (referenceImages.length > 0) {
      addLog(`📷 分析 ${referenceImages.length} 张参考图`, 'info')
    }

    try {
      // 调用对话 API
      const { chatWithAI } = await import('../utils/api')
      const result = await chatWithAI({
        prompt: formData.prompt,
        system_prompt: formData.systemPrompt,
        reference_images: referenceImages,
      })

      if (result.success) {
        addLog('✓ 对话完成', 'success')
        return { success: true, response: result.response }
      } else {
        addLog(`✗ 对话失败: ${result.error}`, 'error')
        return { success: false, error: result.error }
      }
    } catch (error) {
      addLog(`✗ 对话失败: ${error.message}`, 'error')
      return { success: false, error: error.message }
    }
  }, [addLog])

  // 重新生成（另存为新节点）或保存标注图为新节点
  const handleRegenerateNew = useCallback(async (sourceNodeId, formData) => {
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current
    const sourceNode = currentNodes.find(n => n.id === sourceNodeId)
    if (!sourceNode) return

    // 1. 准备新节点
    const newNodeId = `node_${nodeIdCounter.current++}`
    const newPosition = {
      x: sourceNode.position.x + 50,
      y: sourceNode.position.y + 50
    }

    // 查找原节点的父级连线
    const parentEdges = currentEdges.filter(e => e.target === sourceNodeId)

    // === saveOnly 模式：只保存标注图为新节点，不生成 ===
    if (formData.saveOnly && formData.imageUrl) {
      addLog('保存标注图为新节点...', 'info')
      console.log('[handleRegenerateNew] saveOnly 模式，imageUrl:', formData.imageUrl)

      const sequenceNum = ++sequenceNumCounter.current
      const normalized = normalizeImageParams(formData, { hasReferenceImage: true })
      const newNode = {
        id: newNodeId,
        type: 'imageNode',
        position: newPosition,
        dragHandle: '.image-node-drag-handle',
        data: {
          type: 'image',
          status: 'completed',
          imageUrl: formData.imageUrl,
          prompt: formData.savedPrompt || '标注图',  // 保存提示词
          savedPrompt: formData.savedPrompt || '',   // 额外保存用于编辑器
          annotationData: formData.annotationData || null,  // 保存画布数据
          aspectRatio: normalized.aspectRatio,
          resolution: normalized.resolution,
          size: normalized.size,
          providerId: normalized.providerId,
          model: normalized.model,
          sequenceNum: sequenceNum,
          // 绑定所有回调
          onGenerate: (...args) => callbacksRef.current.handleGenerate(...args),
          onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
          onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
          onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
        },
        connectable: true,
        draggable: true
      }

      setNodes(nds => [...nds, newNode])

      // 创建连线：标注图连接到源节点
      const newEdge = {
        id: `edge_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        source: sourceNodeId,
        target: newNodeId,
        type: 'smoothstep'
      }
      setEdges(eds => [...eds, newEdge])

      addLog(`✓ 标注图已保存为新节点 #${sequenceNum}`, 'success')
      return
    }

    // === 正常模式：生成新图片 ===
    addLog('开始重新生成(新节点)...', 'info')
    console.log('[handleRegenerateNew] 开始，formData:', formData)

    // 2. 准备参考图
    const referenceImages = []
    const weightedReferences = []

    // 如果有标注后的图片，优先使用它作为参考图
    if (formData.referenceImageUrl) {
      addLog('使用标注后的图片作为参考图', 'info')
      console.log('[handleRegenerateNew] 使用标注图片:', formData.referenceImageUrl)
      referenceImages.push(formData.referenceImageUrl)
      weightedReferences.push('[标注图片] 权重:最高')
    } else {
      // 否则查找原节点的父级连线作为参考图
      for (let i = 0; i < parentEdges.length; i++) {
        const edge = parentEdges[i]
        const parentNode = currentNodes.find(n => n.id === edge.source)
        if (parentNode && parentNode.data.type === 'image' && parentNode.data.imageUrl) {
          referenceImages.push(parentNode.data.imageUrl)

          // 权重计算
          const weight = parentEdges.length - i
          const referencePrompt = parentNode.data.prompt || `参考图${i + 1}`
          weightedReferences.push(`[${referencePrompt}] 权重:${weight}`)
        }
      }
    }

    if (referenceImages.length > 0) {
      addLog(`使用 ${referenceImages.length} 张参考图`, 'info')
      console.log('[handleRegenerateNew] 参考图列表:', referenceImages)
    }

    // 构建提示词
    let enhancedPrompt = formData.prompt
    if (weightedReferences.length > 0) {
      enhancedPrompt = `${formData.prompt}\n\n参考要求：\n${weightedReferences.join('\n')}`
    }

    const { normalized, payload } = buildGeneratePayload(formData, enhancedPrompt, referenceImages)

    // 3. 创建新节点 (生成中状态)
    const newNode = {
      id: newNodeId,
      type: 'imageNode',
      position: newPosition,
      dragHandle: '.image-node-drag-handle',
      data: {
        type: 'image',
        status: 'generating',
        prompt: formData.prompt,
        aspectRatio: normalized.aspectRatio,
        resolution: normalized.resolution,
        size: normalized.size,
        providerId: normalized.providerId,
        model: normalized.model,
        // 绑定所有回调
        onGenerate: (...args) => callbacksRef.current.handleGenerate(...args),
        onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
        onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
        onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
      },
      connectable: true,
      draggable: true
    }

    setNodes(nds => [...nds, newNode])

    // 4. 创建连线
    if (formData.referenceImageUrl) {
      // 如果是标注生成，新节点连接到源节点（被标注的图片）
      const newEdge = {
        id: `edge_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        source: sourceNodeId,
        target: newNodeId,
        type: 'smoothstep'
      }
      setEdges(eds => [...eds, newEdge])
    } else {
      // 否则复制原来的父级连线
      const newEdges = parentEdges.map(e => ({
        ...e,
        id: `edge_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        target: newNodeId
      }))
      setEdges(eds => [...eds, ...newEdges])
    }

    // 5. 调用 API 生成
    try {
      console.log('[handleRegenerateNew] 调用 generateImage API...')
      console.log('[handleRegenerateNew] 参数:', payload)
      
      const result = await generateImage(payload)
      
      console.log('[handleRegenerateNew] API 返回结果:', result)

      if (result.success && result.pending) {
        setNodes(nds => nds.map(n => n.id === newNodeId ? {
          ...n,
          data: {
            ...n.data,
            status: 'queued',
            flowBridge: {
              taskId: result.task_id,
              jobId: result.job_id,
              jobsFile: result.jobs_file,
              bridgeUrl: result.bridge_url,
              stage: 'queued',
              state: 'queued',
              statusText: '已提交到 Flow 队列',
              statusDetail: '等待队列导出和执行器接手',
              submittedAt: new Date().toISOString(),
              downloadResolution: result.download_resolution || '1K',
            }
          }
        } : n))
        addLog(`✓ Flow任务已排队: ${result.task_id}`, 'success')
        return
      }

      if (result.success && result.images?.length > 0) {
        const sequenceNum = ++sequenceNumCounter.current

        setNodes(nds => nds.map(n => n.id === newNodeId ? {
          ...n,
          data: {
            ...n.data,
            status: 'completed',
            imageUrl: result.images[0].url,
            thumbnail: result.images[0].thumbnail,
            filename: result.images[0].filename,
            sequenceNum: sequenceNum
          }
        } : n))

        addLog(`✓ 新图生成成功 #${sequenceNum}`, 'success')
      } else {
        const errorMsg = result.error || '生成失败'
        setNodes(nds => nds.map(n => n.id === newNodeId ? {
          ...n,
          data: { ...n.data, status: 'failed', error: errorMsg }
        } : n))
        addLog(`✗ ${errorMsg}`, 'error')
      }
    } catch (error) {
      console.error('重新生成失败:', error)
      setNodes(nds => nds.map(n => n.id === newNodeId ? {
        ...n,
        data: { ...n.data, status: 'failed', error: error.message }
      } : n))
      addLog(`✗ 生成失败: ${error.message}`, 'error')
    }
  }, [addLog, buildGeneratePayload, normalizeImageParams])

  // 更新节点图片 (用于标注编辑后)
  const handleUpdateImage = useCallback((nodeId, newImageUrl) => {
    setNodes(nds => nds.map(n => n.id === nodeId ? {
      ...n,
      data: {
        ...n.data,
        imageUrl: newImageUrl,
        // 保持其他属性不变
      }
    } : n))
    addLog('图片标注已更新', 'success')
  }, [addLog])

  const handleFlowRedownload = useCallback(async (sourceNodeId, resolution = '2K') => {
    const sourceNode = nodesRef.current.find((n) => n.id === sourceNodeId)
    if (!sourceNode) return

    const targetResolution = ['1K', '2K', '4K'].includes(String(resolution).toUpperCase())
      ? String(resolution).toUpperCase()
      : '2K'
    const flowBridge = sourceNode.data.flowBridge || {}
    const flowArtifact = sourceNode.data.flowArtifact || {}
    const sourceJobId = flowArtifact.jobId || flowBridge.jobId || flowBridge.taskId
    if (!sourceJobId) {
      addLog('✗ 这张图没有 Flow job 信息，不能从 Flow 重新下载高清版', 'error')
      return
    }

    try {
      addLog(`提交 Flow ${targetResolution} 高清下载...`, 'info')
      const payload = {
        source_job_id: sourceJobId,
        source_run_id: flowArtifact.runId || flowBridge.runId || '',
        candidate_index: flowArtifact.candidateIndex ?? flowArtifact.candidate_index ?? 0,
        flow_url: flowArtifact.flowUrl || flowArtifact.flow_url || flowBridge.flowUrl || flowBridge.flow_url || flowBridge.projectUrl || '',
        prompt: sourceNode.data.prompt || '',
        aspect_ratio: sourceNode.data.aspectRatio || '1:1',
        download_resolution: targetResolution,
        provider_id: sourceNode.data.providerId || flowBridge.providerId || 'flow_web_local',
        model: sourceNode.data.model || flowBridge.model || 'flow-web-image',
      }

      const result = await redownloadFlowImage(payload)
      if (!result.success || !result.pending) {
        throw new Error(result.error || 'Flow 高清下载提交失败')
      }

      const newNodeId = `node_${nodeIdCounter.current++}`
      const submittedAt = new Date().toISOString()
      const newNode = {
        id: newNodeId,
        type: 'imageNode',
        position: {
          x: sourceNode.position.x + 80,
          y: sourceNode.position.y + 80,
        },
        dragHandle: '.image-node-drag-handle',
        data: {
          type: 'prompt',
          label: `${targetResolution} 高清下载`,
          status: 'queued',
          prompt: sourceNode.data.prompt || '',
          aspectRatio: sourceNode.data.aspectRatio || '1:1',
          resolution: targetResolution,
          size: targetResolution,
          providerId: sourceNode.data.providerId || payload.provider_id,
          model: sourceNode.data.model || payload.model,
          flowBridge: {
            taskId: result.task_id,
            jobId: result.job_id,
            jobsFile: result.jobs_file,
            bridgeUrl: result.bridge_url,
            sourceJobId,
            sourceRunId: payload.source_run_id,
            sourceNodeId,
            stage: 'queued',
            state: 'queued',
            statusText: `已提交 ${targetResolution} 高清下载`,
            statusDetail: payload.flow_url ? '将打开原 Flow 结果页下载' : '将尝试使用当前 Flow 页面下载',
            submittedAt,
            downloadResolution: targetResolution,
          },
          sourceReferenceImages: [{ url: sourceNode.data.imageUrl }],
          onGenerate: (...args) => callbacksRef.current.handleGenerate(...args),
          onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
          onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
          onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
          onFlowRedownload: (...args) => callbacksRef.current.handleFlowRedownload?.(...args),
        },
        connectable: true,
        draggable: true,
      }

      const newEdge = {
        id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        source: sourceNodeId,
        target: newNodeId,
        type: 'smoothstep',
      }

      setNodes((nds) => [...nds, newNode])
      setEdges((eds) => [...eds, newEdge])
      addLog(`✓ Flow ${targetResolution} 高清下载已排队: ${result.task_id}`, 'success')
    } catch (error) {
      console.error('Flow 高清下载失败:', error)
      addLog(`✗ Flow 高清下载失败: ${error.message}`, 'error')
    }
  }, [addLog])

  // 自动更新视频节点的参考图数据 - 强制注入模式
  useEffect(() => {
    // 1. 查找所有视频节点
    const videoNodes = nodes.filter(n => n.type === 'videoNode' || n.data?.type === 'video')
    if (videoNodes.length === 0) return

    // 2. 计算每个视频节点应该有的参考图
    setNodes(currentNodes => {
      let hasChanges = false
      const newNodes = currentNodes.map(node => {
        if (node.type !== 'videoNode' && node.data?.type !== 'video') return node

        const parentEdges = edges.filter(e => e.target === node.id)
        const refs = parentEdges.map(edge => {
          const parentNode = currentNodes.find(n => n.id === edge.source)
          if (parentNode && parentNode.data && parentNode.data.imageUrl) {
            return {
              id: parentNode.id,
              imageUrl: parentNode.data.imageUrl,
              sequenceNum: parentNode.data.sequenceNum
            }
          }
          return null
        }).filter(Boolean)

        // 3. 对比并更新
        const currentRefs = node.data.referenceImages || []
        if (JSON.stringify(currentRefs) !== JSON.stringify(refs)) {
          hasChanges = true
          console.log(`[Canvas] 强制注入参考图到节点 ${node.id}:`, refs)
          return {
            ...node,
            data: { ...node.data, referenceImages: refs }
          }
        }
        return node
      })

      return hasChanges ? newNodes : currentNodes
    })
  }, [edges, JSON.stringify(nodes.map(n => n.data.imageUrl))]) // 监听连线和图片变化

  // 视频生成回调 (带进度显示)
  const handleGenerateVideo = useCallback(async (nodeId, formData) => {
    const currentNodes = nodesRef.current
    const currentEdges = edgesRef.current
    const node = currentNodes.find((n) => n.id === nodeId)
    if (!node) return

    addLog('开始生成视频...', 'info')
    addLog(`提示词: ${formData.prompt}`, 'info')
    addLog(`模型: ${formData.model}`, 'info')

    // 收集参考图 (从连接的父节点)
    const parentEdges = currentEdges.filter((e) => e.target === nodeId)
    const referenceImages = []

    for (const edge of parentEdges) {
      const parentNode = currentNodes.find((n) => n.id === edge.source)
      if (parentNode && parentNode.data.type === 'image' && parentNode.data.imageUrl) {
        referenceImages.push(parentNode.data.imageUrl)
      }
    }

    if (referenceImages.length > 0) {
      addLog(`使用 ${referenceImages.length} 张参考图`, 'info')
    }

    // 更新状态为生成中
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, status: 'generating', progress: 0 } }
          : n
      )
    )

    try {
      // 1. 创建任务
      const createResult = await createVideoTask({
        prompt: formData.prompt,
        model: formData.model,
        duration: formData.duration,
        ratio: formData.ratio,
        quality: formData.quality,
        image_urls: referenceImages // 传递参考图
      })

      if (!createResult.success || !createResult.task_id) {
        throw new Error(createResult.error || '创建任务失败')
      }

      const taskId = createResult.task_id
      addLog(`任务已创建: ${taskId}`, 'info')

      // 2. 轮询进度
      const maxAttempts = 120  // 最多轮询 10 分钟 (5秒 * 120)
      let attempts = 0

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000))  // 等待 5 秒
        attempts++

        const statusResult = await pollVideoStatus(taskId)

        if (!statusResult.success) {
          addLog(`⚠️ 查询状态失败`, 'warning')
          continue
        }

        const { status, progress } = statusResult

        // 更新进度
        setNodes((nds) =>
          nds.map((n) =>
            n.id === nodeId
              ? { ...n, data: { ...n.data, progress: progress || 0 } }
              : n
          )
        )

        if (progress > 0) {
          addLog(`⏳ 进度: ${progress}%`, 'info')
        }

        if (status === 'completed' || status === 'succeeded') {
          addLog(`✓ 视频生成成功!`, 'success')
          setNodes((nds) =>
            nds.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      status: 'completed',
                      progress: 100,
                      videoUrl: statusResult.video_url,
                      filename: statusResult.filename,
                      remoteUrl: statusResult.remote_url
                    }
                  }
                : n
            )
          )
          return
        }

        if (status === 'failed' || status === 'error') {
          throw new Error(statusResult.error || '视频生成失败')
        }
      }

      throw new Error('视频生成超时')

    } catch (error) {
      console.error('视频生成失败:', error)
      addLog(`✗ 生成失败: ${error.message}`, 'error')
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, status: 'failed', error: error.message } }
            : n
        )
      )
    }
  }, [addLog])

  // 回调函数 ref - 用于在节点中调用
  const callbacksRef = useRef({ handleGenerate, handleAddChild, handleChat, handleRegenerateNew, handleGenerateVideo, handleUpdateImage, handleFlowRedownload })

  // 节点变化处理 - 包含撤销/重做时的回调重新绑定
  const onNodesChangeWithCallbackRestore = useCallback((changes) => {
    // 先执行原始的 onNodesChange
    onNodesChange(changes)

    // 检查是否有节点丢失了回调函数（撤销/重做时可能发生）
    setNodes(currentNodes => {
      const nodesNeedingCallbacks = currentNodes.filter(n =>
        (n.type === 'imageNode' || n.type === 'chatNode' || n.type === 'videoNode') &&
        (!n.data.onRegenerate || !n.data.onGenerate || !n.data.onFlowRedownload)
      )

      if (nodesNeedingCallbacks.length > 0) {
        console.log(`[Canvas] 检测到 ${nodesNeedingCallbacks.length} 个节点缺少回调，正在恢复...`, changes.map(c => c.type))
        return currentNodes.map(n => ({
          ...n,
          data: {
            ...n.data,
            onGenerate: n.type === 'videoNode'
              ? (...args) => callbacksRef.current.handleGenerateVideo(...args)
              : (...args) => callbacksRef.current.handleGenerate(...args),
            onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
            onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
            onChat: (...args) => callbacksRef.current.handleChat?.(...args),
            onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
            onFlowRedownload: (...args) => callbacksRef.current.handleFlowRedownload?.(...args),
          },
        }))
      }

      return currentNodes
    })
  }, [onNodesChange])

  // 保持 callbacksRef.current 与最新的回调同步
  useEffect(() => {
    callbacksRef.current = { handleGenerate, handleAddChild, handleChat, handleRegenerateNew, handleGenerateVideo, handleUpdateImage, handleFlowRedownload }
  }, [handleGenerate, handleAddChild, handleChat, handleRegenerateNew, handleGenerateVideo, handleUpdateImage, handleFlowRedownload])

  useEffect(() => {
    let cancelled = false

    const isTerminalFlowFailure = (state) => {
      const normalized = String(state || '').toLowerCase()
      if (!normalized) return false
      return !['queued', 'exported', 'running', 'pending', 'submitting', 'waiting_render', 'downloading', 'done'].includes(normalized)
    }

    const attachImageCallbacks = () => ({
      onGenerate: (...args) => callbacksRef.current.handleGenerate(...args),
      onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
      onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
      onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
      onFlowRedownload: (...args) => callbacksRef.current.handleFlowRedownload?.(...args),
    })

    const applyFlowProgress = (queuedNode, result, latestState) => {
      const progress = result?.progress || {}
      const statusText = progress.status_text || progress.statusText
      if (!statusText) return

      const statusDetail = progress.status_detail || progress.statusDetail || ''
      const progressState = progress.state || latestState || 'queued'
      setNodes((currentNodes) =>
        currentNodes.map((node) => {
          if (node.id !== queuedNode.id || node.data?.imageUrl) return node

          const nextFlowBridge = {
            ...node.data.flowBridge,
            stage: progress.stage || node.data.flowBridge?.stage,
            state: progressState,
            statusText,
            statusDetail,
            eventType: progress.event_type || progress.eventType || node.data.flowBridge?.eventType,
            runId: progress.run_id || progress.runId || node.data.flowBridge?.runId,
            updatedAt: progress.updated_at || progress.updatedAt || new Date().toISOString(),
          }

          const nextStatus = node.data.status === 'failed' && !isTerminalFlowFailure(progressState)
            ? 'queued'
            : node.data.status

          if (
            node.data.status === nextStatus
            && node.data.flowBridge?.statusText === nextFlowBridge.statusText
            && node.data.flowBridge?.statusDetail === nextFlowBridge.statusDetail
            && node.data.flowBridge?.stage === nextFlowBridge.stage
            && node.data.flowBridge?.state === nextFlowBridge.state
          ) {
            return node
          }

          return {
            ...node,
            data: {
              ...node.data,
              status: nextStatus,
              error: nextStatus === 'failed' ? node.data.error : '',
              flowBridge: nextFlowBridge,
            },
          }
        })
      )
    }

    const pollFlowBridgeJobs = async () => {
      const queuedNodes = nodesRef.current.filter((node) =>
        ['queued', 'failed'].includes(node.data?.status)
        && node.data?.flowBridge?.jobId
        && !node.data?.imageUrl
      )

      for (const queuedNode of queuedNodes) {
        const jobId = queuedNode.data.flowBridge.jobId
        if (flowBridgePollInFlightRef.current.has(jobId)) continue

        flowBridgePollInFlightRef.current.add(jobId)
        try {
          const result = await getFlowBridgeJob(jobId, { provider_id: queuedNode.data.providerId })
          if (cancelled) return

          const images = Array.isArray(result.images) ? result.images : []
          const latestResult = Array.isArray(result.artifact_results) ? result.artifact_results[0] : null
          const progress = result.progress || {}
          const latestState = progress.state || latestResult?.state || result.job?.state || result.job?.status || result.job?.job?.state
          if (result.success) {
            applyFlowProgress(queuedNode, result, latestState)
          }

          if (result.success && images.length > 0) {
            const completedAt = new Date().toISOString()
            const importedResolution = result.download_resolution || images[0]?.download_resolution || '1K'

            setNodes((currentNodes) => {
              const targetNode = currentNodes.find((node) => node.id === queuedNode.id)
              if (
                !targetNode
                || !['queued', 'failed'].includes(targetNode.data?.status)
                || targetNode.data?.imageUrl
              ) return currentNodes

              const makeImageData = (baseData, image, index, sequenceNum) => {
                const candidateIndex = Number.isFinite(Number(image.candidate_index))
                  ? Number(image.candidate_index)
                  : index
                const downloadResolution = image.download_resolution || importedResolution || baseData.flowBridge?.downloadResolution || '1K'
                const flowBridge = {
                  ...baseData.flowBridge,
                  status: 'done',
                  stage: 'completed',
                  state: 'done',
                  statusText: `完成，已回传 ${images.length} 张图`,
                  statusDetail: `下载清晰度 ${downloadResolution}`,
                  resultState: image.result_state || latestState || 'done',
                  runId: image.run_id || latestResult?.run_id || baseData.flowBridge?.runId,
                  flowUrl: image.flow_url || latestResult?.result?.url || latestResult?.url || baseData.flowBridge?.flowUrl,
                  completedAt,
                  importedAt: completedAt,
                  candidateCount: images.length,
                  downloadResolution,
                }

                return {
                  ...baseData,
                  type: 'image',
                  status: 'completed',
                  imageUrl: image.url,
                  thumbnail: image.thumbnail,
                  filename: image.filename,
                  sequenceNum,
                  resolution: downloadResolution,
                  createdAt: baseData.createdAt || completedAt,
                  flowBridge,
                  flowArtifact: {
                    jobId: flowBridge.jobId,
                    runId: flowBridge.runId,
                    flowUrl: image.flow_url || latestResult?.result?.url || latestResult?.url || flowBridge.flowUrl,
                    sourcePath: image.source_path,
                    candidateIndex,
                    downloadResolution,
                    resultState: image.result_state || latestState || 'done',
                  },
                  ...attachImageCallbacks(),
                }
              }

              const mainSequenceNum = targetNode.data.sequenceNum || ++sequenceNumCounter.current
              const updatedNodes = currentNodes.map((node) =>
                node.id === targetNode.id
                  ? {
                      ...node,
                      data: makeImageData(targetNode.data, images[0], 0, mainSequenceNum),
                    }
                  : node
              )

              const extraNodes = images.slice(1).map((image, index) => {
                const imageIndex = index + 1
                const sequenceNum = ++sequenceNumCounter.current
                return {
                  id: `node_${nodeIdCounter.current++}`,
                  type: 'imageNode',
                  position: {
                    x: targetNode.position.x + imageIndex * 320,
                    y: targetNode.position.y,
                  },
                  dragHandle: '.image-node-drag-handle',
                  data: makeImageData(targetNode.data, image, imageIndex, sequenceNum),
                  connectable: true,
                  draggable: true,
                }
              })

              return [...updatedNodes, ...extraNodes]
            })

            addLog(`✓ Flow已回流 ${images.length} 张 ${importedResolution} 候选图`, 'success')
          } else if (result.success && isTerminalFlowFailure(latestState)) {
            const errorMsg = latestResult?.error || latestResult?.reason || `Flow任务失败: ${latestState}`
            setNodes((currentNodes) =>
              currentNodes.map((node) =>
                node.id === queuedNode.id
                  ? {
                      ...node,
                      data: {
                        ...node.data,
                        status: 'failed',
                        error: errorMsg,
                        flowBridge: {
                          ...node.data.flowBridge,
                          stage: 'failed',
                          state: latestState,
                          statusText: `失败：${errorMsg}`,
                          statusDetail: progress.status_detail || progress.statusDetail || '',
                        },
                      },
                    }
                  : node
              )
            )
            addLog(`✗ ${errorMsg}`, 'error')
          }
        } catch (error) {
          if (!cancelled) {
            console.warn('[Flow Bridge] 查询失败:', error)
          }
        } finally {
          flowBridgePollInFlightRef.current.delete(jobId)
        }
      }
    }

    pollFlowBridgeJobs()
    const timer = window.setInterval(pollFlowBridgeJobs, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [addLog, setNodes])

  useEffect(() => {
    // 初始化时设置回调
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        data: {
          ...n.data,
          onGenerate: n.type === 'videoNode'
            ? (...args) => callbacksRef.current.handleGenerateVideo(...args)
            : (...args) => callbacksRef.current.handleGenerate(...args),
          onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
          onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
          onChat: (...args) => callbacksRef.current.handleChat?.(...args),
          onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
          onFlowRedownload: (...args) => callbacksRef.current.handleFlowRedownload?.(...args),
        },
      }))
    )
  }, [])  // 空依赖，只执行一次

  // 生成项目数据
  const createProjectData = useCallback(() => {
    const cleanNodes = nodes.map(node => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: {
        type: node.data.type,
        status: node.data.status,
        imageUrl: node.data.imageUrl,
        thumbnail: node.data.thumbnail,
        filename: node.data.filename,
        prompt: node.data.prompt,
        aspectRatio: node.data.aspectRatio,
        resolution: node.data.resolution,
        size: node.data.size,
        providerId: node.data.providerId,
        model: node.data.model,
        error: node.data.error,
        hasParent: node.data.hasParent
      },
      connectable: node.connectable,
      draggable: node.draggable
    }))

    return {
      id: currentProjectId || generateProjectId(),
      name: currentProjectName,
      createdAt: currentProjectId ? undefined : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: cleanNodes,
      edges: edges,
      thumbnail: null
    }
  }, [nodes, edges, currentProjectId, currentProjectName])

  // 新建项目（让用户选择保存位置和名称）
  const handleNewProject = useCallback(async () => {
    if (nodes.length > 0) {
      if (!confirm('当前项目有未保存的内容，确定要新建项目吗？')) return
    }

    // 让用户输入项目名称
    const projectName = prompt('请输入新项目名称:', '未命名项目')
    if (projectName === null) return  // 用户取消
    
    const newName = projectName.trim() || '未命名项目'
    const newId = generateProjectId()
    
    // 清空画布
    setNodes([])
    setEdges([])
    setCurrentProjectId(newId)
    setCurrentProjectName(newName)
    nodeIdCounter.current = 0
    sequenceNumCounter.current = 0
    
    // 清除文件句柄，这样保存时会弹出对话框
    browserFS.clearHandle()

    // 立即让用户选择保存位置
    try {
      const projectData = {
        id: newId,
        name: newName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodes: [],
        edges: [],
        thumbnail: null
      }
      
      if (isFileSystemSupported()) {
        const result = await browserFS.saveProjectAs(projectData)
        if (result.method === 'native') {
          addLog(`✓ 新项目已创建: ${result.fileName}`, 'success')
        } else {
          addLog('✓ 新项目已创建并下载', 'success')
        }
      } else {
        addLog('✓ 已创建新项目', 'success')
      }
    } catch (error) {
      if (error.message !== '用户取消保存') {
        addLog(`✗ 创建失败: ${error.message}`, 'error')
      } else {
        // 用户取消保存，但项目已创建
        addLog('✓ 已创建新项目（未保存到文件）', 'info')
      }
    }
  }, [nodes, addLog])

  // 打开项目（浏览器原生对话框）
  const handleOpenProject = useCallback(async () => {
    try {
      const project = await browserFS.loadProject()
      // 兼容旧数据：添加 dragHandle 配置
      const nodesWithHandle = project.nodes.map(hydrateLoadedNode)
      setNodes(nodesWithHandle)
      setCanvasKey(key => key + 1)
      setEdges(project.edges || [])
      setCurrentProjectId(project.id)
      setCurrentProjectName(project.name)

      const maxId = Math.max(
        ...project.nodes.map(n => {
          const match = n.id.match(/node_(\d+)/)
          return match ? parseInt(match[1]) : 0
        }),
        0
      )
      nodeIdCounter.current = maxId + 1

      addLog(`✓ 已打开项目"${project.name}"`, 'success')
    } catch (error) {
      if (error.message !== '用户取消选择') {
        addLog(`✗ 打开失败: ${error.message}`, 'error')
      }
    }
  }, [addLog, hydrateLoadedNode])

  // 保存项目（直接保存到当前文件，如果是新项目则弹出对话框）
  const handleSaveProject = useCallback(async () => {
    try {
      const projectData = createProjectData()

      if (isFileSystemSupported()) {
        const result = await browserFS.saveProject(projectData)
        setCurrentProjectId(projectData.id)
        setCurrentProjectName(projectData.name)

        if (result.method === 'native') {
          if (result.isOverwrite) {
            addLog(`✓ 项目已保存`, 'success')
          } else {
            addLog(`✓ 项目已保存: ${result.fileName}`, 'success')
          }
        } else {
          addLog('✓ 项目已下载', 'success')
        }
      } else {
        await projectDB.saveProject(projectData)
        setCurrentProjectId(projectData.id)
        setCurrentProjectName(projectData.name)
        addLog('✓ 项目已保存', 'success')
      }
    } catch (error) {
      if (error.message !== '用户取消保存') {
        console.error('保存项目失败:', error)
        addLog(`✗ 保存失败: ${error.message}`, 'error')
      }
    }
  }, [createProjectData, addLog])

  // 另存为（强制弹出保存对话框）
  const handleSaveProjectAs = useCallback(async () => {
    try {
      // 让用户输入新项目名称
      const newName = prompt('请输入项目名称:', currentProjectName)
      if (newName === null) return  // 用户取消
      
      const projectData = createProjectData()
      projectData.name = newName.trim() || currentProjectName
      projectData.id = generateProjectId()  // 生成新ID

      if (isFileSystemSupported()) {
        const result = await browserFS.saveProjectAs(projectData)
        setCurrentProjectId(projectData.id)
        setCurrentProjectName(projectData.name)

        if (result.method === 'native') {
          addLog(`✓ 项目已另存为: ${result.fileName}`, 'success')
        } else {
          addLog('✓ 项目已下载', 'success')
        }
      } else {
        await projectDB.saveProject(projectData)
        setCurrentProjectId(projectData.id)
        setCurrentProjectName(projectData.name)
        addLog('✓ 项目已另存为', 'success')
      }
    } catch (error) {
      if (error.message !== '用户取消保存') {
        console.error('另存为失败:', error)
        addLog(`✗ 另存为失败: ${error.message}`, 'error')
      }
    }
  }, [createProjectData, currentProjectName, addLog])

  // 复制选中的节点 (Ctrl+C)
  const handleCopyNodes = useCallback(() => {
    const selectedNodes = nodes.filter(n => n.selected)
    if (selectedNodes.length === 0) {
      addLog('没有选中的节点', 'warning')
      return
    }
    
    // 获取选中节点的ID集合
    const selectedNodeIds = new Set(selectedNodes.map(n => n.id))
    
    // 获取选中节点之间的边
    const selectedEdges = edges.filter(e => 
      selectedNodeIds.has(e.source) && selectedNodeIds.has(e.target)
    )
    
    // 保存到剪贴板
    clipboardRef.current = {
      nodes: selectedNodes.map(n => ({
        ...n,
        data: { ...n.data }  // 深拷贝 data
      })),
      edges: selectedEdges.map(e => ({ ...e }))
    }
    
    addLog(`✓ 已复制 ${selectedNodes.length} 个节点`, 'success')
  }, [nodes, edges, addLog])

  // 粘贴节点 (Ctrl+V)
  const handlePasteNodes = useCallback(() => {
    const { nodes: copiedNodes, edges: copiedEdges } = clipboardRef.current
    if (copiedNodes.length === 0) {
      addLog('剪贴板为空', 'warning')
      return
    }
    
    // 创建 ID 映射表（旧ID -> 新ID）
    const idMap = new Map()
    const offset = 50  // 粘贴时的位置偏移
    
    // 创建新节点
    const newNodes = copiedNodes.map(node => {
      const newId = `node_${nodeIdCounter.current++}`
      idMap.set(node.id, newId)
      
      return {
        ...node,
        id: newId,
        position: {
          x: node.position.x + offset,
          y: node.position.y + offset
        },
        selected: true,
        data: {
          ...node.data,
          // 重新绑定回调
          onGenerate: node.type === 'videoNode'
            ? (...args) => callbacksRef.current.handleGenerateVideo(...args)
            : (...args) => callbacksRef.current.handleGenerate(...args),
          onAddChild: (...args) => callbacksRef.current.handleAddChild(...args),
          onRegenerate: (...args) => callbacksRef.current.handleRegenerateNew(...args),
          onChat: (...args) => callbacksRef.current.handleChat?.(...args),
          onUpdateImage: (...args) => callbacksRef.current.handleUpdateImage?.(...args),
        }
      }
    })
    
    // 创建新边（使用新的节点ID）
    const newEdges = copiedEdges.map(edge => ({
      ...edge,
      id: `edge_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      source: idMap.get(edge.source),
      target: idMap.get(edge.target)
    }))
    
    // 取消当前选中
    setNodes(nds => nds.map(n => ({ ...n, selected: false })))
    
    // 添加新节点和边
    setNodes(nds => [...nds, ...newNodes])
    setEdges(eds => [...eds, ...newEdges])
    
    addLog(`✓ 已粘贴 ${newNodes.length} 个节点`, 'success')
  }, [addLog])

  // 导出选中节点为新项目
  const handleExportSelectedNodes = useCallback(async () => {
    const selectedNodes = nodes.filter(n => n.selected)
    if (selectedNodes.length === 0) {
      addLog('请先选中要导出的节点', 'warning')
      return
    }
    
    // 获取选中节点的ID集合
    const selectedNodeIds = new Set(selectedNodes.map(n => n.id))
    
    // 获取选中节点之间的边
    const selectedEdges = edges.filter(e => 
      selectedNodeIds.has(e.source) && selectedNodeIds.has(e.target)
    )
    
    // 让用户输入新项目名称
    const projectName = prompt('请输入导出项目的名称:', '导出的节点')
    if (projectName === null) return
    
    // 清理节点数据（移除回调函数）
    const cleanNodes = selectedNodes.map(node => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: {
        type: node.data.type,
        status: node.data.status,
        imageUrl: node.data.imageUrl,
        thumbnail: node.data.thumbnail,
        filename: node.data.filename,
        prompt: node.data.prompt,
        aspectRatio: node.data.aspectRatio,
        resolution: node.data.resolution,
        size: node.data.size,
        providerId: node.data.providerId,
        model: node.data.model,
        error: node.data.error,
        hasParent: node.data.hasParent
      },
      connectable: node.connectable,
      draggable: node.draggable
    }))
    
    const projectData = {
      id: generateProjectId(),
      name: projectName.trim() || '导出的节点',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: cleanNodes,
      edges: selectedEdges,
      thumbnail: null
    }
    
    try {
      if (isFileSystemSupported()) {
        const result = await browserFS.saveProjectAs(projectData)
        if (result.method === 'native') {
          addLog(`✓ 已导出 ${selectedNodes.length} 个节点到: ${result.fileName}`, 'success')
        } else {
          addLog(`✓ 已导出 ${selectedNodes.length} 个节点`, 'success')
        }
      }
    } catch (error) {
      if (error.message !== '用户取消保存') {
        addLog(`✗ 导出失败: ${error.message}`, 'error')
      }
    }
  }, [nodes, edges, addLog])

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e) => {
      // 如果焦点在输入框，不处理
      const activeElement = document.activeElement
      if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
        return
      }
      
      // Ctrl+C 复制
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault()
        handleCopyNodes()
        return
      }
      
      // Ctrl+V 粘贴
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault()
        handlePasteNodes()
        return
      }
      
      // Ctrl+E 导出选中节点
      if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
        e.preventDefault()
        handleExportSelectedNodes()
        return
      }
      
      // Delete 删除选中节点
      if (e.key === 'Delete') {
        // 检查是否有模态框打开（如标注编辑器）
        const hasModal = document.querySelector('.annotation-editor-overlay')
        if (hasModal) return  // 如果有模态框，不处理
        
        const selectedNodes = nodes.filter(n => n.selected)
        if (selectedNodes.length > 0) {
          const selectedIds = new Set(selectedNodes.map(n => n.id))
          setNodes(nds => nds.filter(n => !selectedIds.has(n.id)))
          setEdges(eds => eds.filter(e => !selectedIds.has(e.source) && !selectedIds.has(e.target)))
          addLog(`✓ 已删除 ${selectedNodes.length} 个节点`, 'success')
        }
        return
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleCopyNodes, handlePasteNodes, handleExportSelectedNodes, nodes, addLog])

  // 导入项目（合并到当前项目）
  const handleImportProject = useCallback(async () => {
    try {
      const fileInput = document.createElement('input')
      fileInput.type = 'file'
      fileInput.accept = '.json'
      fileInput.onchange = async (e) => {
        const file = e.target.files?.[0]
        if (!file) return

        try {
          const content = await file.text()
          const project = JSON.parse(content)

          if (!project.id || !project.nodes) {
            throw new Error('项目文件格式错误')
          }

          if (nodes.length > 0) {
            const merge = window.confirm('当前画布不为空。\n点击"确定"替换当前项目\n点击"取消"合并到当前项目')
            if (merge === false) {
              const newNodes = project.nodes.map(node => {
                const newId = `node_${nodeIdCounter.current++}`
                return {
                  ...hydrateLoadedNode(node),
                  id: newId,
                  position: { x: node.position.x + 300, y: node.position.y + 100 }
                }
               })
               setNodes(prev => [...prev, ...newNodes])
               setCanvasKey(key => key + 1)
               addLog(`✓ 已合并 ${newNodes.length} 个节点`, 'success')
              return
            }
          }

          // 兼容旧数据
          const nodesWithHandle = project.nodes.map(hydrateLoadedNode)
          setNodes(nodesWithHandle)
          setCanvasKey(key => key + 1)
          setEdges(project.edges || [])
          setCurrentProjectId(project.id)
          setCurrentProjectName(project.name)

          const maxId = Math.max(0, ...project.nodes.map(n => {
            const match = n.id.match(/node_(\d+)/)
            return match ? parseInt(match[1]) : 0
          }))
          nodeIdCounter.current = maxId + 1

          addLog(`✓ 已导入项目"${project.name}"`, 'success')
        } catch (err) {
          addLog(`✗ 导入失败: ${err.message}`, 'error')
        }

        fileInput.value = ''
      }
      fileInput.click()
    } catch (error) {
      addLog(`✗ 导入失败: ${error.message}`, 'error')
    }
  }, [nodes, addLog, hydrateLoadedNode])

  // 加载项目
  const handleLoadProject = useCallback((project) => {
    // 兼容旧数据
    const nodesWithHandle = project.nodes.map(hydrateLoadedNode)
    setNodes(nodesWithHandle)
    setCanvasKey(key => key + 1)
    setEdges(project.edges)
    setCurrentProjectId(project.id)
    setCurrentProjectName(project.name)

    // 更新节点计数器
    const maxId = Math.max(
      ...project.nodes.map(n => {
        const match = n.id.match(/node_(\d+)/)
        return match ? parseInt(match[1]) : 0
      }),
      0
    )
    nodeIdCounter.current = maxId + 1

    addLog(`✓ 已加载项目"${project.name}"`, 'success')
  }, [addLog, hydrateLoadedNode])

  // 节点右键菜单
  const onNodeContextMenu = useCallback((event, node) => {
    event.preventDefault()
    setContextMenu({
      type: 'node',
      nodeId: node.id,
      x: event.clientX,
      y: event.clientY
    })
  }, [])

  // 连线右键菜单
  const onEdgeContextMenu = useCallback((event, edge) => {
    event.preventDefault()
    setContextMenu({
      type: 'edge',
      edgeId: edge.id,
      x: event.clientX,
      y: event.clientY
    })
  }, [])

  // 复制节点
  const handleCopyNode = useCallback(() => {
    if (!contextMenu) return

    const nodeToCopy = nodes.find(n => n.id === contextMenu.nodeId)
    if (!nodeToCopy) return

    const newNodeId = `node_${nodeIdCounter.current++}`

    // 创建新节点
    const newNode = {
      ...nodeToCopy,
      id: newNodeId,
      position: {
        x: nodeToCopy.position.x + 40,
        y: nodeToCopy.position.y + 40
      },
      selected: true, // 只选中新节点
      data: {
        ...nodeToCopy.data
      }
    }

    // 更新节点列表：取消选中所有旧节点，并添加新节点
    setNodes((nds) => nds.map(n => ({ ...n, selected: false })).concat(newNode))

    setContextMenu(null)
    addLog('✓ 节点已复制', 'success')
  }, [contextMenu, nodes, addLog])

  // 删除节点
  const handleDeleteNode = useCallback(() => {
    if (!contextMenu) return

    setNodes((nds) => nds.filter(n => n.id !== contextMenu.nodeId))
    setEdges((eds) => eds.filter(e => e.source !== contextMenu.nodeId && e.target !== contextMenu.nodeId))
    setContextMenu(null)
    addLog('✓ 节点已删除', 'success')
  }, [contextMenu, addLog])

  // 删除连线
  const handleDeleteEdge = useCallback(() => {
    if (!contextMenu || !contextMenu.edgeId) return

    setEdges((eds) => eds.filter(e => e.id !== contextMenu.edgeId))
    setContextMenu(null)
    addLog('✓ 连线已删除', 'success')
  }, [contextMenu, addLog])

  // 关闭右键菜单
  useEffect(() => {
    const handleClick = () => setContextMenu(null)
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [])

  useEffect(() => {
    const container = canvasRef.current
    if (!container) return

    const stopMiddlePan = () => {
      if (!middlePanRef.current) return
      middlePanRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    const handleMouseDown = (event) => {
      if (event.button !== 1) return
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.react-flow')) return
      event.preventDefault()
      middlePanRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        viewport: getViewport(),
      }
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'
    }

    const handleMouseMove = (event) => {
      const state = middlePanRef.current
      if (!state) return
      event.preventDefault()
      const deltaX = event.clientX - state.startX
      const deltaY = event.clientY - state.startY
      setViewport({
        x: state.viewport.x + deltaX,
        y: state.viewport.y + deltaY,
        zoom: state.viewport.zoom,
      })
    }

    const handleAuxClick = (event) => {
      if (event.button !== 1) return
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.react-flow')) return
      event.preventDefault()
    }

    container.addEventListener('mousedown', handleMouseDown, true)
    container.addEventListener('auxclick', handleAuxClick, true)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', stopMiddlePan)
    window.addEventListener('blur', stopMiddlePan)

    return () => {
      stopMiddlePan()
      container.removeEventListener('mousedown', handleMouseDown, true)
      container.removeEventListener('auxclick', handleAuxClick, true)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', stopMiddlePan)
      window.removeEventListener('blur', stopMiddlePan)
    }
  }, [getViewport, setViewport])

  return (
    <NodesProvider nodes={nodes} edges={edges}>
      <div className="canvas-container" ref={canvasRef}>
      {/* 工具栏 */}
      <Toolbar
        onNewProject={handleNewProject}
        onOpenProject={handleOpenProject}
        onSaveProject={handleSaveProject}
        onSaveProjectAs={handleSaveProjectAs}
        onImportProject={handleImportProject}
        onShowConfig={() => setConfigOpen(true)}
        onOpenSettings={onOpenSettings}
        onOpenAgentManager={onOpenAgentManager}
        onOpenTemplateManager={onOpenTemplateManager}
        projectName={currentProjectName}
      />

      {/* 拖拽提示 */}
      <div className="drop-hint">
        📁 拖拽图片 | 右键空白→新建节点 | 🔗 蓝点(右)→绿点(左) 连接多图
      </div>

      {/* 画布 */}
      <ReactFlow
        key={canvasKey}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChangeWithCallbackRestore}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onContextMenu={onContextMenu}
        nodeTypes={nodeTypes}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        fitView
        minZoom={0.05}
        maxZoom={10}
        defaultViewport={{ x: 0, y: 0, zoom: 0.5 }}
        selectionOnDrag
        selectionMode="partial"
        selectNodesOnDrag={false}
        panOnDrag={false}
        selectionKeyCode={null}
      >
        <Background />
        <Controls />
        <MiniMap zoomable pannable />
      </ReactFlow>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 1000
          }}
        >
          {contextMenu.type === 'node' ? (
            <>
              <div className="context-menu-item" onClick={handleCopyNode}>
                📋 复制节点
              </div>
              <div className="context-menu-item" onClick={handleDeleteNode}>
                🗑️ 删除节点
              </div>
            </>
          ) : contextMenu.type === 'edge' ? (
            <>
              <div className="context-menu-item" onClick={handleDeleteEdge}>
                ✂️ 删除连线
              </div>
            </>
          ) : (
            <>
              <div className="connect-menu-title">创建节点</div>
              <div className="context-menu-item" onClick={() => handleCreateNodeFromCanvas('image')}>
                🎨 图片生成
              </div>
              <div className="context-menu-item" onClick={() => handleCreateNodeFromCanvas('chat')}>
                💬 AI对话
              </div>
              <div className="context-menu-item" onClick={() => handleCreateNodeFromCanvas('video')}>
                🎬 视频生成
              </div>
              <div className="context-menu-divider"></div>
              <div className="context-menu-item" onClick={handleClearCanvasFromMenu}>
                🗑️ 清空画布
              </div>
            </>
          )}
        </div>
      )}

      {/* 拖线创建节点菜单 */}
      {connectMenu && (
        <div
          className="connect-menu"
          style={{
            position: 'fixed',
            top: connectMenu.y,
            left: connectMenu.x,
            zIndex: 1001
          }}
        >
          <div className="connect-menu-title">创建节点</div>
          <div className="connect-menu-item" onClick={() => handleCreateNodeFromConnect('image')}>
            🎨 图片生成
          </div>
          <div className="connect-menu-item" onClick={() => handleCreateNodeFromConnect('chat')}>
            💬 AI对话
          </div>
          <div className="connect-menu-item" onClick={() => handleCreateNodeFromConnect('video')}>
            🎬 视频生成
          </div>
          <div className="connect-menu-divider"></div>
          <div className="connect-menu-item cancel" onClick={() => setConnectMenu(null)}>
            ✕ 取消
          </div>
        </div>
      )}

      {/* 日志面板 */}
      <LogPanel
        logs={logs}
        isVisible={logPanelVisible}
        onToggle={() => setLogPanelVisible(!logPanelVisible)}
      />

      {/* 项目管理器 */}
      <ProjectManager
        isOpen={projectManagerOpen}
        onClose={() => setProjectManagerOpen(false)}
        onLoadProject={handleLoadProject}
        onNewProject={handleNewProject}
      />

      {/* 项目设置 */}
      <ProjectConfig
        isOpen={configOpen}
        onClose={() => setConfigOpen(false)}
        apiConfig={apiConfig}
        currentProjectName={currentProjectName}
        onSave={() => {}}
      />
    </div>
    </NodesProvider>
  )
}

export default Canvas
