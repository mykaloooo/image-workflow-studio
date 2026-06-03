import React, { createContext, useContext } from 'react'

// 创建 Context 用于在节点中访问所有 nodes 和 edges
const NodesContext = createContext({
  nodes: [],
  edges: []
})

export const NodesProvider = ({ children, nodes, edges }) => {
  return (
    <NodesContext.Provider value={{ nodes, edges }}>
      {children}
    </NodesContext.Provider>
  )
}

// 自定义 Hook，用于获取当前节点的参考图
export const useReferenceImages = (nodeId) => {
  const { nodes, edges } = useContext(NodesContext)

  // 查找连接到此节点的参考图
  const parentEdges = edges.filter((e) => e.target === nodeId)
  const referenceImages = parentEdges
    .map((edge) => {
      const parentNode = nodes.find((n) => n.id === edge.source)

      // 只要节点存在且有图片 URL，就认为是参考图 (放宽条件，不再检查 data.type)
      if (parentNode && parentNode.data && parentNode.data.imageUrl) {
        return {
          id: parentNode.id,
          imageUrl: parentNode.data.imageUrl,
          sequenceNum: parentNode.data.sequenceNum,
          prompt: parentNode.data.prompt
        }
      }
      return null
    })
    .filter(Boolean)

  return referenceImages
}

// 自定义 Hook，用于获取画布上所有图片节点（排除当前节点）
export const useCanvasImages = (currentNodeId) => {
  const { nodes } = useContext(NodesContext)

  // 获取所有有图片的节点（排除当前节点）
  const canvasImages = nodes
    .filter((n) => {
      // 排除当前节点
      if (n.id === currentNodeId) return false
      // 只要有图片 URL 就包含
      return n.data && n.data.imageUrl
    })
    .map((n) => ({
      id: n.id,
      imageUrl: n.data.imageUrl,
      thumbnail: n.data.thumbnail || n.data.imageUrl,
      sequenceNum: n.data.sequenceNum,
      prompt: n.data.prompt
    }))

  return canvasImages
}

export default NodesContext
