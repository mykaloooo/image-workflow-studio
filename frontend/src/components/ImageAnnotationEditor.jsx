import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import * as fabric from 'fabric'

// 默认快捷提示词
const DEFAULT_QUICK_PROMPTS = [
  { id: 1, label: '根据标注修改', text: '根据标注修改图片，修改完成后删除标注' },
  { id: 2, label: '保持风格', text: '保持原图风格' },
  { id: 3, label: '提高画质', text: '提高画质和清晰度' },
  { id: 4, label: '扩展边界', text: '扩展图片边界' },
  { id: 5, label: '移除背景', text: '移除图片背景，保留主体' },
]

// 从 localStorage 加载快捷提示词
const loadQuickPrompts = () => {
  try {
    const saved = localStorage.getItem('annotation_quick_prompts')
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (e) {
    console.error('加载快捷提示词失败:', e)
  }
  return DEFAULT_QUICK_PROMPTS
}

// 保存快捷提示词到 localStorage
const saveQuickPrompts = (prompts) => {
  try {
    localStorage.setItem('annotation_quick_prompts', JSON.stringify(prompts))
  } catch (e) {
    console.error('保存快捷提示词失败:', e)
  }
}

// 从 localStorage 加载浮动面板位置
const loadPanelPosition = () => {
  try {
    const saved = localStorage.getItem('annotation_panel_position')
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (e) {
    console.error('加载面板位置失败:', e)
  }
  return { x: 50, y: window.innerHeight - 200 }
}

// 保存浮动面板位置到 localStorage
const savePanelPosition = (position) => {
  try {
    localStorage.setItem('annotation_panel_position', JSON.stringify(position))
  } catch (e) {
    console.error('保存面板位置失败:', e)
  }
}

function ImageAnnotationEditor({ 
  imageUrl, 
  onSave, 
  onCancel, 
  initialPrompt = '', 
  initialAnnotationData = null,
  // 新增：节点信息
  nodeInfo = null,  // { prompt, aspectRatio, resolution, model, referenceImages, createdAt }
  // 新增：画布上所有图片节点（用于从画布选择参考图）
  canvasImages = []  // [{ id, imageUrl, thumbnail, prompt }]
}) {
  const canvasRef = useRef(null)
  const fabricCanvasRef = useRef(null)
  const containerRef = useRef(null)
  const [currentTool, setCurrentTool] = useState('select')
  const [drawingColor, setDrawingColor] = useState('#FF0000')
  const [brushWidth, setBrushWidth] = useState(3)
  const [fontSize, setFontSize] = useState(24)
  const [markerSize, setMarkerSize] = useState(24)  // 标记点大小
  const [isReady, setIsReady] = useState(false)
  const [generateCount, setGenerateCount] = useState(1)  // 生成数量
  
  // 浮动面板拖拽状态
  const [panelPosition, setPanelPosition] = useState(loadPanelPosition)
  const [isDraggingPanel, setIsDraggingPanel] = useState(false)
  const panelDragOffset = useRef({ x: 0, y: 0 })
  
  // 浮动面板最小化状态
  const [isPanelMinimized, setIsPanelMinimized] = useState(false)
  
  // ESC 退出确认弹窗
  const [showExitConfirm, setShowExitConfirm] = useState(false)
  
  // 当前正在编辑的新参考图索引（用于替换保存）
  const [editingSavedRefIndex, setEditingSavedRefIndex] = useState(null)
  
  // 当前编辑的图片（可以切换为参考图）
  const [currentImageUrl, setCurrentImageUrl] = useState(imageUrl)
  // 原始参考图列表（只读，来自生成记录）
  const [originalReferenceImages] = useState(() => {
    const refs = nodeInfo?.referenceImages || []
    console.log('初始化原始参考图:', refs, 'nodeInfo:', nodeInfo)
    return refs
  })
  // 编辑图片列表（原图 + 添加的参考图，用于编辑切换）
  const [editingImages, setEditingImages] = useState([])
  // 已保存的新参考图列表（带标注，用于生成时引用）
  // 格式: [{ id: 1, url: dataUrl, sourceUrl: originalUrl, name: '图1' }, ...]
  const [savedReferenceImages, setSavedReferenceImages] = useState([])
  // 新参考图序号计数器
  const savedRefCounterRef = useRef(1)
  // 添加参考图菜单
  const [showAddRefMenu, setShowAddRefMenu] = useState(false)
  // 从画布选择图片弹窗
  const [showCanvasImagePicker, setShowCanvasImagePicker] = useState(false)
  // 文件输入 ref
  const fileInputRef = useRef(null)
  
  // 保存每张图片的标注数据 { [imageUrl]: { canvasJson, annotatedDataUrl } }
  const imageAnnotationsRef = useRef({})
  
  // 数字序号计数器
  const markerCounterRef = useRef(1)
  
  // 多边形绘制状态
  const polygonPointsRef = useRef([])
  const polygonLinesRef = useRef([])
  const polygonStartCircleRef = useRef(null)
  
  // 历史记录
  const historyRef = useRef([])
  const historyIndexRef = useRef(-1)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  // 快捷提示词
  const [quickPrompts, setQuickPrompts] = useState(loadQuickPrompts)
  const [showPromptDropdown, setShowPromptDropdown] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState(null)
  const [editLabel, setEditLabel] = useState('')
  const [editText, setEditText] = useState('')

  // 生成参数
  const [prompt, setPrompt] = useState(initialPrompt)
  const [params, setParams] = useState({
    model: 'gemini-3-pro',
    aspectRatio: '1:1',
    resolution: '2K'
  })
  
  // 缩放状态
  const [zoomLevel, setZoomLevel] = useState(100)
  
  // 平移状态 ref
  const panStateRef = useRef({ isPanning: false, lastX: 0, lastY: 0 })

  // 复制原提示词到编辑区
  const handleCopyPromptToEdit = () => {
    if (nodeInfo?.prompt) {
      setPrompt(nodeInfo.prompt)
    }
  }

  // 保存当前图片的标注数据
  const saveCurrentImageAnnotations = () => {
    const canvas = fabricCanvasRef.current
    if (!canvas || !currentImageUrl) return
    
    // 检查是否有标注（除了背景图片外还有其他对象）
    const objects = canvas.getObjects()
    const hasAnnotations = objects.length > 1 // 第一个是背景图片
    
    if (hasAnnotations) {
      // 保存画布 JSON
      const canvasJson = canvas.toJSON()
      // 导出带标注的图片
      const annotatedDataUrl = canvas.toDataURL({
        format: 'png',
        quality: 1,
        multiplier: 1
      })
      
      imageAnnotationsRef.current[currentImageUrl] = {
        canvasJson,
        annotatedDataUrl,
        hasAnnotations: true
      }
      console.log('保存图片标注:', currentImageUrl, '有标注:', hasAnnotations)
    } else {
      // 没有标注，清除之前的记录
      if (imageAnnotationsRef.current[currentImageUrl]) {
        delete imageAnnotationsRef.current[currentImageUrl]
      }
    }
  }

  // 切换到编辑参考图（可以是原始参考图或新添加的参考图）
  const handleEditReferenceImage = (refImg) => {
    const url = refImg.url || refImg
    if (url && url !== currentImageUrl) {
      // 先保存当前图片的标注
      saveCurrentImageAnnotations()
      setCurrentImageUrl(url)
    }
  }

  // 切换回原图
  const handleSwitchToMainImage = () => {
    if (currentImageUrl !== imageUrl) {
      // 先保存当前图片的标注
      saveCurrentImageAnnotations()
      setCurrentImageUrl(imageUrl)
    }
  }

  // 删除编辑图片
  const handleDeleteEditingImage = (index) => {
    const deletedImg = editingImages[index]
    const deletedUrl = deletedImg?.url || deletedImg
    
    // 删除该图片的标注数据
    if (imageAnnotationsRef.current[deletedUrl]) {
      delete imageAnnotationsRef.current[deletedUrl]
    }
    
    setEditingImages(prev => prev.filter((_, i) => i !== index))
    // 如果删除的是当前编辑的图片，切换回主图
    if (currentImageUrl === deletedUrl) {
      setCurrentImageUrl(imageUrl)
    }
  }

  // 将原参考图迁移到编辑列表
  const handleMoveOriginalToEditing = (img) => {
    const url = img.url || img
    // 检查是否已添加
    const exists = editingImages.some(ref => (ref.url || ref) === url)
    if (!exists) {
      setEditingImages(prev => [...prev, { url, name: '原参考图' }])
    }
  }

  // 切换回主图（已废弃，使用 handleSwitchToMainImage）
  const handleBackToMainImage = () => {
    handleSwitchToMainImage()
  }

  // 浮动面板拖拽开始
  const handlePanelDragStart = (e) => {
    setIsDraggingPanel(true)
    panelDragOffset.current = {
      x: e.clientX - panelPosition.x,
      y: e.clientY - panelPosition.y
    }
    e.preventDefault()
  }

  // 浮动面板拖拽移动
  const handlePanelDragMove = useCallback((e) => {
    if (isDraggingPanel) {
      const newX = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - panelDragOffset.current.x))
      const newY = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - panelDragOffset.current.y))
      setPanelPosition({ x: newX, y: newY })
    }
  }, [isDraggingPanel])

  // 浮动面板拖拽结束
  const handlePanelDragEnd = useCallback(() => {
    if (isDraggingPanel) {
      setIsDraggingPanel(false)
      savePanelPosition(panelPosition)
    }
  }, [isDraggingPanel, panelPosition])

  // 监听浮动面板拖拽
  useEffect(() => {
    if (isDraggingPanel) {
      document.addEventListener('mousemove', handlePanelDragMove)
      document.addEventListener('mouseup', handlePanelDragEnd)
      return () => {
        document.removeEventListener('mousemove', handlePanelDragMove)
        document.removeEventListener('mouseup', handlePanelDragEnd)
      }
    }
  }, [isDraggingPanel, handlePanelDragMove, handlePanelDragEnd])

  // ESC 键处理
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        // 检查是否有未保存的修改
        const hasChanges = savedReferenceImages.length > 0 || prompt.trim() !== ''
        if (hasChanges) {
          setShowExitConfirm(true)
        } else {
          onCancel()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [savedReferenceImages, prompt, onCancel])

  // 确认退出
  const handleConfirmExit = () => {
    setShowExitConfirm(false)
    onCancel()
  }

  // 保存并退出
  const handleSaveAndExit = () => {
    setShowExitConfirm(false)
    // 触发生成
    handleGenerate()
  }

  // 保存当前编辑为新参考图（或替换已有的）
  const handleSaveAsReference = () => {
    const canvas = fabricCanvasRef.current
    if (!canvas) return
    
    // 检查是否有标注（仅提示，不阻止保存）
    const objects = canvas.getObjects()
    const hasAnnotations = objects.length > 1
    
    if (!hasAnnotations) {
      console.log('当前图片没有标注，直接保存原图到新参考图')
    }
    
    // 导出图片（带或不带标注）
    const annotatedDataUrl = canvas.toDataURL({
      format: 'png',
      quality: 1,
      multiplier: 1
    })
    
    // 如果正在编辑已保存的参考图，则替换
    if (editingSavedRefIndex !== null) {
      setSavedReferenceImages(prev => prev.map((ref, i) => 
        i === editingSavedRefIndex 
          ? { ...ref, url: annotatedDataUrl, sourceUrl: currentImageUrl }
          : ref
      ))
      setEditingSavedRefIndex(null)
      console.log('替换新参考图:', savedReferenceImages[editingSavedRefIndex]?.name)
    } else {
      // 生成新序号
      const refId = savedRefCounterRef.current++
      const newRef = {
        id: refId,
        url: annotatedDataUrl,
        sourceUrl: currentImageUrl,
        name: `图${refId}`
      }
      
      setSavedReferenceImages(prev => [...prev, newRef])
      console.log('保存新参考图:', newRef.name)
    }
  }

  // 点击新参考图进行编辑
  const handleEditSavedReference = (ref, index) => {
    // 保存当前图片的标注
    saveCurrentImageAnnotations()
    // 切换到该参考图的源图进行编辑
    setCurrentImageUrl(ref.sourceUrl || ref.url)
    setEditingSavedRefIndex(index)
  }

  // 删除已保存的新参考图
  const handleDeleteSavedReference = (index) => {
    setSavedReferenceImages(prev => prev.filter((_, i) => i !== index))
  }

  // 添加参考图 - 从本地文件
  const handleAddFromFile = () => {
    setShowAddRefMenu(false)
    fileInputRef.current?.click()
  }

  // 处理文件选择 - 直接添加到新参考图
  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (event) => {
        // 直接添加到新参考图列表
        const refId = savedRefCounterRef.current++
        const newRef = {
          id: refId,
          url: event.target.result,
          sourceUrl: event.target.result,
          name: `图${refId}`
        }
        setSavedReferenceImages(prev => [...prev, newRef])
        console.log('从文件添加新参考图:', newRef.name)
      }
      reader.readAsDataURL(file)
    }
    // 清空 input 以便重复选择同一文件
    e.target.value = ''
  }

  // 添加参考图 - 从画布选择
  const handleAddFromCanvas = () => {
    setShowAddRefMenu(false)
    setShowCanvasImagePicker(true)
  }

  // 选择画布中的图片 - 直接添加到新参考图
  const handleSelectCanvasImage = (img) => {
    const url = img.imageUrl || img.thumbnail
    if (url) {
      // 检查是否已添加到新参考图
      const exists = savedReferenceImages.some(ref => ref.url === url || ref.sourceUrl === url)
      if (!exists) {
        const refId = savedRefCounterRef.current++
        const newRef = {
          id: refId,
          url: url,
          sourceUrl: url,
          name: `图${refId}`
        }
        setSavedReferenceImages(prev => [...prev, newRef])
        console.log('从画布添加新参考图:', newRef.name)
      }
    }
    setShowCanvasImagePicker(false)
  }

  // 处理粘贴事件 - 直接添加到新参考图
  const handlePaste = (e) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile()
        if (file) {
          const reader = new FileReader()
          reader.onload = (event) => {
            const refId = savedRefCounterRef.current++
            const newRef = {
              id: refId,
              url: event.target.result,
              sourceUrl: event.target.result,
              name: `图${refId}`
            }
            setSavedReferenceImages(prev => [...prev, newRef])
            console.log('从粘贴添加新参考图:', newRef.name)
          }
          reader.readAsDataURL(file)
        }
        break
      }
    }
  }

  // 监听粘贴事件
  useEffect(() => {
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [])

  // 初始化 Canvas 和加载图片
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return

    const container = containerRef.current
    const containerWidth = container.clientWidth
    const containerHeight = container.clientHeight

    console.log('容器尺寸:', containerWidth, 'x', containerHeight)

    // 创建 Fabric Canvas - 启用缩放和平移
    const canvas = new fabric.Canvas(canvasRef.current, {
      width: containerWidth,
      height: containerHeight,
      backgroundColor: '#2a2a2a',
      selection: true
    })

    fabricCanvasRef.current = canvas
    
    // 添加鼠标滚轮缩放
    canvas.on('mouse:wheel', (opt) => {
      const delta = opt.e.deltaY
      let zoom = canvas.getZoom()
      zoom *= 0.999 ** delta
      
      // 限制缩放范围 10% - 1000%
      if (zoom > 10) zoom = 10
      if (zoom < 0.1) zoom = 0.1
      
      // 以鼠标位置为中心缩放
      canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom)
      
      // 更新缩放显示
      setZoomLevel(Math.round(zoom * 100))
      
      opt.e.preventDefault()
      opt.e.stopPropagation()
    })
    
    // 使用原生事件实现中键平移
    const canvasEl = canvas.upperCanvasEl
    
    const handleMouseDown = (e) => {
      // 中键 button === 1
      if (e.button === 1) {
        e.preventDefault()
        e.stopPropagation()
        panStateRef.current = {
          isPanning: true,
          lastX: e.clientX,
          lastY: e.clientY
        }
        canvasEl.style.cursor = 'grabbing'
      }
    }
    
    const handleMouseMove = (e) => {
      if (panStateRef.current.isPanning) {
        const vpt = canvas.viewportTransform
        vpt[4] += e.clientX - panStateRef.current.lastX
        vpt[5] += e.clientY - panStateRef.current.lastY
        panStateRef.current.lastX = e.clientX
        panStateRef.current.lastY = e.clientY
        canvas.requestRenderAll()
      }
    }
    
    const handleMouseUp = (e) => {
      if (panStateRef.current.isPanning) {
        panStateRef.current.isPanning = false
        canvasEl.style.cursor = 'default'
      }
    }
    
    // 阻止中键默认行为
    const preventDefault = (e) => {
      if (e.button === 1) {
        e.preventDefault()
      }
    }
    
    canvasEl.addEventListener('mousedown', handleMouseDown)
    canvasEl.addEventListener('auxclick', preventDefault)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    // 加载图片
    const fullImageUrl = currentImageUrl.startsWith('http')
      ? currentImageUrl
      : `${window.location.origin}${currentImageUrl}`

    console.log('加载图片:', fullImageUrl)

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      console.log('图片原始尺寸:', img.width, 'x', img.height)

      const fabricImg = new fabric.Image(img, {
        selectable: false,
        evented: false,
        originX: 'center',
        originY: 'center'
      })

      // 计算缩放以适应容器
      const padding = 40
      const scaleX = (containerWidth - padding * 2) / img.width
      const scaleY = (containerHeight - padding * 2) / img.height
      const scale = Math.min(scaleX, scaleY, 1)

      console.log('缩放比例:', scale)

      fabricImg.scale(scale)
      fabricImg.set({
        left: containerWidth / 2,
        top: containerHeight / 2
      })

      canvas.add(fabricImg)
      canvas.renderAll()

      console.log('图片已添加，位置:', fabricImg.left, fabricImg.top)
      
      // 优先从 imageAnnotationsRef 加载已保存的标注（切换图片时）
      // 否则从 initialAnnotationData 加载（首次打开时）
      const savedAnnotation = imageAnnotationsRef.current[currentImageUrl]
      const annotationToLoad = savedAnnotation?.canvasJson || initialAnnotationData
      
      // 如果有已保存的标注数据，加载它
      if (annotationToLoad && annotationToLoad.objects && annotationToLoad.objects.length > 1) {
        console.log('加载标注数据:', savedAnnotation ? '从缓存' : '从初始数据', annotationToLoad)
        // 跳过第一个对象（背景图片），只加载标注
        const annotationObjects = annotationToLoad.objects.slice(1)
        
        // 使用 fabric.util.enlivenObjects 来恢复对象
        fabric.util.enlivenObjects(annotationObjects).then((objects) => {
          objects.forEach(obj => {
            canvas.add(obj)
          })
          canvas.renderAll()
          console.log('标注数据加载完成，共', objects.length, '个对象')
          
          // 恢复标记计数器
          if (initialAnnotationData.markerCounter) {
            markerCounterRef.current = initialAnnotationData.markerCounter
          }
          
          // 保存初始状态
          saveHistory()
          setIsReady(true)
        }).catch(err => {
          console.error('加载标注数据失败:', err)
          saveHistory()
          setIsReady(true)
        })
      } else {
        // 保存初始状态
        saveHistory()
        setIsReady(true)
      }
    }

    img.onerror = (e) => {
      console.error('图片加载失败:', e)
      alert('图片加载失败')
    }

    img.src = fullImageUrl
    
    // 清理函数
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      canvas.dispose()
    }
  }, [currentImageUrl])

  // 保存历史记录
  const saveHistory = () => {
    const canvas = fabricCanvasRef.current
    if (!canvas) return
    
    // 保存时包含背景图片的完整状态
    const json = canvas.toJSON(['selectable', 'evented'])
    // 删除当前位置之后的历史
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1)
    historyRef.current.push(JSON.stringify(json))
    historyIndexRef.current = historyRef.current.length - 1
    
    console.log('[History] 保存历史，当前索引:', historyIndexRef.current, '总数:', historyRef.current.length)
    updateUndoRedoState()
  }

  // 更新撤销/重做按钮状态
  const updateUndoRedoState = () => {
    setCanUndo(historyIndexRef.current > 0)
    setCanRedo(historyIndexRef.current < historyRef.current.length - 1)
  }

  // 撤销
  const undo = () => {
    console.log('[Undo] 当前索引:', historyIndexRef.current)
    if (historyIndexRef.current <= 0) return
    historyIndexRef.current--
    loadHistory(historyRef.current[historyIndexRef.current])
  }

  // 重做
  const redo = () => {
    console.log('[Redo] 当前索引:', historyIndexRef.current)
    if (historyIndexRef.current >= historyRef.current.length - 1) return
    historyIndexRef.current++
    loadHistory(historyRef.current[historyIndexRef.current])
  }

  // 加载历史记录
  const loadHistory = (jsonStr) => {
    const canvas = fabricCanvasRef.current
    if (!canvas) return
    
    const jsonData = JSON.parse(jsonStr)
    console.log('[History] 加载历史，对象数量:', jsonData.objects?.length)
    
    // 使用 enlivenObjects 来正确恢复对象
    fabric.util.enlivenObjects(jsonData.objects || []).then((objects) => {
      canvas.clear()
      canvas.backgroundColor = jsonData.background || '#2a2a2a'
      
      objects.forEach((obj) => {
        // 确保背景图片不可选
        if (obj.type === 'image') {
          obj.selectable = false
          obj.evented = false
        }
        canvas.add(obj)
      })
      
      canvas.renderAll()
      updateUndoRedoState()
      console.log('[History] 加载完成，画布对象数:', canvas.getObjects().length)
    }).catch(err => {
      console.error('[History] 加载失败:', err)
    })
  }

  // 工具切换
  useEffect(() => {
    const canvas = fabricCanvasRef.current
    if (!canvas || !isReady) return

    console.log('切换工具:', currentTool)

    // 移除所有事件
    canvas.off('mouse:down')
    canvas.off('mouse:move')
    canvas.off('mouse:up')
    canvas.isDrawingMode = false
    canvas.selection = false

    // 设置所有非图片对象为可选择
    canvas.forEachObject((obj) => {
      if (obj.type !== 'image') {
        obj.selectable = currentTool === 'select'
        obj.evented = currentTool === 'select'
      }
    })

    if (currentTool === 'select') {
      canvas.selection = true
    } else if (currentTool === 'pen') {
      canvas.isDrawingMode = true
      // Fabric.js 7.x 需要手动创建 PencilBrush
      if (!canvas.freeDrawingBrush) {
        canvas.freeDrawingBrush = new fabric.PencilBrush(canvas)
      }
      canvas.freeDrawingBrush.color = drawingColor
      canvas.freeDrawingBrush.width = brushWidth
      
      // 画笔绘制完成后保存历史
      canvas.on('mouse:up', () => {
        if (canvas.isDrawingMode) {
          saveHistory()
        }
      })
    } else if (currentTool === 'arrow') {
      setupArrowTool(canvas)
    } else if (currentTool === 'rectangle') {
      setupRectangleTool(canvas)
    } else if (currentTool === 'text') {
      setupTextTool(canvas)
    } else if (currentTool === 'marker') {
      setupMarkerTool(canvas)
    } else if (currentTool === 'region') {
      setupRegionTool(canvas)
    }
  }, [currentTool, drawingColor, brushWidth, fontSize, isReady])

  // 箭头工具
  const setupArrowTool = (canvas) => {
    let line = null
    let isDrawing = false

    canvas.on('mouse:down', (opt) => {
      if (opt.e.button === 1) return // 忽略中键
      isDrawing = true
      const pointer = canvas.getScenePoint(opt.e)
      line = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
        stroke: drawingColor,
        strokeWidth: brushWidth,
        selectable: true
      })
      canvas.add(line)
    })

    canvas.on('mouse:move', (opt) => {
      if (!isDrawing || !line) return
      const pointer = canvas.getScenePoint(opt.e)
      line.set({ x2: pointer.x, y2: pointer.y })
      canvas.renderAll()
    })

    canvas.on('mouse:up', () => {
      if (!isDrawing || !line) return
      isDrawing = false

      // 添加箭头头部
      const angle = Math.atan2(line.y2 - line.y1, line.x2 - line.x1)
      const headlen = 15
      const triangle = new fabric.Triangle({
        left: line.x2,
        top: line.y2,
        originX: 'center',
        originY: 'center',
        angle: (angle * 180 / Math.PI) + 90,
        width: headlen,
        height: headlen,
        fill: drawingColor,
        selectable: false
      })

      canvas.remove(line)
      const group = new fabric.Group([line, triangle], { selectable: true })
      canvas.add(group)
      canvas.renderAll()
      line = null
      saveHistory()
    })
  }

  // 矩形工具
  const setupRectangleTool = (canvas) => {
    let rect = null
    let isDrawing = false
    let startX = 0
    let startY = 0

    canvas.on('mouse:down', (opt) => {
      if (opt.e.button === 1) return // 忽略中键
      isDrawing = true
      const pointer = canvas.getScenePoint(opt.e)
      startX = pointer.x
      startY = pointer.y
      rect = new fabric.Rect({
        left: startX,
        top: startY,
        originX: 'left',
        originY: 'top',
        width: 0,
        height: 0,
        fill: 'transparent',
        stroke: drawingColor,
        strokeWidth: brushWidth,
        selectable: true
      })
      canvas.add(rect)
    })

    canvas.on('mouse:move', (opt) => {
      if (!isDrawing || !rect) return
      const pointer = canvas.getScenePoint(opt.e)

      if (pointer.x < startX) {
        rect.set({ left: pointer.x })
      } else {
        rect.set({ left: startX })
      }
      if (pointer.y < startY) {
        rect.set({ top: pointer.y })
      } else {
        rect.set({ top: startY })
      }

      rect.set({
        width: Math.abs(pointer.x - startX),
        height: Math.abs(pointer.y - startY)
      })
      canvas.renderAll()
    })

    canvas.on('mouse:up', () => {
      isDrawing = false
      if (rect) {
        rect.setCoords()
        saveHistory()
      }
      rect = null
    })
  }

  // 文字工具
  const setupTextTool = (canvas) => {
    const handleMouseDown = (opt) => {
      if (opt.e.button === 1) return // 忽略中键
      const pointer = canvas.getScenePoint(opt.e)
      const text = new fabric.IText('输入文字', {
        left: pointer.x,
        top: pointer.y,
        fontSize: fontSize,
        fill: drawingColor,
        fontFamily: 'Arial',
        selectable: true,
        evented: true
      })
      canvas.add(text)
      canvas.setActiveObject(text)
      text.enterEditing()
      text.selectAll()
      canvas.renderAll()
      saveHistory()

      // 添加后移除事件，切换到选择模式
      canvas.off('mouse:down', handleMouseDown)
      setCurrentTool('select')
    }

    canvas.on('mouse:down', handleMouseDown)
  }

  // 数字序号标记工具（水滴形，尖头朝下）
  const setupMarkerTool = (canvas) => {
    const handleMouseDown = (opt) => {
      if (opt.e.button === 1) return // 忽略中键
      const pointer = canvas.getScenePoint(opt.e)
      const markerNum = markerCounterRef.current++
      
      // 使用可调节的大小
      const size = markerSize
      const pinColor = drawingColor
      
      // 创建水滴形状路径（更胖的水滴，尖头朝下）
      // 调整控制点让水滴更圆润饱满
      const dropPath = new fabric.Path(
        `M 0 ${-size * 0.9}
         C ${size * 0.7} ${-size * 0.9} ${size * 0.7} ${-size * 0.1} 0 ${size * 0.35}
         C ${-size * 0.7} ${-size * 0.1} ${-size * 0.7} ${-size * 0.9} 0 ${-size * 0.9}
         Z`,
        {
          fill: pinColor,
          originX: 'center',
          originY: 'center',
          left: 0,
          top: 0
        }
      )
      
      // 创建数字文本（下移到水滴中心偏下位置，放大到70%）
      const text = new fabric.Text(String(markerNum), {
        fontSize: size * 0.7,
        fill: '#FFFFFF',
        fontFamily: 'Arial',
        fontWeight: 'bold',
        originX: 'center',
        originY: 'center',
        left: 0,
        top: -size * 0.32
      })
      
      // 组合成一个标记点
      const marker = new fabric.Group([dropPath, text], {
        left: pointer.x,
        top: pointer.y,
        originX: 'center',
        originY: 'bottom',
        selectable: true,
        markerNumber: markerNum  // 保存序号信息
      })
      
      canvas.add(marker)
      canvas.renderAll()
      saveHistory()
    }

    canvas.on('mouse:down', handleMouseDown)
  }

  // 多边形区域选择工具（点选形成异形区域）
  const setupRegionTool = (canvas) => {
    const handleMouseDown = (opt) => {
      if (opt.e.button === 1) return // 忽略中键
      const pointer = canvas.getScenePoint(opt.e)
      const points = polygonPointsRef.current
      
      // 检查是否点击了起始点（闭合多边形）
      if (points.length >= 3 && polygonStartCircleRef.current) {
        const startCircle = polygonStartCircleRef.current
        const dist = Math.sqrt(
          Math.pow(pointer.x - startCircle.left, 2) + 
          Math.pow(pointer.y - startCircle.top, 2)
        )
        
        // 如果点击在起始点附近，闭合多边形
        if (dist < 15) {
          finishPolygon(canvas)
          return
        }
      }
      
      // 添加新点
      points.push({ x: pointer.x, y: pointer.y })
      
      // 创建点的可视化圆点
      const circle = new fabric.Circle({
        radius: 5,
        fill: drawingColor,
        left: pointer.x,
        top: pointer.y,
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
        isPolygonPoint: true
      })
      canvas.add(circle)
      
      // 第一个点特殊标记（用于闭合检测）
      if (points.length === 1) {
        polygonStartCircleRef.current = circle
        circle.set({ 
          radius: 8, 
          stroke: '#FFFFFF', 
          strokeWidth: 2 
        })
      }
      
      // 如果有多个点，绘制连接线
      if (points.length > 1) {
        const prevPoint = points[points.length - 2]
        const line = new fabric.Line(
          [prevPoint.x, prevPoint.y, pointer.x, pointer.y],
          {
            stroke: drawingColor,
            strokeWidth: 2,
            strokeDashArray: [5, 5],
            selectable: false,
            evented: false,
            isPolygonLine: true
          }
        )
        canvas.add(line)
        polygonLinesRef.current.push(line)
      }
      
      canvas.renderAll()
    }
    
    canvas.on('mouse:down', handleMouseDown)
  }
  
  // 完成多边形绘制
  const finishPolygon = (canvas) => {
    const points = polygonPointsRef.current
    if (points.length < 3) return
    
    // 移除临时的点和线
    canvas.getObjects().forEach(obj => {
      if (obj.isPolygonPoint || obj.isPolygonLine) {
        canvas.remove(obj)
      }
    })
    
    // 创建多边形
    const polygon = new fabric.Polygon(points, {
      fill: 'rgba(255, 0, 0, 0.25)',
      stroke: drawingColor,
      strokeWidth: 2,
      strokeDashArray: [5, 5],
      selectable: true,
      isRegion: true
    })
    
    canvas.add(polygon)
    canvas.renderAll()
    saveHistory()
    
    // 重置状态
    polygonPointsRef.current = []
    polygonLinesRef.current = []
    polygonStartCircleRef.current = null
    
    // 切换回选择工具
    setCurrentTool('select')
  }
  
  // 取消多边形绘制
  const cancelPolygon = () => {
    const canvas = fabricCanvasRef.current
    if (!canvas) return
    
    // 移除临时的点和线
    canvas.getObjects().forEach(obj => {
      if (obj.isPolygonPoint || obj.isPolygonLine) {
        canvas.remove(obj)
      }
    })
    canvas.renderAll()
    
    // 重置状态
    polygonPointsRef.current = []
    polygonLinesRef.current = []
    polygonStartCircleRef.current = null
  }

  // 删除选中
  const deleteSelected = () => {
    const canvas = fabricCanvasRef.current
    if (!canvas) return
    const activeObjects = canvas.getActiveObjects()
    if (activeObjects.length) {
      activeObjects.forEach(obj => {
        if (obj.type !== 'image') {
          canvas.remove(obj)
        }
      })
      canvas.discardActiveObject()
      canvas.renderAll()
      saveHistory()
    }
  }

  // 清除所有标注
  const clearAllAnnotations = () => {
    const canvas = fabricCanvasRef.current
    if (!canvas) return
    
    // 获取所有非图片对象并删除
    const objectsToRemove = canvas.getObjects().filter(obj => obj.type !== 'image')
    if (objectsToRemove.length === 0) return
    
    objectsToRemove.forEach(obj => canvas.remove(obj))
    canvas.discardActiveObject()
    canvas.renderAll()
    saveHistory()
  }

  // 键盘事件 - Delete 键删除选中对象，Ctrl+Z 撤销，Ctrl+Y 重做，V 选择工具
  useEffect(() => {
    const handleKeyDown = (e) => {
      // 如果焦点在输入框或文本区域，不处理
      const activeElement = document.activeElement
      if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
        return
      }
      
      // Ctrl+Z 撤销
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault()
        e.stopPropagation()
        undo()
        return
      }
      
      // Ctrl+Y 重做
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault()
        e.stopPropagation()
        redo()
        return
      }
      
      // V 键切换到选择工具
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault()
        e.stopPropagation()
        setCurrentTool('select')
        return
      }
      
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 如果正在编辑文字，不处理删除
        const canvas = fabricCanvasRef.current
        if (!canvas) return
        const activeObject = canvas.getActiveObject()
        if (activeObject && activeObject.isEditing) return
        
        e.preventDefault()
        e.stopPropagation()  // 阻止事件冒泡到画布
        e.stopImmediatePropagation()  // 阻止其他监听器
        deleteSelected()
        return
      }
    }

    // 使用 capture 模式优先拦截事件
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [canUndo, canRedo])

  // 快捷提示词操作
  const handleSelectPrompt = (promptItem) => {
    setPrompt(prompt + (prompt ? '，' : '') + promptItem.text)
    setShowPromptDropdown(false)
  }

  const handleEditPrompt = (promptItem, e) => {
    e.stopPropagation()
    setEditingPrompt(promptItem)
    setEditLabel(promptItem.label)
    setEditText(promptItem.text)
  }

  const handleSaveEditPrompt = () => {
    if (!editLabel.trim() || !editText.trim()) {
      alert('标签和提示词不能为空')
      return
    }
    const newPrompts = quickPrompts.map(p => 
      p.id === editingPrompt.id ? { ...p, label: editLabel, text: editText } : p
    )
    setQuickPrompts(newPrompts)
    saveQuickPrompts(newPrompts)
    setEditingPrompt(null)
  }

  const handleDeletePrompt = (promptItem, e) => {
    e.stopPropagation()
    if (confirm(`确定删除 "${promptItem.label}" 吗？`)) {
      const newPrompts = quickPrompts.filter(p => p.id !== promptItem.id)
      setQuickPrompts(newPrompts)
      saveQuickPrompts(newPrompts)
    }
  }

  const handleAddPrompt = () => {
    const newId = Math.max(...quickPrompts.map(p => p.id), 0) + 1
    const newPrompt = { id: newId, label: '新提示词', text: '请输入提示词内容' }
    setEditingPrompt(newPrompt)
    setEditLabel(newPrompt.label)
    setEditText(newPrompt.text)
    const newPrompts = [...quickPrompts, newPrompt]
    setQuickPrompts(newPrompts)
    saveQuickPrompts(newPrompts)
  }

  // 生成新图片
  const handleGenerate = () => {
    const canvas = fabricCanvasRef.current
    if (!canvas) return
    if (!prompt.trim()) {
      alert('请输入提示词')
      return
    }

    // 先保存当前图片的标注
    saveCurrentImageAnnotations()

    console.log('生成图片，提示词:', prompt)
    const dataURL = canvas.toDataURL({ format: 'png', quality: 1 })
    console.log('图片数据长度:', dataURL.length)
    
    // 使用已保存的新参考图列表（带序号，从1开始）
    const referenceImagesForGenerate = savedReferenceImages.map((ref, index) => ({
      id: ref.id,
      url: ref.url,
      name: `图${index + 1}`,
      sourceUrl: ref.sourceUrl
    }))
    
    console.log('新参考图列表:', referenceImagesForGenerate)
    
    onSave({
      action: 'generate',
      annotatedImage: dataURL,
      prompt: prompt,
      params: {
        ...params,
        count: generateCount
      },
      referenceImages: generateCount > 1 ? [] : referenceImagesForGenerate
    })
  }

  // 重新生成 - 使用原来的提示词和参考图
  const handleRegenerate = () => {
    if (!nodeInfo?.prompt) {
      alert('没有原始提示词')
      return
    }

    console.log('重新生成，使用原提示词:', nodeInfo.prompt)
    
    // 使用原始参考图
    const referenceImagesForGenerate = (originalReferenceImages || []).map((ref, index) => ({
      id: ref.id || `orig-${index}`,
      url: ref.url || ref,
      name: `图${index + 1}`,
      sourceUrl: ref.sourceUrl || ref.url || ref
    }))
    
    console.log('原参考图列表:', referenceImagesForGenerate)
    
    onSave({
      action: 'generate',
      annotatedImage: null,  // 不使用当前画布，使用原图
      prompt: nodeInfo.prompt,
      params: {
        aspectRatio: nodeInfo.aspectRatio || '1:1',
        resolution: nodeInfo.resolution || '2K'
      },
      referenceImages: referenceImagesForGenerate,
      isRegenerate: true  // 标记为重新生成
    })
  }

  // 保存标注图为新节点（不生成，只保存）
  const handleSaveAsImage = () => {
    const canvas = fabricCanvasRef.current
    if (!canvas) return

    console.log('保存标注图为新节点')
    const dataURL = canvas.toDataURL({ format: 'png', quality: 1 })
    console.log('图片数据长度:', dataURL.length)
    
    // 导出画布 JSON 数据（用于后续编辑）
    const canvasJSON = canvas.toJSON()
    // 保存当前标记计数器
    canvasJSON.markerCounter = markerCounterRef.current
    console.log('画布 JSON 数据:', canvasJSON)
    
    onSave({
      action: 'saveAsImage',
      annotatedImage: dataURL,
      prompt: prompt,
      annotationData: canvasJSON  // 保存画布数据
    })
  }

  // 缩放控制
  const handleZoomIn = () => {
    const canvas = fabricCanvasRef.current
    if (!canvas) return
    let zoom = canvas.getZoom() * 1.2
    if (zoom > 10) zoom = 10
    canvas.setZoom(zoom)
    setZoomLevel(Math.round(zoom * 100))
  }

  const handleZoomOut = () => {
    const canvas = fabricCanvasRef.current
    if (!canvas) return
    let zoom = canvas.getZoom() / 1.2
    if (zoom < 0.1) zoom = 0.1
    canvas.setZoom(zoom)
    setZoomLevel(Math.round(zoom * 100))
  }

  const handleZoomReset = () => {
    const canvas = fabricCanvasRef.current
    if (!canvas) return
    canvas.setZoom(1)
    canvas.viewportTransform = [1, 0, 0, 1, 0, 0]
    canvas.requestRenderAll()
    setZoomLevel(100)
  }

  return createPortal(
    <div className="annotation-editor-fullscreen">
      {/* 工具栏 - 顶部固定 */}
      <div className="annotation-toolbar-fixed">
          <div className="toolbar-left">
            <button
              type="button"
              className={`tool-btn ${currentTool === 'select' ? 'active' : ''}`}
              onClick={() => setCurrentTool('select')}
              title="选择工具"
            >
              ↖️
            </button>
            <button
              type="button"
              className={`tool-btn ${currentTool === 'pen' ? 'active' : ''}`}
              onClick={() => setCurrentTool('pen')}
              title="画笔"
            >
              ✏️
            </button>
            <button
              type="button"
              className={`tool-btn ${currentTool === 'arrow' ? 'active' : ''}`}
              onClick={() => setCurrentTool('arrow')}
              title="箭头"
            >
              ↗️
            </button>
            <button
              type="button"
              className={`tool-btn ${currentTool === 'rectangle' ? 'active' : ''}`}
              onClick={() => setCurrentTool('rectangle')}
              title="矩形"
            >
              ▭
            </button>
            <button
              type="button"
              className={`tool-btn ${currentTool === 'text' ? 'active' : ''}`}
              onClick={() => setCurrentTool('text')}
              title="文字"
            >
              Tt
            </button>
            <button
              type="button"
              className={`tool-btn ${currentTool === 'marker' ? 'active' : ''}`}
              onClick={() => setCurrentTool('marker')}
              title="数字标记点（自动递增序号）"
            >
              📍
            </button>
            <button
              type="button"
              className={`tool-btn ${currentTool === 'region' ? 'active' : ''}`}
              onClick={() => {
                cancelPolygon()  // 切换工具时取消未完成的多边形
                setCurrentTool('region')
              }}
              title="多边形区域选择（点击多点形成区域，点击起始点闭合）"
            >
              ⬡
            </button>

            <div className="toolbar-divider"></div>

            <input
              type="color"
              value={drawingColor}
              onChange={(e) => setDrawingColor(e.target.value)}
              title="颜色"
              className="color-picker"
            />

            <label className="slider-label" title="线条粗细">
              <span>线宽</span>
              <input
                type="range"
                min="1"
                max="20"
                value={brushWidth}
                onChange={(e) => setBrushWidth(parseInt(e.target.value))}
                className="width-slider"
              />
            </label>

            <label className="slider-label" title="字体大小">
              <span>字号</span>
              <input
                type="range"
                min="12"
                max="72"
                value={fontSize}
                onChange={(e) => setFontSize(parseInt(e.target.value))}
                className="font-slider"
              />
            </label>

            <label className="slider-label" title="标记点大小">
              <span>标记</span>
              <input
                type="range"
                min="16"
                max="48"
                value={markerSize}
                onChange={(e) => setMarkerSize(parseInt(e.target.value))}
                className="marker-slider"
              />
            </label>
          </div>

          <div className="toolbar-center">
            <button
              type="button"
              className="tool-btn"
              onClick={undo}
              disabled={!canUndo}
              title="撤销 (Ctrl+Z)"
            >
              ↶
            </button>
            <button
              type="button"
              className="tool-btn"
              onClick={redo}
              disabled={!canRedo}
              title="重做 (Ctrl+Y)"
            >
              ↷
            </button>
            <button
              type="button"
              className="tool-btn"
              onClick={deleteSelected}
              title="删除选中"
            >
              🗑️
            </button>
            <button
              type="button"
              className="tool-btn save-ref-btn"
              onClick={handleSaveAsReference}
              title="保存当前编辑为新参考图"
            >
              💾
            </button>
            <button
              type="button"
              className="tool-btn"
              onClick={clearAllAnnotations}
              title="清除所有标注"
            >
              🧹
            </button>
            
            <div className="toolbar-divider"></div>
            
            {/* 缩放控制 */}
            <button
              type="button"
              className="tool-btn"
              onClick={handleZoomOut}
              title="缩小"
            >
              ➖
            </button>
            <span className="zoom-level" title="当前缩放比例（滚轮缩放，空格+拖拽平移）">{zoomLevel}%</span>
            <button
              type="button"
              className="tool-btn"
              onClick={handleZoomIn}
              title="放大"
            >
              ➕
            </button>
            <button
              type="button"
              className="tool-btn"
              onClick={handleZoomReset}
              title="重置视图"
            >
              🔄
            </button>
          </div>

          <div className="toolbar-right">
            {isPanelMinimized && (
              <button 
                type="button" 
                className="tool-btn panel-toggle-btn"
                onClick={() => setIsPanelMinimized(false)}
                title="显示参数面板"
              >
                ⚙️
              </button>
            )}
            {nodeInfo?.prompt && (
              <button 
                type="button" 
                className="tool-btn regenerate-toolbar-btn"
                onClick={handleRegenerate}
                title="使用原提示词和参考图重新生成"
              >
                🔄
              </button>
            )}
            <button 
              type="button" 
              className="tool-btn close-btn"
              onClick={() => {
                const hasChanges = savedReferenceImages.length > 0 || prompt.trim() !== ''
                if (hasChanges) {
                  setShowExitConfirm(true)
                } else {
                  onCancel()
                }
              }}
              title="关闭 (ESC)"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Canvas 画布 - 全屏 */}
        <div className="annotation-canvas-fullscreen" ref={containerRef}>
          <canvas ref={canvasRef} />
        </div>

        {/* 浮动操作面板 */}
        {!isPanelMinimized && (
          <div 
            className={`floating-panel ${isDraggingPanel ? 'dragging' : ''}`}
            style={{ left: panelPosition.x, top: panelPosition.y }}
          >
            <div className="floating-panel-header" onMouseDown={handlePanelDragStart}>
              <span className="panel-drag-hint">⋮⋮ 拖拽移动</span>
              <button 
                type="button" 
                className="panel-minimize-btn"
                onClick={(e) => { e.stopPropagation(); setIsPanelMinimized(true); }}
                title="最小化面板"
              >
                ─
              </button>
            </div>
            <div className="floating-panel-content">
            {/* 第一栏：提示词和参数 */}
            <div className="panel-column prompt-column">
              <div className="column-header">
                <span>提示词</span>
                <div className="header-actions">
                  <button 
                    type="button" 
                    className="header-btn"
                    onClick={(e) => { 
                      e.stopPropagation(); 
                      e.preventDefault();
                      console.log('点击快捷提示词按钮, 当前状态:', showPromptDropdown, '-> 切换为:', !showPromptDropdown);
                      setShowPromptDropdown(prev => !prev); 
                    }}
                    title="快捷提示词"
                  >
                    📝
                  </button>
                  <button 
                    type="button" 
                    className="header-btn"
                    onClick={(e) => { e.stopPropagation(); setPrompt(''); }}
                    title="清空"
                  >
                    🗑️
                  </button>
                </div>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="描述修改内容..."
                rows={2}
                onClick={(e) => e.stopPropagation()}
              />
              {showPromptDropdown && (
                <div 
                  style={{ 
                    position: 'fixed',
                    top: '200px',
                    left: '100px',
                    width: '220px',
                    background: '#2a2a2a',
                    border: '1px solid #4CAF50',
                    borderRadius: '8px',
                    padding: '4px 0',
                    zIndex: 999999,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.5)'
                  }}
                >
                  {quickPrompts.map(item => (
                    <div 
                      key={item.id} 
                      style={{ 
                        padding: '10px 14px', 
                        cursor: 'pointer', 
                        color: '#ddd', 
                        fontSize: '13px',
                        transition: 'background 0.2s'
                      }}
                      onMouseEnter={(e) => e.target.style.background = '#3a3a3a'}
                      onMouseLeave={(e) => e.target.style.background = 'transparent'}
                      onClick={() => { handleSelectPrompt(item); setShowPromptDropdown(false); }}
                    >
                      {item.label}
                    </div>
                  ))}
                  <div 
                    style={{ 
                      padding: '10px 14px', 
                      cursor: 'pointer', 
                      color: '#4CAF50',
                      fontSize: '13px',
                      borderTop: '1px solid #444'
                    }}
                    onMouseEnter={(e) => e.target.style.background = '#3a3a3a'}
                    onMouseLeave={(e) => e.target.style.background = 'transparent'}
                    onClick={handleAddPrompt}
                  >
                    ➕ 添加快捷提示词
                  </div>
                </div>
              )}
              <div className="param-row">
                <select value={params.aspectRatio} onChange={(e) => setParams({...params, aspectRatio: e.target.value})}>
                  <option value="1:1">1:1</option>
                  <option value="16:9">16:9</option>
                  <option value="9:16">9:16</option>
                  <option value="4:3">4:3</option>
                </select>
                <select value={params.resolution} onChange={(e) => setParams({...params, resolution: e.target.value})}>
                  <option value="1K">1K</option>
                  <option value="2K">2K</option>
                  <option value="4K">4K</option>
                </select>
                <select value={generateCount} onChange={(e) => setGenerateCount(parseInt(e.target.value))} title="生成数量">
                  <option value={1}>1张</option>
                  <option value={2}>2张</option>
                  <option value={3}>3张</option>
                  <option value={4}>4张</option>
                  <option value={5}>5张</option>
                  <option value={6}>6张</option>
                  <option value={7}>7张</option>
                  <option value={8}>8张</option>
                  <option value={9}>9张</option>
                  <option value={10}>10张</option>
                </select>
                {generateCount > 1 && referenceImages.length > 0 && (
                  <div style={{color: '#ff9800', fontSize: '12px', marginTop: '4px'}}>
                    ⚠️ 多图模式不支持参考图
                  </div>
                )}
                <button type="button" className="generate-btn" onClick={handleGenerate}>
                  🚀 生成
                </button>
              </div>
            </div>

            {/* 第二栏：编辑图片 */}
            <div className="panel-column edit-column">
              <div className="column-header">
                <span>编辑图片</span>
                <div className="header-actions">
                  <button 
                    type="button" 
                    className="header-btn add-btn"
                    onClick={() => setShowAddRefMenu(!showAddRefMenu)}
                    title="添加图片"
                  >
                    ＋
                  </button>
                </div>
              </div>
              {showAddRefMenu && (
                <div 
                  style={{ 
                    position: 'fixed',
                    top: '280px',
                    left: '450px',
                    width: '150px',
                    background: '#2a2a2a',
                    border: '1px solid #4CAF50',
                    borderRadius: '8px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                    zIndex: 10002,
                    overflow: 'hidden'
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div 
                    style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #444' }}
                    onClick={handleAddFromFile}
                    onMouseEnter={(e) => e.target.style.background = '#444'}
                    onMouseLeave={(e) => e.target.style.background = 'transparent'}
                  >
                    📁 本地文件
                  </div>
                  <div 
                    style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #444' }}
                    onClick={() => setShowAddRefMenu(false)}
                    onMouseEnter={(e) => e.target.style.background = '#444'}
                    onMouseLeave={(e) => e.target.style.background = 'transparent'}
                  >
                    📋 Ctrl+V 粘贴
                  </div>
                  {canvasImages.length > 0 && (
                    <div 
                      style={{ padding: '8px 12px', cursor: 'pointer' }}
                      onClick={handleAddFromCanvas}
                      onMouseEnter={(e) => e.target.style.background = '#444'}
                      onMouseLeave={(e) => e.target.style.background = 'transparent'}
                    >
                      🖼️ 从画布选择
                    </div>
                  )}
                </div>
              )}
              <div className="edit-images-list">
                {/* 原图 */}
                <div 
                  className={`edit-thumb ${currentImageUrl === imageUrl ? 'active' : ''}`}
                  onClick={handleSwitchToMainImage}
                >
                  <img src={imageUrl} alt="原图" />
                  <span className="thumb-label">原图</span>
                </div>
                {/* 添加的编辑图片 */}
                {editingImages.map((img, index) => {
                  const imgUrl = img.url || img
                  const isActive = currentImageUrl === imgUrl
                  return (
                    <div 
                      key={index} 
                      className={`edit-thumb ${isActive ? 'active' : ''}`}
                      onClick={() => handleEditReferenceImage(img)}
                    >
                      <img src={imgUrl} alt={img.name || `图片${index + 1}`} />
                      <span className="thumb-label">{img.name || `图${index + 1}`}</span>
                      <button 
                        type="button" 
                        className="thumb-delete-btn"
                        onClick={(e) => { e.stopPropagation(); handleDeleteEditingImage(index); }}
                        title="移除"
                      >
                        ✕
                      </button>
                    </div>
                  )
                })}
              </div>
              <input 
                type="file" 
                ref={fileInputRef}
                style={{ display: 'none' }}
                accept="image/*"
                onChange={handleFileSelect}
              />
            </div>

            {/* 第三栏：新参考图 */}
            <div className="panel-column saved-column">
              <div className="column-header">
                <span>新参考图</span>
                <span className="count-badge">{savedReferenceImages.length}</span>
              </div>
              <div className="saved-images-list">
                {savedReferenceImages.length === 0 ? (
                  <div className="empty-hint">点击💾保存</div>
                ) : (
                  savedReferenceImages.map((ref, index) => (
                    <div 
                      key={ref.id} 
                      className={`saved-thumb ${editingSavedRefIndex === index ? 'editing' : ''}`}
                      onClick={() => handleEditSavedReference(ref, index)}
                      title="点击编辑"
                    >
                      <span className="thumb-number">{index + 1}</span>
                      <img src={ref.url} alt={ref.name} />
                      <span className="thumb-label">图{index + 1}</span>
                      <button 
                        type="button" 
                        className="thumb-delete-btn"
                        onClick={(e) => { e.stopPropagation(); handleDeleteSavedReference(index); }}
                        title="删除"
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 第四栏：生成记录 */}
            <div className="panel-column record-column">
              <div className="column-header">
                <span>生成记录</span>
                {nodeInfo?.prompt && (
                  <button 
                    type="button" 
                    className="regenerate-header-btn"
                    onClick={handleRegenerate}
                    title="使用原提示词和参考图重新生成"
                  >
                    🔄 重新生成
                  </button>
                )}
              </div>
              <div className="record-content">
                {nodeInfo?.prompt && (
                  <div className="record-item">
                    <span className="record-label">原提示词</span>
                    <div className="record-prompt" title={nodeInfo.prompt}>
                      {nodeInfo.prompt.length > 30 ? nodeInfo.prompt.substring(0, 30) + '...' : nodeInfo.prompt}
                    </div>
                    <button 
                      type="button" 
                      className="use-prompt-btn"
                      onClick={handleCopyPromptToEdit}
                      title="使用此提示词"
                    >
                      ↙
                    </button>
                  </div>
                )}
                {originalReferenceImages && originalReferenceImages.length > 0 && (
                  <div className="record-item">
                    <span className="record-label">原参考图</span>
                    <div className="record-refs">
                      {originalReferenceImages.map((img, index) => {
                        const imgUrl = img.url || img
                        return (
                          <div 
                            key={index} 
                            className="record-ref-mini"
                            onClick={() => handleMoveOriginalToEditing(img)}
                            title="添加到编辑列表"
                          >
                            <img src={imgUrl} alt={`参考${index + 1}`} />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                <div className="record-item params">
                  <span>{nodeInfo?.model || 'gemini-3-pro'}</span>
                  <span>{nodeInfo?.aspectRatio || '1:1'}</span>
                  <span>{nodeInfo?.resolution || '2K'}</span>
                </div>
                {nodeInfo?.prompt && (
                  <button 
                    type="button" 
                    className="regenerate-btn"
                    onClick={handleRegenerate}
                    title="使用原提示词和参考图重新生成"
                  >
                    🔄 重新生成
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        )}

        {/* 编辑提示词弹窗 */}
        {editingPrompt && (
          <div className="edit-prompt-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-prompt-content">
              <h4>编辑快捷提示词</h4>
              <div className="edit-field">
                <label>标签</label>
                <input 
                  type="text" 
                  value={editLabel} 
                  onChange={(e) => setEditLabel(e.target.value)}
                  placeholder="如：根据标注修改"
                />
              </div>
              <div className="edit-field">
                <label>提示词</label>
                <textarea 
                  value={editText} 
                  onChange={(e) => setEditText(e.target.value)}
                  rows={3}
                  placeholder="输入完整的提示词内容..."
                />
              </div>
              <div className="edit-buttons">
                <button type="button" onClick={() => setEditingPrompt(null)}>取消</button>
                <button type="button" className="save-btn" onClick={handleSaveEditPrompt}>保存</button>
              </div>
            </div>
          </div>
        )}

        {/* ESC 退出确认弹窗 */}
        {showExitConfirm && (
          <div className="exit-confirm-overlay">
            <div className="exit-confirm-dialog">
              <h4>确认退出</h4>
              <p>有未保存的修改，是否保存后退出？</p>
              <div className="exit-confirm-buttons">
                <button type="button" onClick={() => setShowExitConfirm(false)}>取消</button>
                <button type="button" className="discard-btn" onClick={handleConfirmExit}>不保存</button>
                <button type="button" className="save-btn" onClick={handleSaveAndExit}>保存并生成</button>
              </div>
            </div>
          </div>
        )}

        {/* 从画布选择图片弹窗 */}
        {showCanvasImagePicker && (
          <div className="canvas-image-picker-overlay" onClick={() => setShowCanvasImagePicker(false)}>
            <div className="canvas-image-picker" onClick={(e) => e.stopPropagation()}>
              <div className="picker-header">
                <h4>选择画布中的图片</h4>
                <button type="button" className="close-btn" onClick={() => setShowCanvasImagePicker(false)}>✕</button>
              </div>
              <div className="picker-content">
                {canvasImages.length > 0 ? (
                  canvasImages.map((img, index) => (
                    <div 
                      key={img.id || index} 
                      className="picker-image-item"
                      onClick={() => handleSelectCanvasImage(img)}
                    >
                      <img src={img.thumbnail || img.imageUrl} alt={`#${img.sequenceNum || index + 1}`} />
                      <div className="picker-image-label">#{img.sequenceNum || index + 1}</div>
                    </div>
                  ))
                ) : (
                  <div className="picker-empty">画布上没有图片</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>,
    document.body
  )
}

export default ImageAnnotationEditor
