import React, { useState, useRef, useEffect } from 'react'
import { Handle, Position } from 'reactflow'
import { useReferenceImages, useCanvasImages } from '../contexts/NodesContext'
import ImageAnnotationEditor from './ImageAnnotationEditor'
import ImageCropModal from './ImageCropModal'
import { getPromptTemplates, upsertPromptTemplate, getSystemConfig, patchHistoryRecord } from '../utils/api'
import { getModelCapabilities, ensureSupported } from '../utils/modelCapabilities'

function ImageNode({ data, id }) {
  const [promptText, setPromptText] = useState(data.prompt || '')
  const [params, setParams] = useState({
    aspectRatio: data.aspectRatio || '1:1',
    resolution: data.resolution || '2K',
    model: data.model || 'gemini-3-pro'
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
  const [activeModelName, setActiveModelName] = useState('')
  const capabilities = getModelCapabilities(activeModelName)

  // 加载 active image provider 的模型名（决定下拉框选项）
  useEffect(() => {
    const loadActiveModel = async () => {
      try {
        const result = await getSystemConfig()
        if (result.success && result.config) {
          const providers = result.config.providers || []
          const activeId = result.config.active_image_provider_id
          const active = providers.find(p => p.id === activeId && p.type === 'image')
          if (active && active.model) {
            setActiveModelName(active.model)
          }
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
    setParams(prev => ({
      ...prev,
      aspectRatio: ensureSupported(prev.aspectRatio, capabilities.aspectRatios, '1:1'),
      resolution: ensureSupported(prev.resolution, capabilities.resolutions, '2K')
    }))
  }, [capabilities.type])

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
    if (data.onGenerate) {
      data.onGenerate(id, {
        prompt: promptText,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        model: params.model,
        count: generateCount
      })
    }
  }

  // 使用 Context Hook 获取参考图（避免循环引用）
  // 对所有节点都查找参考图（通过 edges 连接）
  const referenceImages = useReferenceImages(id)
  
  // 获取画布上所有图片节点（用于从画布选择参考图）
  const canvasImages = useCanvasImages(id)
  
  // 对于已生成的图片，优先使用保存的参考图信息，否则通过 edges 查找
  const nodeReferenceImages = data.type === 'image' 
    ? (data.sourceReferenceImages && data.sourceReferenceImages.length > 0 
        ? data.sourceReferenceImages 
        : referenceImages.map(ref => ({ url: ref.imageUrl })))
    : referenceImages.map(ref => ({ url: ref.imageUrl }))

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
          console.log('调用 onRegenerate (重新生成)，参数:', {
            prompt: prompt,
            aspectRatio: params.aspectRatio,
            resolution: params.resolution,
            referenceImageUrl: data.imageUrl,
            referenceImages: referenceImages
          })
          data.onRegenerate(id, {
            prompt: prompt,
            aspectRatio: params.aspectRatio,
            resolution: params.resolution,
            model: params.model,
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
            data.onRegenerate(id, {
              saveOnly: true,
              imageUrl: result.url,
              savedPrompt: prompt,  // 保存提示词
              annotationData: canvasData  // 保存画布数据
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
          console.log('调用 onRegenerate，参数:', {
            prompt: prompt,
            aspectRatio: params.aspectRatio,
            resolution: params.resolution,
            model: params.model,
            referenceImageUrl: result.url
          })
          data.onRegenerate(id, {
            prompt: prompt,
            aspectRatio: params.aspectRatio,
            resolution: params.resolution,
            model: params.model,
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
            model: data.model,
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
                  data.onRegenerate(id, {
                    prompt: '局部材质细节',
                    aspectRatio: params.aspectRatio,
                    resolution: params.resolution,
                    model: params.model,
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

            {/* 参考图缩略图区域 */}
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

            {/* 底部工具栏 */}
            <div className="bottom-toolbar nodrag nopan nowheel" style={{ background: 'transparent' }} onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
              <div className="toolbar-left">
                {/* 模型展示（只读，真实模型在系统设置里切换） */}
                <select
                  className="toolbar-select"
                  value={capabilities.type}
                  disabled
                  title={activeModelName ? `当前模型: ${activeModelName}` : '未配置图片模型'}
                >
                  <option value={capabilities.type}>{capabilities.displayName}</option>
                </select>

                {/* 宽高比（按模型能力动态过滤） */}
                <select
                  className="toolbar-select"
                  value={params.aspectRatio}
                  onChange={(e) => setParams({...params, aspectRatio: e.target.value})}
                  title={capabilities.note ? `宽高比 · ${capabilities.note}` : '宽高比'}
                >
                  {capabilities.aspectRatios.map(ratio => (
                    <option key={ratio} value={ratio}>{ratio}</option>
                  ))}
                </select>

                {/* 分辨率（按模型能力动态过滤） */}
                <select
                  className="toolbar-select"
                  value={params.resolution}
                  onChange={(e) => setParams({...params, resolution: e.target.value})}
                  title={capabilities.type === 'openai_images' ? '1K=low / 2K=medium / 4K=high' : '分辨率'}
                >
                  {capabilities.resolutions.map(res => (
                    <option key={res} value={res}>{res}</option>
                  ))}
                </select>

                {/* 生成数量 */}
                <select
                  className="toolbar-select"
                  value={generateCount}
                  onChange={(e) => setGenerateCount(parseInt(e.target.value))}
                  title="生成数量"
                >
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
              </div>

              <div className="toolbar-right">
                {/* 生成按钮 */}
                <button
                  className="generate-btn-new"
                  onClick={handleGenerate}
                  disabled={data.status === 'generating'}
                >
                  {data.status === 'generating' ? '⏳' : '🚀'}
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
                <button
                  className="download-btn"
                  onClick={() => {
                    const link = document.createElement('a')
                    link.href = data.imageUrl
                    link.download = data.filename || `generated_${Date.now()}.png`
                    link.click()
                    // 下载即视为"画布保存"，PATCH 历史记录状态
                    // 失败不打断用户，只在控制台 warn
                    if (data.historyRecordId) {
                      patchHistoryRecord(data.historyRecordId, { canvas_save_state: 'canvas_saved' })
                        .catch(err => console.warn('[history] canvas_save_state 更新失败:', err))
                    }
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
