# 故事板功能开发计划（Storyboard）

> **状态**：Phase 0 进行中
> **决策日期**：2026-05-13
> **回滚锚点**：`git tag stable-20260513-pre-storyboard`
> **AGENTS.md 锁定区**：L1-L7 **零修改**

---

## 1. 背景与需求

卡卡日常电商/装修/产品图工作流里需要两种"故事板"形态：

| 形态 | 含义 | 优先级 |
|---|---|---|
| **形态①** 多视角产品套图 | 同一产品出 4-6 张：主图 / 结构图 / 材质图 / 场景图 | **本次实现** |
| **形态②** 连续动作分镜 | 4 格漫画：包装 → 打开 → 组装 → 使用，要求角色一致 | 下期（已预留扩展位） |

## 2. 关键技术结论

**故事板的本质 = 对"参考图 + 提示词"做批量编排和并发调度**，与模型自身的对话上下文无关。

| Provider | 状态 | 唯一可控变量 |
|---|---|---|
| gpt-image-2 (`/v1/images/edits` & `/generations`) | 无状态 | `reference_images` + `prompt` |
| Gemini 原生 | 无状态 | 同上 |
| chat-image (`gpt-5.4-mini`) | 无状态（我们每次重组 messages） | 同上 |
| 万相 wan2.7 | 无状态 | 同上 |
| Flow Web | 无状态 | 同上 |

**好处**：故事板逻辑跨 provider 零迁移成本。

## 3. 决策矩阵（卡卡 2026-05-13 拍板）

| 决策点 | 选择 | 备注 |
|---|---|---|
| Q1 prompt 模板 | 预填中文骨架，可改 | 按 memory `1799f6d2` 的主图/结构图/材质图/场景图 |
| Q2 默认参数 | 下拉选择，优先级"上次成功 > 预设 > 其他" | 风格参考 Eagle 插件 `image-batch-gen` |
| Q3 触发模式 | **先串行**（#1 主图确认后再出 #2#3#4） | |
| Q3' 抽卡 | **B 模式**优先：同 prompt × 同 provider × 多张 | 数据结构预留 C 模式（多 provider）扩展位 |
| Q4 入口 | 右键菜单出故事板 | 默认 Feature Flag 关闭 |
| 隔离级别 | **Level 2**：代码隔离 + Feature Flag（localStorage） | 不碰 `system_config.json`（L3 锁定区） |

## 4. 守住 AGENTS.md 锁定区

| 文件 / 模块 | 本次会改吗 | 锁定 ID |
|---|---|---|
| `backend/app.py` | ❌ 零修改 | L1 / L2 / L3 / L6 / L7 |
| `system_config.json` | ❌ 零修改 | L3 |
| Eagle 插件 `image-batch-gen/logic.js` | ❌ 零修改 | L4 / L7 |
| `chatgpt2api` 反代 | ❌ 零修改 | L5 |
| `ImageNode.jsx` | ❌ 零修改 | — |
| `Canvas.jsx` | ⚠️ **仅加 1 行右键菜单 entry** | — |
| `SystemSettings.jsx` | ✅ 加"🧪 实验功能"分区 + checkbox | — |
| `frontend/src/components/Storyboard/` | ✅ 新建子目录 | — |
| `frontend/src/utils/featureFlags.js` | ✅ 新建 | — |

## 5. 实施 Phase 拆分

### Phase 0: 准备（本 commit）

- [x] 跑基线测试 → 86/86 全绿
- [x] git tag `stable-20260513-pre-storyboard`
- [x] 落地本文档

### Phase 1: Feature Flag 基础设施

- [ ] `frontend/src/utils/featureFlags.js`：localStorage helper（`STORYBOARD_ENABLED` key）
- [ ] `SystemSettings.jsx` 加"🧪 实验功能"分区
- [ ] checkbox "启用故事板 (v2.3.0-beta)"，默认关
- [ ] 关闭时右键菜单完全看不到故事板入口

### Phase 2: 创建弹窗 + 批量空节点（首个可视化里程碑 → 卡卡试用）

- [ ] `frontend/src/components/Storyboard/StoryboardCreateModal.jsx`
- [ ] 预设布局：1×4 套图 / 2×2 / 3×2 / 3×3
- [ ] 默认 provider 下拉（"上次成功 → 预设 → 其他"）
- [ ] 默认比例 / 分辨率下拉
- [ ] `Canvas.jsx` 加右键菜单 entry "📑 创建故事板组"（受 Feature Flag 控制）
- [ ] 1×4 预设自动预填中文 prompt 骨架
- [ ] 节点头部加 `📑 #N` 标签（通过 `storyboardId` / `slotIndex` 识别）

### Phase 3: 组工具栏 + 串行触发

- [ ] 选中任一组成员时浮出组工具栏
- [ ] **▶ 全部生成**：严格串行，#1 完成后才出 #2
- [ ] **🗑 删除组**：批量清除
- [ ] **⏸ 暂停**：取消队列里没开始的

### Phase 4: 抽卡按钮 - B 模式（预留 C 扩展位）

- [ ] 每个节点加 **🎲 抽卡** 按钮
- [ ] 弹窗：输入张数（1-8）→ 单 provider 连续出 N 张
- [ ] 候选画廊：缩略图网格 + "采用"/"另存"/"丢弃" 三个操作
- [ ] 数据结构：

```js
node.data.candidates = [
  {
    providers: [providerId],  // 数组里现在 1 个，C 期可塞多个
    images: [{ url, thumbnail, ... }, ...],
    generatedAt: timestamp,
  },
  ...
]
```

### Phase 5: 持久化 + Eagle 导出

- [ ] `storyboardId` / `slotIndex` / `candidates` 跟着 project save/load
- [ ] 整组导出到 Eagle 子文件夹 `{产品名}_storyboard/`

## 6. 节点数据结构（最终形态）

```js
{
  id: "node_xxx",
  type: "imageNode",
  position: { x, y },
  data: {
    // === 现有字段（不动）===
    type: "prompt",
    status: "idle",
    prompt: "产品主图：xxxx",
    imageUrl: null,
    thumbnail: null,
    sequenceNum: 42,
    aspectRatio: "1:1",
    resolution: "2K",
    model: "codex-gpt-image-2",
    // ...

    // === 故事板新增字段 ===
    storyboardId: "sb_1747094520_abc",  // 同一组共享
    slotIndex: 0,                        // 组内序号（0-based）
    slotLabel: "主图",                   // UI 显示
    storyboardLayout: "1x4",             // 1x4 / 2x2 / 3x2 / 3x3

    // === 抽卡候选池（Phase 4 引入）===
    candidates: [
      {
        id: "cand_xxx",
        providers: [providerId],         // 数组预留 C 模式
        images: [{ url, thumbnail, prompt, ... }, ...],
        generatedAt: 1747094520000,
        adopted: false,                  // 是否被采用为该格主图
      },
    ],
  },
}
```

## 7. 多机部署（PC1 / PC2）

| 项 | 说明 |
|---|---|
| 部署路径 | PC1: `J:\AI2026\ZL\projects\image-workflow-studio` / PC2: `D:\2026AI\image-workflow-studio` |
| 同步方式 | **git pull**（禁止 scp / Syncthing 直接覆盖前端代码） |
| 独立性 | 故事板纯前端 + localStorage，**PC1/PC2 完全独立**，无跨机依赖 |
| Eagle 插件 | **零修改**，PC2 现有插件不受影响 |
| 后端 5688 | **零修改**，PC2 现有后端不受影响 |

## 8. 测试 & 验收

- **每个 Phase 完成后**：`cd backend && python -m pytest tests/ -v` 必须保持 86/86 全绿
- **Phase 2 完成时**：叫卡卡试用 → 看是否能创建故事板组
- **Phase 4 完成时**：叫卡卡抽 1 次卡 → 验证 UX
- **Phase 5 完成时**：叫卡卡完整跑一次端到端（创建 → 出图 → 抽卡 → 导出 Eagle）

## 9. 翻车应急

**任何 Phase 出问题，一键回滚**：

```bash
git checkout stable-20260513-pre-storyboard -- frontend/src/
# 检查
git diff HEAD
# 确认无误后
git commit -am "rollback: revert storyboard changes"
```

**完全放弃故事板**：直接 `git reset --hard stable-20260513-pre-storyboard`。

## 10. 中央记忆关联

- `1799f6d2` 电商产品图第一轮先做素材还原（Q1 模板骨架来源）
- `411693ee` 批次并行队列架构（未来 C 模式可复用）
- `dfffdde9` 13 比例最大尺寸已校验（Q2 下拉选项来源）
- `d39ad293` 生图历史聚合面板（Q2 "上次成功" 数据源）

## 11. 工期估计

- Phase 0: 30 分钟 ✅
- Phase 1: 1 小时
- Phase 2: 半天（首个可见里程碑）
- Phase 3: 半天
- Phase 4: 1 天
- Phase 5: 半天

**总计：约 3 天**，不影响卡卡白天出图（晚上做 + 验收）。
