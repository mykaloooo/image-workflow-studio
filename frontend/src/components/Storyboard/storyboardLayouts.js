// 故事板布局预设 - 定义网格形状 + 自动计算节点坐标
//
// 设计原则：
// - 纯函数，不依赖 React，方便测试
// - 节点尺寸经验值（imageNode 实际约 320×460）
// - 锚点 = 弹窗触发位置（右键点击坐标），从锚点开始向右下铺开

// imageNode 视觉尺寸（含 padding，用于布局间距计算）
const NODE_WIDTH = 320
const NODE_HEIGHT = 480
const GAP_X = 60
const GAP_Y = 60

// 布局预设
//  cols / rows: 网格维度
//  slots:       每格的语义标签（用于 UI 显示，对应预填 prompt 模板的 key）
export const LAYOUTS = {
  '1x4': {
    id: '1x4',
    name: '1×4 套图（推荐电商首图）',
    description: '横向 4 格：主图 / 结构图 / 材质图 / 场景图',
    cols: 4,
    rows: 1,
    slots: ['hero', 'structure', 'material', 'scene'],
  },
  '2x2': {
    id: '2x2',
    name: '2×2 网格（4 分镜）',
    description: '2 列 2 行，常用于 4 分镜或简单套图',
    cols: 2,
    rows: 2,
    slots: ['scene1', 'scene2', 'scene3', 'scene4'],
  },
  '3x2': {
    id: '3x2',
    name: '3×2 网格（6 分镜）',
    description: '3 列 2 行，6 张候选',
    cols: 3,
    rows: 2,
    slots: ['scene1', 'scene2', 'scene3', 'scene4', 'scene5', 'scene6'],
  },
  '3x3': {
    id: '3x3',
    name: '3×3 网格（9 分镜）',
    description: '3 列 3 行，常用于全套展示',
    cols: 3,
    rows: 3,
    slots: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'],
  },
}

// 默认布局
export const DEFAULT_LAYOUT_ID = '1x4'

// 生成 storyboard 唯一 id
export function generateStoryboardId() {
  return `sb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// 计算每个 slot 在画布上的绝对坐标
// anchor: 锚点（右键点击位置在画布坐标系里）
// 返回 [{ slotIndex, position: { x, y } }, ...]
export function computeSlotPositions(layoutId, anchor) {
  const layout = LAYOUTS[layoutId]
  if (!layout) {
    throw new Error(`未知 storyboard 布局: ${layoutId}`)
  }

  const { cols, rows } = layout
  const positions = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const slotIndex = r * cols + c
      positions.push({
        slotIndex,
        position: {
          x: anchor.x + c * (NODE_WIDTH + GAP_X),
          y: anchor.y + r * (NODE_HEIGHT + GAP_Y),
        },
      })
    }
  }
  return positions
}

// 工具：取布局的格子总数
export function getSlotCount(layoutId) {
  const layout = LAYOUTS[layoutId]
  return layout ? layout.cols * layout.rows : 0
}
