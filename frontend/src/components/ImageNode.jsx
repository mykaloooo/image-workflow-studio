import React, { useState, useRef, useEffect, useMemo } from 'react'
import { Handle, Position } from 'reactflow'
import { useReferenceImages, useCanvasImages } from '../contexts/NodesContext'
import ImageAnnotationEditor from './ImageAnnotationEditor'
import ImageCropModal from './ImageCropModal'
import { getPromptTemplates, upsertPromptTemplate, getSystemConfig } from '../utils/api'
import { getModelCapabilities, getModelDisplayName, ensureSupported } from '../utils/modelCapabilities'

function normalizeProviderModels(provider) {
  const candidates = [
    ...(Array.isArray(provider?.models) ? provider.models : []),
    provider?.model,
  ]
  const normalized = []
  for (const candidate of candidates) {
    const model = String(candidate || '').trim()
    if (model && !normalized.includes(model)) {
      normalized.push(model)
    }
  }
  return normalized
}

function buildImageModelEntries(providers, preferredProviderId) {
  const orderedProviders = [...(providers || [])].sort((a, b) => {
    if (a?.id === preferredProviderId) return -1
    if (b?.id === preferredProviderId) return 1
    return 0
  })
  return orderedProviders.flatMap(provider => {
    const providerName = provider?.name || provider?.id || '未命名供应商'
    return normalizeProviderModels(provider).map(model => ({
      key: `${provider.id}::${model}`,
      providerId: provider.id,
      providerName,
      model,
      label: `${getModelDisplayName(model)} · ${providerName}`,
    }))
  })
}

function resolveSelectedModelEntry(entries, providerId, model) {
  const normalizedProviderId = String(providerId || '').trim()
  const normalizedModel = String(model || '').trim()
  if (normalizedProviderId && normalizedModel) {
    const exactMatch = entries.find(entry => entry.providerId === normalizedProviderId && entry.model === normalizedModel)
    if (exactMatch) return exactMatch
  }
  if (normalizedModel) {
    const modelMatch = entries.find(entry => entry.model === normalizedModel)
    if (modelMatch) return modelMatch
  }
  if (normalizedProviderId) {
    const providerMatch = entries.find(entry => entry.providerId === normalizedProviderId)
    if (providerMatch) return providerMatch
  }
  return entries[0] || null
}

function ImageNode({ data, id }) {
  const [promptText, setPromptText] = useState(data.prompt || '')
  const [params, setParams] = useState({
    aspectRatio: data.aspectRatio || '1:1',
    resolution: data.size || data.resolution || '2K',
    model: data.model || '',
    providerId: data.providerId || data.provider_id || ''
  })
  const [generateCount, setGenerateCount] = useState(1)
  const [showFullImage, setShowFullImage] = useState(false)
  const [fullImageLoaded, setFullImageLoaded] = useState(false)
  const [showAnnotationEditor, setShowAnnotationEditor] = useState(false)
  const [showCropModal, setShowCropModal] = useState(false)
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [pickerGroupFilter, setPickerGroupFilter] = useState(null)
  const [templateGroups, setTemplateGroups] = useState([])
  const [templates, setTemplates] = useState([])
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [saveTemplateName, setSaveTemplateName] = useState('')
  const [saveTemplateGroup, setSaveTemplateGroup] = useState('default')

  // 当前激活的图片生成模型（从 system_config 读取）
  const [imageProviders, setImageProviders] = useState([])
  const [defaultImageProviderId, setDefaultImageProviderId] = useState('')
  const modelOptions = useMemo(() => buildImageModelEntries(imageProviders, defaultImageProviderId), [imageProviders, defaultImageProviderId])
  const selectedEntry = useMemo(() => resolveSelectedModelEntry(modelOptions, params.providerId, params.model), [modelOptions, params.providerId, params.model])
  const selectedModel = selectedEntry?.model || params.model || ''
  const selectedProvider = useMemo(() => imageProviders.find(provider => provider.id === selectedEntry?.providerId) || null, [imageProviders, selectedEntry])
  const referenceImages = useReferenceImages(id)
  const canvasImages = useCanvasImages(id)
  const nodeReferenceImages = data.type === 'image'
    ? (data.sourceReferenceImages && data.sourceReferenceImages.length > 0
        ? data.sourceReferenceImages
        : referenceImages.map(ref => ({ url: ref.imageUrl })))
    : referenceImages.map(ref => ({ url: ref.imageUrl }))
  const hasReferenceImage = nodeReferenceImages.length > 0
  const capabilities = useMemo(() => getModelCapabilities(selectedModel, {
    aspectRatio: params.aspectRatio,
    hasReferenceImage,
  }), [selectedModel, params.aspectRatio, hasReferenceImage])
  const supportedAspectRatios = useMemo(() => capabilities.aspectRatioOptions.map(option => option.value), [capabilities.aspectRatioOptions])
  const supportedResolutions = useMemo(() => capabilities.resolutionOptions.map(option => option.value), [capabilities.resolutionOptions])
  const flowStatusText = data.flowBridge?.statusText || data.flowBridge?.status_text || 'Flow队列中...'
  const flowStatusDetail = data.flowBridge?.statusDetail || data.flowBridge?.status_detail || ''
  const isFlowImage = Boolean(data.flowBridge?.jobId || data.flowBridge?.taskId || data.flowArtifact?.jobId)

  const buildRequestParams = (inputParams = params) => {
    const inputCapabilities = getModelCapabilities(inputParams.model, {
      aspectRatio: inputParams.aspectRatio,
      hasReferenceImage,
    })
    const request = {
      aspectRatio: inputParams.aspectRatio,
      resolution: inputParams.resolution,
      model: inputParams.model,
      providerId: inputParams.providerId,
    }

    if (inputCapabilities.requestField === 'size') {
      request.size = inputParams.resolution
    }

    return request
  }

  // 加载 active image provider 的模型名（决定下拉框选项）
  useEffect(() => {
    const loadActiveModel = async () => {
      try {
        const result = await getSystemConfig()
        if (result.success && result.config) {
          const providers = (result.config.providers || []).filter(provider => provider.type === 'image')
          setImageProviders(providers)
          setDefaultImageProviderId(result.config.active_image_provider_id || '')
        }
      } catch (err) {
        console.error('加载 active 模型失败:', err)
      }
    }
    loadActiveModel()

    // 订阅配置更新事件（SystemSettings 保存后触发）
    const handler = () => loadActiveModel()
    window.addEventListener('system-config-updated', handler)
    return () => window.removeEventListener('system-config-updated', handler)
  }, [])

  // 当模型能力变化时，如果当前选中的 aspectRatio / resolution 不在新列表里，自动切到 fallback
  useEffect(() => {
    setParams(prev => {
      const nextEntry = resolveSelectedModelEntry(modelOptions, prev.providerId, prev.model)
      const nextModel = nextEntry?.model || prev.model || ''
      const nextProviderId = nextEntry?.providerId || prev.providerId || ''
      const nextAspectRatio = ensureSupported(prev.aspectRatio, supportedAspectRatios, capabilities.defaultAspectRatio)
      const nextResolution = ensureSupported(prev.resolution, supportedResolutions, capabilities.defaultResolution)
      if (
        prev.model === nextModel &&
        prev.providerId === nextProviderId &&
        prev.aspectRatio === nextAspectRatio &&
        prev.resolution === nextResolution
      ) {
        return prev
      }
      return {
        ...prev,
        model: nextModel,
        providerId: nextProviderId,
        aspectRatio: nextAspectRatio,
        resolution: nextResolution,
      }
    })
  }, [modelOptions, supportedAspectRatios, supportedResolutions, capabilities.defaultAspectRatio, capabilities.defaultResolution])

  useEffect(() => {
    setGenerateCount(prev => Math.min(prev, capabilities.maxCount || 10))
  }, [capabilities.maxCount])

  useEffect(() => {
    const loadTemplates = async () => {
      try {
        const result = await getPromptTemplates()
        if (result.success) {
          setTemplateGroups(result.groups || [])
          setTemplates(result.templates || [])
        }
      } catch (error) {
        console.error('加载提示词模板失败:', error)
      }
    }
    loadTemplates()
  }, [])

  const handleSaveAsTemplate = async () => {
    if (!promptText.trim()) {
      alert('提示词为空，无法保存为模板')
      return
    }
    if (!saveTemplateName.trim()) {
      alert('请输入模板名称')
      return
    }
    const result = await upsertPromptTemplate({
      name: saveTemplateName.trim(),
      prompt: promptText.trim(),
      groupId: saveTemplateGroup,
      icon: '📝',
    })
    if (result.success) {
      // Refresh templates list
      const updated = await getPromptTemplates()
      if (updated.success) {
        setTemplateGroups(updated.groups || [])
        setTemplates(updated.templates || [])
      }
      setShowSaveTemplate(false)
      setSaveTemplateName('')
    } else {
      alert('保存失败: ' + (result.error || '未知错误'))
    }
  }

  const handleGenerate = () => {
    if (!promptText.trim()) {
      alert('请先输入提示词')
      return
    }
    if (params.aspectRatio === 'original' && !hasReferenceImage) {
      alert('原比例需要至少一张参考图')
      return
    }
    if (data.onGenerate) {
      data.onGenerate(id, {
        prompt: promptText,
        ...buildRequestParams(),
        count: generateCount
      })
    }
  }

  // 保存标注后的图片
  const handleSaveAnnotation = async (annotationData) => {
    console.log('=== handleSaveAnnotation 开始 ===')
    console.log('操作类型:', annotationData.action)
    
    try {
      const { action, annotatedImage, prompt, params, annotationData: canvasData, isRegenerate, referenceImages } = annotationData

      // 重新生成：直接使用原图和原参数
      if (isRegenerate) {
        console.log('重新生成模式，使用原参数')
        setShowAnnotationEditor(false)
        
        if (data.onRegenerate) {
          const requestParams = buildRequestParams(params)
          console.log('调用 onRegenerate (重新生成)，参数:', {
            prompt: prompt,
            ...requestParams,
            referenceImageUrl: data.imageUrl,
            referenceImages: referenceImages
          })
          data.onRegenerate(id, {
            prompt: prompt,
            ...requestParams,
            referenceImageUrl: data.imageUrl,
            referenceImages: referenceImages
          })
          console.log('=== onRegenerate (重新生成) 已调用 ===')
        } else {
          alert('无法重新生成：onRegenerate 函数不存在')
        }
        return
      }

      if (!annotatedImage) {
        alert('图片数据为空')
        return
      }

      // 将 base64 转换为 Blob
      console.log('转换图片为 Blob...')
      let blob
      try {
        const response = await fetch(annotatedImage)
        blob = await response.blob()
        console.log('Blob 创建成功, 大小:', blob.size)
      } catch (blobError) {
        console.error('Blob 转换失败:', blobError)
        alert('图片转换失败: ' + blobError.message)
        return
      }

      // 上传到后端
      console.log('上传图片到后端...')
      const formData = new FormData()
      formData.append('file', blob, `annotated_${Date.now()}.png`)

      let uploadResponse
      try {
        uploadResponse = await fetch('/api/upload-image', {
          method: 'POST',
          body: formData
        })
        console.log('上传响应状态:', uploadResponse.status)
      } catch (uploadError) {
        console.error('上传请求失败:', uploadError)
        alert('上传请求失败: ' + uploadError.message)
        return
      }

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text()
        console.error('上传失败响应:', errorText)
        alert('上传失败: ' + errorText)
        return
      }

      let result
      try {
        result = await uploadResponse.json()
        console.log('上传成功:', result)
      } catch (jsonError) {
        console.error('解析响应失败:', jsonError)
        alert('解析响应失败')
        return
      }

      // 关闭标注编辑器
      console.log('关闭标注编辑器...')
      setShowAnnotationEditor(false)

      // 根据操作类型执行不同的动作
      if (action === 'saveAsImage') {
        // 保存标注图为新节点（不生成）
        console.log('保存标注图为新节点')
        if (data.onSaveAnnotatedImage) {
          data.onSaveAnnotatedImage(id, result.url, prompt, canvasData)
        } else {
          console.warn('onSaveAnnotatedImage 不存在，尝试使用 onRegenerate 创建节点')
          // 回退方案：使用 onRegenerate 但不传 prompt，让它只创建节点
          if (data.onRegenerate) {
            const requestParams = buildRequestParams(params)
            data.onRegenerate(id, {
              saveOnly: true,
              imageUrl: result.url,
              savedPrompt: prompt,  // 保存提示词
              annotationData: canvasData,  // 保存画布数据
              ...requestParams,
            })
          } else {
            alert('无法保存标注图：回调函数不存在')
          }
        }
      } else {
        // 生成新图片（默认行为）
        if (!prompt || !prompt.trim()) {
          alert('请输入提示词')
          return
        }
        
        console.log('检查 onRegenerate:', data.onRegenerate ? '存在' : '不存在')
        if (data.onRegenerate) {
          const requestParams = buildRequestParams(params)
          console.log('调用 onRegenerate，参数:', {
            prompt: prompt,
            ...requestParams,
            referenceImageUrl: result.url
          })
          data.onRegenerate(id, {
            prompt: prompt,
            ...requestParams,
            referenceImageUrl: result.url
          })
          console.log('=== onRegenerate 已调用 ===')
        } else {
          console.warn('=== onRegenerate 不存在! ===')
          alert('无法生成图片：onRegenerate 函数不存在')
        }
      }
    } catch (error) {
      console.error('=== handleSaveAnnotation 错误 ===', error)
      alert('保存标注失败: ' + error.message)
    }
    console.log('=== handleSaveAnnotation 结束 ===')
  }

  return (
    <>
      {/* 标注编辑器 */}
      {showAnnotationEditor && data.imageUrl && (
        <ImageAnnotationEditor
          imageUrl={data.imageUrl}
          onSave={handleSaveAnnotation}
          onCancel={() => setShowAnnotationEditor(false)}
          initialPrompt={data.savedPrompt || ''}
          initialAnnotationData={data.annotationData || null}
          nodeInfo={{
            prompt: data.prompt,
            aspectRatio: data.aspectRatio,
            resolution: data.resolution,
            size: data.size,
            model: data.model,
            providerId: data.providerId,
            referenceImages: nodeReferenceImages,
            createdAt: data.createdAt
          }}
          canvasImages={canvasImages}
        />
      )}

      {/* 裁剪编辑器 */}
      {showCropModal && data.imageUrl && (
        <ImageCropModal
          imageUrl={data.imageUrl}
          onCancel={() => setShowCropModal(false)}
          onCrop={async (croppedDataUrl, dimensions) => {
            setShowCropModal(false);

            console.log(`准备上传局部材质细节，尺寸: ${dimensions.width}x${dimensions.height}`);
            let blob;
            try {
              const response = await fetch(croppedDataUrl);
              blob = await response.blob();
            } catch (err) {
              alert('处理图片失败: ' + err.message);
              return;
            }

            // 上传到后端，标记为 lossless
            const formData = new FormData();
            formData.append('file', blob, `detail_${Date.now()}.png`);
            formData.append('is_lossless', 'true');

            try {
              const res = await fetch('/api/upload-image', { method: 'POST', body: formData });
              if (!res.ok) throw new Error(await res.text());

              const result = await res.json();
              if (result.success) {
                console.log('局部细节保存成功，路径:', result.url);
                // 借助 onRegenerate 仅保存节点，不触发 AI 生成
                if (data.onRegenerate) {
                  const requestParams = buildRequestParams(params)
                  data.onRegenerate(id, {
                    prompt: '局部材质细节',
                    ...requestParams,
                    referenceImageUrl: result.url,
                    isOnlySaveNode: true, // 核心标记
                  });
                } else {
                  alert('无法创建节点，onRegenerate 方法缺失');
                }
              } else {
                throw new Error(result.error);
              }
            } catch (err) {
              alert('上传局部图失败: ' + err.message);
            }
          }}
        />
      )}

      {/* 保存为模板弹窗 */}
      {showSaveTemplate && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.7)', zIndex: 10000,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
          onClick={() => setShowSaveTemplate(false)}
        >
          <div
            style={{
              width: '400px', background: '#1e1e1e', borderRadius: '12px',
              padding: '24px', boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
            }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 16px', color: 'white', fontSize: '16px' }}>💾 保存为模板</h3>
            <div style={{ marginBottom: '12px' }}>
              <label style={{ fontSize: '13px', color: '#aaa', display: 'block', marginBottom: '4px' }}>模板名称</label>
              <input
                value={saveTemplateName}
                onChange={e => setSaveTemplateName(e.target.value)}
                placeholder="例如：产品白底图"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') handleSaveAsTemplate() }}
                style={{
                  width: '100%', padding: '8px 12px', background: '#2a2a2a',
                  border: '1px solid #444', borderRadius: '6px', color: 'white',
                  fontSize: '14px', outline: 'none', boxSizing: 'border-box'
                }}
              />
            </div>
            <div style={{ marginBottom: '12px' }}>
              <label style={{ fontSize: '13px', color: '#aaa', display: 'block', marginBottom: '4px' }}>分组</label>
              <select
                value={saveTemplateGroup}
                onChange={e => setSaveTemplateGroup(e.target.value)}
                style={{
                  width: '100%', padding: '8px 12px', background: '#2a2a2a',
                  border: '1px solid #444', borderRadius: '6px', color: 'white',
                  fontSize: '14px', outline: 'none', boxSizing: 'border-box'
                }}
              >
                {templateGroups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '13px', color: '#aaa', display: 'block', marginBottom: '4px' }}>提示词预览</label>
              <div style={{
                padding: '8px 12px', background: '#2a2a2a', borderRadius: '6px',
                border: '1px solid #333', color: '#ccc', fontSize: '12px',
                maxHeight: '80px', overflowY: 'auto', lineHeight: '1.5', whiteSpace: 'pre-wrap'
              }}>{promptText}</div>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowSaveTemplate(false)}
                style={{ padding: '8px 16px', background: '#333', color: '#ccc', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}
              >取消</button>
              <button
                onClick={handleSaveAsTemplate}
                style={{ padding: '8px 16px', background: '#4CAF50', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: '500' }}
              >保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 模板选择弹窗 */}
      {showTemplatePicker && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.7)', zIndex: 10000,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
          onClick={() => setShowTemplatePicker(false)}
        >
          <div
            style={{
              width: '80vw', maxWidth: '900px', height: '70vh',
              background: '#1e1e1e', borderRadius: '12px', overflow: 'hidden',
              display: 'flex', flexDirection: 'column'
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, color: 'white', fontSize: '16px' }}>📝 选择提示词模板</h3>
              <button onClick={() => setShowTemplatePicker(false)} style={{ background: 'none', border: 'none', color: '#999', fontSize: '20px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ padding: '10px 20px', borderBottom: '1px solid #333', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                onClick={() => setPickerGroupFilter(null)}
                style={{
                  padding: '6px 14px', borderRadius: '16px', fontSize: '13px', cursor: 'pointer', border: 'none',
                  background: pickerGroupFilter === null ? '#4CAF50' : '#333', color: 'white'
                }}
              >全部</button>
              {templateGroups.map(g => (
                <button
                  key={g.id}
                  onClick={() => setPickerGroupFilter(g.id)}
                  style={{
                    padding: '6px 14px', borderRadius: '16px', fontSize: '13px', cursor: 'pointer', border: 'none',
                    background: pickerGroupFilter === g.id ? g.color : '#333', color: 'white'
                  }}
                >{g.name}</button>
              ))}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
                {templates
                  .filter(t => !pickerGroupFilter || t.groupId === pickerGroupFilter)
                  .map(t => (
                    <div
                      key={t.id}
                      onClick={() => {
                        setPromptText(prev => prev + (prev ? '\n' : '') + t.prompt);
                        setShowTemplatePicker(false);
                      }}
                      style={{
                        padding: '14px', background: '#2a2a2a', borderRadius: '10px',
                        cursor: 'pointer', transition: 'all 0.2s',
                        border: '1px solid #333'
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#383838'; e.currentTarget.style.borderColor = '#4CAF50'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#2a2a2a'; e.currentTarget.style.borderColor = '#333'; }}
                    >
                      <div style={{ fontSize: '22px', marginBottom: '6px' }}>{t.icon || '📝'}</div>
                      <div style={{ fontSize: '14px', color: 'white', fontWeight: '500', marginBottom: '6px' }}>{t.name}</div>
                      <div style={{
                        fontSize: '12px', color: '#888', lineHeight: '1.4',
                        overflow: 'hidden', textOverflow: 'ellipsis',
                        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical'
                      }}>{t.prompt}</div>
                      <div style={{ marginTop: '8px' }}>
                        <span style={{
                          fontSize: '11px', padding: '2px 8px', borderRadius: '10px',
                          background: (templateGroups.find(g => g.id === t.groupId)?.color || '#555') + '33',
                          color: templateGroups.find(g => g.id === t.groupId)?.color || '#999'
                        }}>
                          {templateGroups.find(g => g.id === t.groupId)?.name || '未分组'}
                        </span>
                      </div>
                    </div>
                  ))
                }
              </div>
              {templates.filter(t => !pickerGroupFilter || t.groupId === pickerGroupFilter).length === 0 && (
                <div style={{ textAlign: 'center', color: '#666', padding: '40px' }}>该分组暂无模板</div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className={`image-node ${data.status}`}>
        {/* 节点内容 */}
        <div className="node-content">
          {data.type === 'prompt' ? (
            // 提示词节点（新设计：提示词在上，生成状态在下）
            <div className="prompt-node-new">
              {/* 顶部标题 - 只有这里可以拖动 */}
              <div className="node-header image-node-drag-handle">
                <span className="node-title">🎨 图片生成</span>
                <span className="drag-hint">⋮⋮</span>
              </div>

              {/* 提示词输入框 */}
              <div className="prompt-input-bar nodrag nopan nowheel" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '13px', color: '#ccc' }}>提示词</span>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      onClick={() => setShowTemplatePicker(!showTemplatePicker)}
                      style={{ background: 'transparent', color: '#4CAF50', border: '1px solid #444', borderRadius: '4px', fontSize: '12px', padding: '4px 10px', cursor: 'pointer' }}
                    >
                      ➕ 模板
                    </button>
                    <button
                      onClick={() => {
                        if (!promptText.trim()) { alert('提示词为空'); return }
                        setSaveTemplateName('')
                        setShowSaveTemplate(true)
                      }}
                      style={{ background: 'transparent', color: '#FF9800', border: '1px solid #444', borderRadius: '4px', fontSize: '12px', padding: '4px 10px', cursor: 'pointer' }}
                      title="将当前提示词保存为模板"
                    >
                      💾 存模板
                    </button>
                  </div>
                </div>
                <textarea
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  placeholder="输入描述，按 Enter 生成..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleGenerate()
                    }
                  }}
                />
              </div>

              {referenceImages.length > 0 && (
                <div className="reference-images-bar" style={{ margin: '12px 12px 0 12px' }}>
                  {referenceImages.map((ref, index) => (
                    <div key={ref.id} className="reference-thumb" title={ref.prompt || `图片 #${ref.sequenceNum}`}>
                      <img src={ref.imageUrl} alt={`参考图 ${index + 1}`} />
                      <span className="reference-num">{index + 1}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="bottom-toolbar image-bottom-toolbar nodrag nopan nowheel" style={{ background: 'transparent' }} onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                <div className="toolbar-left">
                  <select
                    className="toolbar-select image-model-select"
                    value={selectedEntry?.key || ''}
                    onChange={(e) => {
                      const nextEntry = modelOptions.find(option => option.key === e.target.value)
                      if (nextEntry) {
                        const nextCapabilities = getModelCapabilities(nextEntry.model, {
                          aspectRatio: params.aspectRatio,
                          hasReferenceImage,
                        })
                        setParams({
                          ...params,
                          model: nextEntry.model,
                          providerId: nextEntry.providerId,
                          aspectRatio: ensureSupported(params.aspectRatio, nextCapabilities.aspectRatios, nextCapabilities.defaultAspectRatio),
                          resolution: ensureSupported(params.resolution, nextCapabilities.resolutions, nextCapabilities.defaultResolution),
                        })
                      }
                    }}
                    disabled={modelOptions.length === 0}
                    title={selectedProvider ? `当前供应商: ${selectedProvider.name}` : '未配置图片供应商'}
                  >
                    {modelOptions.length === 0 ? (
                      <option value="">未配置模型</option>
                    ) : modelOptions.map(option => (
                      <option key={option.key} value={option.key}>{option.label}</option>
                    ))}
                  </select>

                  <select
                    className="toolbar-select image-compact-select"
                    value={params.aspectRatio}
                    onChange={(e) => {
                      const nextAspectRatio = e.target.value
                      const nextCapabilities = getModelCapabilities(selectedModel, {
                        aspectRatio: nextAspectRatio,
                        hasReferenceImage,
                      })
                      setParams({
                        ...params,
                        aspectRatio: nextAspectRatio,
                        resolution: ensureSupported(params.resolution, nextCapabilities.resolutions, nextCapabilities.defaultResolution),
                      })
                    }}
                  >
                    {capabilities.aspectRatioOptions.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>

                  {capabilities.resolutionOptions.length > 1 && (
                    <select
                      className="toolbar-select image-compact-select"
                      value={params.resolution}
                      onChange={(e) => setParams({...params, resolution: e.target.value})}
                      title={capabilities.note ? `${capabilities.resolutionLabel} · ${capabilities.note}` : capabilities.resolutionLabel}
                    >
                      {capabilities.resolutionOptions.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  )}

                  <select
                    className="toolbar-select image-compact-select image-count-select"
                    value={generateCount}
                    onChange={(e) => setGenerateCount(parseInt(e.target.value, 10))}
                    title="生成数量"
                  >
                    {Array.from({ length: capabilities.maxCount || 10 }, (_, index) => index + 1).map(value => (
                      <option key={value} value={value}>{value}张</option>
                    ))}
                  </select>
                </div>

                <div className="toolbar-right">
                  <button
                    className="generate-btn-new"
                    onClick={handleGenerate}
                    disabled={data.status === 'generating' || data.status === 'queued'}
                  >
                    {data.status === 'generating' || data.status === 'queued' ? '⏳' : '🚀'}
                  </button>
                </div>
              </div>

              {/* 生成状态区域（空白缩小） */}
              <div className="generation-area">
                {data.status === 'generating' ? (
                  <div className="generating-state" style={{ flexDirection: 'row', gap: '8px', margin: 0 }}>
                    <div className="spinner" style={{ width: '16px', height: '16px', borderWidth: '2px' }}></div>
                    <div className="loading-text" style={{ fontSize: '12px', margin: 0 }}>生成中...</div>
                  </div>
                ) : data.status === 'queued' ? (
                  <div className="generating-state" style={{ flexDirection: 'row', gap: '8px', margin: 0 }}>
                    <div className="spinner" style={{ width: '16px', height: '16px', borderWidth: '2px' }}></div>
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <div
                        className="loading-text"
                        title={flowStatusDetail || flowStatusText}
                        style={{
                          fontSize: '12px',
                          margin: 0,
                          maxWidth: '420px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {flowStatusText}
                      </div>
                      {flowStatusDetail && (
                        <div
                          title={flowStatusDetail}
                          style={{
                            color: '#9ca3af',
                            fontSize: '10px',
                            lineHeight: 1.2,
                            maxWidth: '420px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {flowStatusDetail}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="empty-state" style={{ margin: 0 }}>
                    <span style={{ fontSize: '12px' }}>准备就绪，点击上方 🚀 生成</span>
                  </div>
                )}
              </div>
            </div>
        ) : data.type === 'image' ? (
          // 图片节点 - 添加 image-node-drag-handle 类，让整个区域可拖动
          <div className="image-node-content image-node-drag-handle">
            {/* 序列号标签 */}
            {data.sequenceNum && (
              <div className="sequence-badge" title={`图片序号 ${data.sequenceNum}`}>
                #{data.sequenceNum}
              </div>
            )}

            {data.status === 'generating' && (
              <div className="loading-overlay">
                <div className="spinner"></div>
                <div className="loading-text">生成中...</div>
              </div>
            )}

            {data.status === 'completed' && data.imageUrl && (
              <>
                <img
                  src={data.imageUrl}
                  alt={data.filename}
                  className="node-image"
                  title="点击编辑标注"
                  onClick={() => setShowAnnotationEditor(true)}
                />

                {/* 完整图片弹窗 */}
                {showFullImage && (
                  <div
                    className="full-image-overlay"
                    onClick={() => setShowFullImage(false)}
                  >
                    <div className="full-image-container">
                      <img
                        src={data.imageUrl}
                        alt={data.filename}
                        className="full-image"
                        onLoad={() => setFullImageLoaded(true)}
                      />
                      {!fullImageLoaded && (
                        <div className="loading-overlay">
                          <div className="spinner"></div>
                          <div className="loading-text">加载完整图片...</div>
                        </div>
                      )}
                      <button
                        className="close-full-image"
                        onClick={(e) => {
                          e.stopPropagation()
                          setShowFullImage(false)
                          setFullImageLoaded(false)
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {data.status === 'failed' && (
              <div className="error-overlay">
                <div className="error-icon">❌</div>
                <div className="error-text">生成失败</div>
                {data.error && (
                  <div className="error-detail">{data.error}</div>
                )}
              </div>
            )}

            {/* 标签 */}
            <div className="node-badge">图片</div>

            {/* 提示词预览 - 阻止冒泡以允许选择文字 */}
            {(data.prompt || data.sequenceNum) && (
              <div
                className="node-prompt-preview"
                title={data.prompt || `图片#${data.sequenceNum}`}
                onMouseDown={(e) => e.stopPropagation()}
                style={{ cursor: 'text', userSelect: 'text' }}
              >
                {data.sequenceNum && <span style={{color: '#FF6B6B', marginRight: '4px'}}>#{data.sequenceNum}</span>}
                {data.prompt ? (data.prompt.length > 25 ? data.prompt.substring(0, 25) + '...' : data.prompt) : '图片'}
              </div>
            )}

            {data.status === 'completed' && data.imageUrl && (
              <>
                {isFlowImage && data.onFlowRedownload && (
                  <select
                    value=""
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const value = e.target.value
                      e.target.value = ''
                      if (value) {
                        data.onFlowRedownload(id, value)
                      }
                    }}
                    title="从 Flow 重新下载清晰度"
                    style={{
                      position: 'absolute',
                      top: '8px',
                      right: '76px',
                      width: '70px',
                      height: '32px',
                      background: 'rgba(0, 0, 0, 0.75)',
                      color: 'white',
                      border: '1px solid rgba(255,255,255,0.18)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '12px',
                      zIndex: 11,
                    }}
                  >
                    <option value="" disabled>高清</option>
                    <option value="1K">1K</option>
                    <option value="2K">2K</option>
                    <option value="4K">4K</option>
                  </select>
                )}
                <button
                  className="download-btn"
                  onClick={() => {
                    const link = document.createElement('a')
                    link.href = data.imageUrl
                    link.download = data.filename || `generated_${Date.now()}.png`
                    link.click()
                  }}
                  title="下载图片"
                >
                  ⬇️
                </button>
                <button
                  className="crop-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowCropModal(true);
                  }}
                  title="✂️ 提取材质细节为新参考图"
                  style={{
                    position: 'absolute',
                    top: '8px',
                    right: '40px', // Next to download-btn
                    background: 'rgba(0, 0, 0, 0.7)',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    width: '28px',
                    height: '28px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '14px',
                    zIndex: 10,
                  }}
                >
                  ✂️
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>

      {/* 添加子节点按钮 */}
      {data.type === 'prompt' && data.status !== 'generating' && (
        <button
          className="add-child-btn bottom"
          onClick={() => data.onAddChild && data.onAddChild(id)}
          title="添加子节点"
        >
          ➕
        </button>
      )}

      {/* 连接点 - 左侧 */}
      <Handle
        type="target"
        position={Position.Left}
        className="node-handle"
        isConnectable={true}
      />

      {/* 连接点 - 右侧（图片节点） */}
      {data.type === 'image' && (
        <Handle
          type="source"
          position={Position.Right}
          className="node-handle source-handle"
          isConnectable={true}
        />
      )}

      {/* 连接点 - 右侧（提示词节点） */}
      {data.type === 'prompt' && (
        <Handle
          type="source"
          position={Position.Right}
          className="node-handle"
          isConnectable={true}
        />
      )}
    </div>
    </>
  )
}

export default ImageNode
