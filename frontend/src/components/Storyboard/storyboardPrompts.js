// 故事板预填 prompt 模板
//
// 1×4 套图按 memory `1799f6d2`（电商产品图第一轮先做素材还原）的 4 段拆解：
//   主图 / 结构图 / 材质图 / 场景图
// 节点里可以自由编辑，模板只是骨架。

const LABEL_MAP = {
  hero: '🎯 主图',
  structure: '🔧 结构图',
  material: '🧵 材质图',
  scene: '🌅 场景图',
  scene1: '分镜 #1',
  scene2: '分镜 #2',
  scene3: '分镜 #3',
  scene4: '分镜 #4',
  scene5: '分镜 #5',
  scene6: '分镜 #6',
  s1: '#1', s2: '#2', s3: '#3',
  s4: '#4', s5: '#5', s6: '#6',
  s7: '#7', s8: '#8', s9: '#9',
}

// 1×4 套图的 4 段 prompt 骨架
const HERO_PROMPT = '【产品主图】\n白底干净背景，正面 45° 视角，清晰展示产品整体外观与主要细节。\n光线柔和，无阴影干扰。\n（在此补充：产品名 / 颜色 / 关键卖点 / 材质）'

const STRUCTURE_PROMPT = '【产品结构图】\n突出产品内部结构 / 工艺 / 用料层次，可使用爆炸图或剖面图。\n各部件标注清晰，比例真实。\n（在此补充：要重点展示的结构部位）'

const MATERIAL_PROMPT = '【材质图】\n聚焦表面材质细节、纹理、质感，近景特写。\n背景虚化或纯色，突出材质本身。\n（在此补充：材质名称 / 工艺特点）'

const SCENE_PROMPT = '【场景图】\n将产品置于真实使用场景中，体现使用氛围与目标用户。\n构图自然，光线真实，避免过度修饰。\n（在此补充：场景描述 / 目标用户 / 氛围调性）'

const SLOT_PROMPTS = {
  hero: HERO_PROMPT,
  structure: STRUCTURE_PROMPT,
  material: MATERIAL_PROMPT,
  scene: SCENE_PROMPT,
}

// 取 slot 的显示标签
export function getSlotLabel(slotKey) {
  return LABEL_MAP[slotKey] || slotKey
}

// 取 slot 的预填 prompt（找不到返回空串，让用户自己写）
export function getSlotPrompt(slotKey) {
  return SLOT_PROMPTS[slotKey] || ''
}
