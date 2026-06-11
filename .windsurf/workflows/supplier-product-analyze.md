---
description: 供应商产品侦察通用工作流（视频分析→产品合并→Eagle 落地）
---

# 供应商产品侦察通用工作流

## 适用场景

卡卡丢一个 Eagle 供应商/展会文件夹（folderId 或路径），目标：

1. 把里面的视频和图片全过一遍
2. 识别出有几款独立产品
3. 让卡卡确认哪些值得做电商图（worth_ecommerce）
4. 在 Eagle 里把素材分拣到产品子文件夹（P1/P2/...）和 `_Excluded（待审核）`

**这个 workflow 不绑定行业**：沙发、餐椅、床垫、茶几、家电都适用。沙发出图细节在 `sofa-product-image-gen.md` 里，本工作流到 Eagle 分拣完成为止。

## 前置条件

- 凡涉及 Eagle 文件夹/导入/移动/标签/删除，先执行 `eagle-folder-ops.md`
- Eagle 客户端已启动，`http://localhost:41595` 可访问
- 77code 网关 key 可用（见中央记忆 ID `ad6c6a87-346f-45ae-8d4a-0930b45fc32b`）
- Python 环境含 PIL、httpx、ffmpeg

## 强制执行规则 · 进度必须可见

任何超过 30 秒、或处理对象超过 1 个的视频分析/抽帧/拼图/导入/Eagle 引用脚本，必须显式输出进度，不能静默运行。

脚本输出至少包含：

- **启动信息**：任务名、供应商名、Eagle 完整路径、folderId、是否会写 Eagle、输出目录
- **总量信息**：视频数、照片数、帧数、待导入数、待引用数
- **逐项进度**：`[当前/总数] item_id / 文件名 / 当前阶段`
- **阶段耗时**：压缩、调用 Gemini、抽帧、生成联系表、导入 Eagle、验证 Eagle 分别耗时
- **心跳输出**：外部 API、ffmpeg、批量导入等可能长时间等待的阶段，至少每 30 秒输出一次 `still running`、当前对象和已耗时
- **完成摘要**：成功/失败/跳过数量、失败原因、Eagle 目标路径、验证结果

运行方式要求：

- Python 脚本必须使用无缓冲输出：`python -u`，或在脚本内使用 `flush=True`
- 调用 Gemini 前必须先打印模型名、视频 id、压缩后大小；返回后打印耗时和识别产品数
- 抽帧时必须打印每个视频请求帧数、实际保存帧数、输出目录
- 导入 Eagle 时必须打印目标完整路径、folderId、新 item id、尺寸、folders，并用 `/api/item/info` + `/api/item/list` 双重验证
- 禁止启动长任务后只等待结果、不持续汇报；当前窗口必须能看到进度，否则视为流程违规
- 如果任务被取消，必须明确汇报：已完成到哪一步、哪些文件/Eagle 项已写入、哪些未执行

## 强制执行规则 · Eagle 是唯一交付区

所有需要卡卡用眼睛确认的图片产物，必须导入或引用回 Eagle 对应供应商/产品文件夹。本地文件、md/json 报告、控制台路径只算过程记录，不算交付。

必须回到 Eagle 的产物包括：

- 原始照片联系表
- 视频分析后抽出的代表帧
- Flash/Pro 或其他模型对比用联系表
- 当前窗口视觉复检用拼图、候选图、证据图
- 产品主参考、多角度补充、细节价签、场景组合参考
- 需要卡卡判断的候选产品或不建夹证据

交付要求：

- 必须给出 Eagle 完整路径、folderId、打开链接。
- 必须在 Eagle 中创建或复用明确的交付/待确认文件夹，例如 `_视觉复检重分结果_待确认`。
- 必须把图片导入或通过 folder-linker 引用到对应 Eagle 文件夹。
- 必须通过 `/api/item/info` 和 `/api/item/list` 验证 item 确实在目标文件夹。
- 禁止只生成本地 `visual_cross_check.md/json`、`contact_sheet.jpg`、`frames/*.jpg` 后让卡卡自己去文件系统查看。

## 流程总览

```text
┌──────────────────────────────────────────────────────────────┐
│ Step 0  Eagle 文件夹定位（强制）                              │
│         /api/folder/list 递归 → 完整路径 + folderId + URL     │
└──────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────┐
│ Step 1  直接视频分析（analyze_supplier.py）                    │
│         完整视频 → Gemini → analysis.md + analysis.json        │
│         禁止先抽帧再发图识别；frames 只可后续辅助              │
│         卡卡可逐视频审查每款产品                              │
└──────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────┐
│ Step 2  全素材产品盘点 + 建文件夹                               │
│         视频分析 + 代表帧 + 原始照片 → 确定完整产品清单         │
│         输出 products_draft.md/json + 联系表 → 必须导入 Eagle  │
│         卡卡确认 → 建 P* 子夹                                   │
└──────────────────────────────────────────────────────────────┘
                            ↓
                    ⏸ 卡卡审查确认
                            ↓
┌──────────────────────────────────────────────────────────────┐
│ Step 3  Eagle 落地（确认后执行）                               │
│         建产品子文件夹 + folder-linker 给原 item 加文件夹引用  │
│         不移动、不复制、不进回收站 + apply_report.md           │
└──────────────────────────────────────────────────────────────┘
                            ↓
              提醒卡卡：打开 folder-linker 执行引用并复核
```

## Step 0 · Eagle 文件夹定位（强制）

任何动作前先按 `eagle-folder-ops.md` 第 2 节定位目标文件夹。汇报必须包含：

- **Eagle 完整路径**：从根开始（如 `展商家具 > 2026 > 佛山 > 0320 展会 > 歌宝婷`）
- **folderId**
- **打开链接**：`http://localhost:41595/folder?id=<folderId>`
- **`iconColor` + `icon` 标记**：每个候选文件夹和每个子文件夹都必须列出，缺失就标 `[无标记]`（语义见 `eagle-folder-ops.md` §11，禁止自己揣测）

同名文件夹超过 1 个时，停止写操作，列候选让卡卡确认。

读 item 用 `GET /api/item/list?folders=<folderId>`，**不要用 `folderId=<...>`**（后者返回混合结果）。

> **API 调用强规则**：在终端 inline 调 Eagle API 时禁用 `curl` / `Invoke-WebRequest` / `Invoke-RestMethod`（中文+大 JSON 卡终端），必须用 Python `urllib.request` 写文件再读字段。脚本文件里可以用 `httpx`/`requests`。完整规则见 `eagle-folder-ops.md` §1.1。

## Step 1 · 视频分析

**这是必做步骤**，不能跳过。视频里的产品信息必须先用 Gemini 直接看视频分析出来，落到本地 `analysis.md`，卡卡才有依据审查。

### 核心原则（2026-05-09 修正）

- ✅ Step 1 必须是：**压缩视频 → 将完整视频以 `data:video/mp4` 直接发给 Gemini → 输出 `analysis.md/json`**
- ❌ 禁止把 `analyze_supplier_v3.py` 当作 Step 1 默认入口
- ❌ 禁止先抽帧，再把图片发给 VLM 做产品识别
- ❌ 禁止为了产品合并默认跑 `supplier_product_scout.py --force-vlm` 抽缩图识别
- ✅ 如需抽代表帧，只能在视频分析完成后作为辅助材料；不得替代视频分析

### 工具

- 主工具：`D:\2026AI\tools\analyze_supplier.py`
- 也可用 Eagle 插件 video-analyzer（`D:\2026AI\eagle-plugins\video-analyzer`）UI 触发
- `D:\2026AI\tools\analyze_supplier_v3.py` 只作为后续“按分析结果抽代表帧/生成预览 HTML”的可选辅助，不是本步骤默认工具

### 通道

- **77code 渠道固定**：`https://code.77code.fun`
- **模型**：`gemini-3-flash`（首选，速度快质量够），不可用时再人工决定是否 fallback
- **Key**：从中央记忆 `ad6c6a87-346f-45ae-8d4a-0930b45fc32b` 取（不写死在 workflow）

### 命令

```powershell
$env:GCLI_BASE='https://code.77code.fun'
$env:GCLI_KEY='<从中央记忆 ad6c6a87-346f-45ae-8d4a-0930b45fc32b 取>'
$env:EXH_MODEL='gemini-3-flash'

D:\gcli2api\.venv\Scripts\python.exe D:\2026AI\tools\analyze_supplier.py `
  --folder-id <FolderId> `
  --supplier <供应商名> `
  --no-frames `
  --resume
```

说明：

- `--no-frames`：本步骤只做“直接视频分析”，不抽帧（抽帧放到 Step 1.5）
- `--resume`：已完成的视频跳过
- 默认会写回 Eagle annotation/tags（产品摘要 + 品类标签），方便卡卡在 Eagle 里一眼看到分析结果
- 如果确实不想写回，加 `--no-eagle-write`

### 产出

每个视频在供应商输出目录的 `videos\<eagle_id>\` 下。PC2 当前常见路径：

```text
D:\2026AI\eagle-plugins\suppliers\<safe_supplier_name>\videos\<eagle_id>\
```

以脚本日志里的 `输出目录` 为准。每个视频至少应有：

- `analysis.md` — 卡卡风格考察报告（视频概要、产品列表、卡卡评价、核心卖点）
- `analysis.json` — 结构化版
- `compressed.mp4` — 压缩后视频

### 已分析视频跳过

`analysis.md` 存在时，表示这个视频已经完成直接视频分析。若需要重跑：

- 优先删除/备份对应 `videos\<eagle_id>\analysis.md/json` 后重跑
- 或加脚本支持的“不续跑/强制重跑”参数
- 不要因为已有 `frames_v3.json` 就判断 Step 1 完成；Step 1 权威产物是 `analysis.md/json`

### 禁止误用 v3 抽帧链路

`analyze_supplier_v3.py` 的行为是：

- 先让 Gemini 分析视频得到产品段
- 再按产品段抽帧
- 再把候选图片发给模型选代表帧
- 可能导入 Eagle 预览帧/HTML

这条链路适合“做视频报告缩略图/抽帧预览”，**不适合作为产品合并第一步**。如果误启动，应立即停止，不要继续让它发图选帧。

如果后续确实要抽帧，必须显式低风险运行：

```powershell
$env:EXH_MODEL='gemini-3-flash'
$env:FRAME_RESELECT_MODEL='gemini-3-flash'
D:\gcli2api\.venv\Scripts\python.exe D:\2026AI\tools\analyze_supplier_v3.py `
  --folder-id <FolderId> `
  --supplier <供应商名> `
  --model gemini-3-flash `
  --parallel 1
```

并且要先说明：这是“抽代表帧辅助”，不是 Step 1。

### 卡卡审查点

- 直接看每个视频的 `analysis.md`
- 确认产品列表、卡卡评价、时间段是否准确
- 标记需要重跑的视频或需要人工修正的产品名

## Step 1.5 · 补抽代表帧（视频分析完成后）

**这一步在 Step 1 视频分析完成后执行**，目的是为每个已识别产品补抽多角度代表帧，让卡卡在 Eagle 里能直接看到产品完整外观。

### 为什么需要这一步

- Step 1 只做视频 → Gemini 分析，不抽帧，产出是文字报告
- 但产品合并（Step 2）和后续电商出图都需要看到产品的多角度照片
- 视频里的产品信息比现场照片更完整（有正面、侧面、特写、手部演示等），必须从视频里抽出来

### 工具

`D:\2026AI\tools\analyze_supplier_v3.py`（此时作为抽帧辅助工具，不是 Step 1 入口）

### 命令

```powershell
$env:GCLI_BASE='https://code.77code.fun'
$env:GCLI_KEY='<从中央记忆取>'
$env:EXH_MODEL='gemini-3-flash'
$env:FRAME_RESELECT_MODEL='gemini-3-flash'

D:\gcli2api\.venv\Scripts\python.exe D:\2026AI\tools\analyze_supplier_v3.py `
  --folder-id <FolderId> `
  --supplier <供应商名> `
  --model gemini-3-flash `
  --parallel 1
```

### 产出

每个视频在 `videos\<eagle_id>\` 下新增：

- `frames_v3\*.jpg` — 按产品段选出的代表帧（多角度）
- `frames_v3.json` — 帧元数据（产品编号、角度描述、时间戳）
- `compare_v1_v2_v3.html` — 对比预览 HTML
- Eagle 子文件夹：分析报告 + 代表帧会导入到 Eagle 对应视频子文件夹

### 注意

- 必须在 Step 1 视频分析完成后执行（因为 v3 会复用已有的 `analysis.md`）
- 必须用 `gemini-3-flash` + `parallel 1`，不能高并发
- 抽帧结果导入 Eagle 后，卡卡可以在 Eagle 里直接看每个产品的多角度截图

## Step 2 · 全素材产品盘点 + 建文件夹

### 核心原则

> **不能只看视频分析报告。** 必须综合以下所有素材来确定完整产品清单：
> - 视频分析报告（`analysis.md/json`）— 产品概要、卡卡评价
> - 代表帧（`frames_v3/*.jpg`）— 产品多角度截图
> - **原始照片**（Eagle 父文件夹里的照片 item）— 可能包含视频里没出现的产品
>
> 原始照片里可能拍到视频里没有的独立产品、不同配色/配置、配件/茶具/摆件等。
> 漏掉 = 后续无法出电商图。

### 工作流程

#### 2.1 收集所有素材信息

1. **视频分析结果**：读取每个 `analysis.md`，提取产品 #、品类、名称、卡卡判断
2. **代表帧**：浏览 `frames_v3/` 多角度截图，确认视频产品外观
3. **原始照片盘点**：
   - 用 `/api/item/list?folders=<folderId>` 拉照片清单
   - 生成照片联系表 `contact_sheet_photos.jpg`（带 item id + 文件名标注）
   - **逐张查看**照片里拍的是什么产品
   - 特别关注：视频里没出现但照片里有的产品

#### 2.2 确定完整产品清单

- 跨视频 + 跨照片合并同款产品
- 同款不同颜色/材质/尺寸 → 拆成不同产品
- 视频里有但照片里没有的 → 仍算产品（后续从代表帧出图）
- 照片里有但视频里没有的 → 也算产品（不能遗漏）
- 标注每个产品的 `worth_ecommerce`
- 标注每个产品的素材来源：`eagle_item_ids`（照片）+ `video_frame_ids`（代表帧）

#### 2.2b 帧 vs 照片去重比对（必做）

> 视频的核心价值 = 卡卡口头评价 + 产品信息记录（尺寸/价格/触感/判断）。
> 抽帧只是其中一个辅助功能，不等于最佳素材。

对每个产品，比对代表帧和原始照片：

- **同一产品同一角度**：选分辨率更高、更干净（无手指/人物/杂物）的那张
- **照片通常优于帧**：原始照片分辨率（如 2304×4096）远高于视频帧
- **帧有独立价值的场景**：产品只在视频中出现、照片完全没拍到
- 输出：每个产品标注 `出图用 = 照片/帧/两者`，附原因

#### 2.2c 跨文件视觉检查（提图到产品文件夹前强制）

在把照片/帧引用到每个 `P* / 01_出图主参考` 前，必须做一次跨文件视觉检查。不能只按 `products_draft.md` 里的 `照片编号` 机械分配。

执行责任：

- **默认执行者：当前对话窗口里的阿奇**  
  必须在当前 Cascade/对话窗口里直接读取联系表、候选拼图、原始图片或截图，做独立视觉判断。
- **脚本只负责整理材料，不负责裁判**  
  脚本可以生成联系表、候选拼图、item 索引、待检查清单，但不能把“是否同款/是否错分/是否漏分”的最终判断交给脚本自动完成。
- **卡卡只处理不确定项**  
  阿奇在当前窗口先完成可判断部分；只有同款/错分/漏分无法确定时，才把少量候选图和问题列给卡卡确认。
- **禁止把整批图片丢给卡卡人工重看**  
  卡卡审查的是结论和少量疑点，不是替阿奇做全量分类。

推荐执行形态：

- 读取 `products_draft.md/json`。
- 读取供应商父文件夹 item 列表。
- 生成/复用 `contact_sheet_photos.jpg`。
- 必要时生成每个 P 产品的候选拼图，例如：
  - 左侧：draft 指定照片编号
  - 中间：文件名前后相邻照片
  - 右侧：同视频/同时间段代表帧
  - 底部：未分配但视觉相似的照片
- 当前对话窗口直接读取这些图片进行视觉判断。
- 对每个 P 产品构造候选集：
  - draft 里的照片编号
  - 文件名前后相邻照片
  - 同视频/同时间段代表帧
  - 未分配但视觉相似的照片
- 输出同款/非同款/不确定。
- 人工只复核 `uncertain` 项。

禁止事项：

- 禁止“同一个自动流程先分组、再自己视觉检查自己”，这不是独立审查。
- 禁止脚本调用视觉模型后直接把结果当最终结论。
- 如果使用脚本/API 视觉模型，只能作为候选建议；最终检查结论必须由当前对话窗口独立看图确认。
- 如果当前窗口没有看到图片本身（只有文件名、item id、JSON），禁止宣布视觉检查完成。

效率策略：

- 小供应商（≤20 张照片）：当前窗口直接看联系表 + 必要原图，通常可接受。
- 中等供应商（20-60 张照片）：先看联系表做粗审，再只打开疑似错分/多产品场景/主参考候选原图。
- 大供应商（>60 张照片）：必须先生成按产品分组候选拼图，当前窗口逐组审，不逐张裸看。
- 如果抽查前 5 个 P 产品中错分/空夹/无视觉证据超过 20%，立即停止批量引用，回到当前窗口重做视觉检查，不继续机械执行。

检查范围：

- 供应商父文件夹下所有原始照片
- 视频代表帧 `frames_v3/*.jpg`
- 联系表 `contact_sheet_photos.jpg`
- 已生成的 `products_draft.md/json`

检查目标：

1. **同款跨文件合并**：同一产品可能出现在多张照片、多个视频帧、不同角度里，必须合并到同一个 P 编号。
2. **错分检查**：确认每个照片编号确实是该 P 产品，不是旁边产品、组合场景、品牌门头、价签、软装或背景。
3. **漏分检查**：逐张照片看是否有 draft 没提到的独立产品；有则新增 P 编号或标 `_Excluded（待审核）`。
4. **主参考选择**：优先选主体完整、角度正、无遮挡、清晰度高、无人物/价签干扰的图进 `01_出图主参考`。
5. **多角度补充**：同款但非最佳主参考的角度图，进 `02_多角度补充`，不要全部塞进主参考。
6. **细节/价签**：材质特写、价格牌、型号牌、尺寸信息进 `03_细节价签信息`。
7. **场景组合**：多个产品组合场景、不适合单品出图但有搭配参考价值的，进 `04_场景组合参考`。
8. **空夹拦截**：视频里提到但没有照片/代表帧支撑的产品，不允许直接建空 P 文件夹；先进入 `candidate_products` 或 `_待确认产品`。
9. **多产品场景拦截**：一张图里有多个产品时，不能把整张图同时塞进多个产品的 `01_出图主参考`；只能放 `04_场景组合参考`，除非图中某个产品主体非常明确。

执行要求：

- 必须输出两个文件：

```text
D:\2026AI\eagle-plugins\suppliers\<供应商>\visual_cross_check.md
D:\2026AI\eagle-plugins\suppliers\<供应商>\visual_cross_check.json
```

- `visual_cross_check.md` 给卡卡看结论和疑点。
- `visual_cross_check.json` 给后续生成 folder-linker 队列使用，里面必须明确每张图的目标：

```json
{
  "P1": {
    "main_refs": ["item_id_1"],
    "multi_angle": ["item_id_2"],
    "detail_info": ["item_id_3"],
    "scene_refs": [],
    "excluded": [
      {"item_id": "item_id_4", "reason": "不是同款"}
    ],
    "uncertain": [
      {"item_id": "item_id_5", "question": "疑似同款不同角度，需卡卡确认"}
    ]
  }
}
```

同时必须有一个顶层字段记录不建夹/待确认产品：

```json
{
  "candidate_products": [
    {
      "pid": "P5",
      "name": "灰色流线型异形沙发",
      "reason": "仅视频文字提到，当前没有可见照片或代表帧支撑，暂不建空文件夹"
    }
  ]
}
```

- 每个 P 产品至少输出一条视觉检查结论：

```text
P1 <产品名>
- 主参考: 照片编号 3, 5（原因：主体完整/角度正/清晰）
- 多角度: 照片编号 8（原因：侧面补充）
- 排除: 照片编号 2（原因：不是同款/被遮挡/价签为主）
- 是否需要新增产品: 否
```

- 如果视觉检查发现 `products_draft.md` 的照片编号错了，必须先修 draft 或生成修正清单，再生成 folder-linker 队列。
- 如果不能确认某图属于哪个产品，禁止强行引用到 P*；先放 `_Excluded（待审核）` 或停下来让卡卡确认。
- 如果 `visual_cross_check.json` 存在，后续引用队列必须以它为准，不再直接按 `products_draft.md` 的照片编号生成。
- 如果一个产品没有 `main_refs`、`multi_angle`、`detail_info`、`scene_refs` 任何可见素材，禁止建 P 文件夹。
- 完成后才能进入 Step 2.4 建文件夹/引用。

#### 2.3 产出 products_draft

输出位置：

```text
eagle-plugins\suppliers\<供应商>\products_draft.md   — 给卡卡审查
eagle-plugins\suppliers\<供应商>\products_draft.json  — 结构化
```

每个产品至少包含：

- `product_id`: P1, P2, ...
- `name`: 产品中文名（含材质/颜色特征）
- `category`: 品类
- `worth_ecommerce`: true/false
- `source`: 视频/照片/两者都有
- `eagle_item_ids`: 关联的照片 item ID 列表
- `video_eagle_ids`: 出现在哪些视频中
- `confidence`: high/medium/low
- `notes`: 备注

#### 2.3b 第一阶段产物必须回传 Eagle

第一阶段（视频分析 + 照片联系表 + 产品草稿）完成后，不能只把文件留在本地目录。必须把卡卡要审查的产物导入 Eagle 对应供应商父文件夹：

```text
目标 Eagle 路径: <展会> / <供应商父文件夹>
目标 folderId: 供应商父 folderId
```

必须导入：

- `products_draft.md` → 命名：`<供应商名> · 产品清单`
- `contact_sheet_photos.jpg` → 命名：`<供应商名> · 照片联系表`
- 可选：`products_draft.json` → 仅调试/结构化备份时导入

这里导入的是**本地新产物**，允许使用 HTTP `POST /api/item/addFromPath`，但导入后必须验证：

```python
r = httpx.post('http://localhost:41595/api/item/addFromPath', json={
    "path": r"D:\2026AI\eagle-plugins\suppliers\<供应商>\products_draft.md",
    "folderId": "<供应商父folderId>",
    "name": "<供应商名> · 产品清单",
    "tags": ["产品清单", "自动生成"]
})
```

验证要求：

1. `/api/item/info?id=<新itemId>` 能读到新 item。
2. `/api/item/list?folders=<供应商父folderId>` 能看到 `产品清单` / `照片联系表`。
3. Eagle UI 当前供应商父文件夹里能看到这两个文件。

禁止事项：

- 禁止只说“本地已生成”就结束第一阶段。
- 禁止把 `products_draft.md` 只留在 `D:\2026AI\eagle-plugins\suppliers\...` 让卡卡自己找。
- 禁止把已有 Eagle 原始照片用 `addFromPath` 导入产品文件夹；已有图分配必须走 folder-linker 引用。

#### 2.4 卡卡确认 → 建文件夹

⏸ **products_draft.md 必须展示给卡卡审查**，确认后直接建 P* 子文件夹。

建文件夹规则：
- `worth_ecommerce=true` 且通过当前窗口视觉检查、有可见素材的产品 → 建 `P1 <产品名>`, `P2 <产品名>`, ...
- 只有视频文字描述、没有照片/代表帧支撑的产品 → 不建空 P 文件夹，进入 `candidate_products` 等待补帧或卡卡确认
- `worth_ecommerce=false` 的不建夹，或统一归 `_Excluded（待审核）`
- 用 `POST /api/folder/create` 在父文件夹下建
- 每个 P* 产品文件夹下必须建参考子文件夹：
  - `01_出图主参考`
  - `02_多角度补充`
  - `03_细节价签信息`
  - `04_场景组合参考`
- 建完后生成 folder-linker 队列，通过 folder-linker 插件给原 item 加文件夹引用
- 供应商原始照片的产品主参考默认引用到 `P* / 01_出图主参考`

#### 2.5 出图规则（通用）

出电商图时，参考素材（照片/帧）中以下元素必须去除：

- ❌ 价格标签/价签贴纸
- ❌ 人物（手指、脚、身体）
- ❌ 软装（茶具、花瓶、摆件、桌旗、靠枕等装饰物）
- ❌ 展会环境（紫色地毯、白色展墙、灯光等）

保留：
- ✅ 产品结构、造型、材质纹理
- ✅ 展示柜/博古架/展示架类产品可**单独出图**，也可**组合茶桌+茶椅一起出图**

#### 2B 兜底模式：`supplier_product_scout.py --force-vlm`（默认禁止）

只有在以下情况才允许使用：

- 没有视频，只有大量照片
- Step 1 视频分析不可用
- 卡卡明确要求快速粗分

风险：

- 无 analysis.md 让卡卡审查
- 视频信息被压缩到 9 帧，细节丢失
- 长视频里多产品段容易混淆
- 容易把“先抽帧再识别”误当标准流程

### 产出

标准模式产出：

- `products_draft.md` — 给卡卡看
- `products_draft.json` — 结构化（后续 apply 用）
- `contact_sheet_photos.jpg` — 照片联系表（如有照片）

如果使用兜底模式，则产物仍在 `backend\outputs\supplier_scouts\<供应商>\` 下。

### 卡卡审查点

打开 `products_draft.md`，确认：

- 产品分组是否合理（同款不同色 = 不同产品）
- `worth_ecommerce` 字段标对没（不值得做的设 false）
- 产品名是否需要调整
- 有没有遗漏或误分

⏸ **不获得卡卡确认前，禁止进入 Step 3。**

## Step 3 · Eagle 落地（apply_scout_plan.py）

### 工具

`backend/apply_scout_plan.py`

### 流程

1. dry-run 输出 apply_plan.md（默认）
2. 卡卡 review 计划
3. `--apply` 真实执行：
   - HTTP `POST /api/folder/create` 在父文件夹下建产品子文件夹（`P1 黑色真皮三人位直排沙发`）
   - 在每个产品文件夹下建 `01_出图主参考` 等参考子文件夹
   - 生成 folder-linker 队列 JSON 到 `D:\2026AI\.runtime\folder_link_queue`
   - 通过 Eagle **folder-linker** 插件给原 item 增加目标文件夹引用
   - 原始 item **不移动、不复制、不进回收站**
4. 验证：重新读 `/api/folder/list` + `/api/item/info?id=<原图itemId>` + `/api/item/list?folders=<目标folderId>`，确认目标子夹可见
5. 输出 `apply_report.md` + `apply_outcome.json`

### 命令

> 注意：`apply_scout_plan.py` 当前只接受含 `products_draft.json + assets_index.json + scout_meta.json` 的 apply bundle。  
> 如果 Step 2 使用标准模式手工/规则生成在 `eagle-plugins\suppliers\<供应商>\products_draft.*`，必须先补齐 apply bundle 或使用专门的落地脚本，不要直接拿普通草稿目录硬跑。

```powershell
# dry-run 看计划
python backend/apply_scout_plan.py --scout-dir backend/outputs/supplier_scouts/<供应商>

# 真正执行（建文件夹 + 生成引用任务 JSON）
python backend/apply_scout_plan.py --scout-dir backend/outputs/supplier_scouts/<供应商> --apply

# 跳过 worth_ecommerce=false 的产品（不为它建夹）
python backend/apply_scout_plan.py --scout-dir ... --apply --skip-low-worth
```

执行后会生成 folder-linker 队列文件，然后在 Eagle 里打开 **folder-linker** 插件完成引用。

### 关键设计（v2 引用模式）

- **不复制、不移动、不进回收站**：原始 item 通过 Eagle 插件 SDK 加 folder 引用，同时出现在父文件夹和产品子文件夹中
- **已有 Eagle 原图只允许引用**：禁止用 HTTP `addFromPath` 把原图重新导入产品文件夹；那是复制副本，不是引用
- **主参考落点**：产品对应照片默认引用到 `P* / 01_出图主参考`，不是只放在 P* 根目录
- **去重**：item 多归属时只主属第一个 plan，后续 plan 不重复引用
- **空 plan 跳过**：素材完全被前面 plan 抢光的 plan 不建空夹
- **复用已有子文件夹**：检测到同名子文件夹直接复用，不重建
- **Excluded 子夹**：标牌、品牌门头、纯背景帧自动归到 `_Excluded（待审核）`
- **未归类 item**：留在父文件夹不动

### 执行两步

1. **Step A** (Python): `apply_scout_plan.py --apply` 或专用落地脚本 → HTTP API 建子文件夹 + 输出 folder-linker 队列 JSON
2. **Step B** (Eagle 插件): 打开 `文件夹引用 / folder-linker` 插件 → 监听 `D:\2026AI\.runtime\folder_link_queue` → 批量 `eagle.item.modify` 加引用
3. **Step C** (验证): 重新扫描期望关系，确认 `应有引用 = 已到位`，`缺失 = 0`

### folder-linker 队列格式（强制）

```json
{
  "supplier": "供应商名",
  "tasks": [
    {
      "item_id": "原始照片 item id",
      "add_folders": ["01_出图主参考 folderId"]
    }
  ]
}
```

队列目录：

```text
D:\2026AI\.runtime\folder_link_queue
```

插件处理完成后会移动到：

```text
D:\2026AI\.runtime\folder_link_queue\done
```

并生成：

```text
*_result.json
```

### 引用验证脚本逻辑（强制）

每次引用完成后必须重新计算期望关系并验证：

```text
products_draft.md 的 照片编号
  → 供应商父文件夹按联系表排序后的原始照片 item id
  → 对应 P* / 01_出图主参考 folderId
  → item/info.folders 必须包含目标 folderId
  → item/list?folders=<目标folderId> 必须能看到原始 item id
```

收尾指标必须是：

```text
应有引用: N
已到位: N
缺失: 0
```

如果缺失不为 0，只能继续生成 folder-linker 补队列，不能改用 `addFromPath` 复制。

### 误复制副本处理（事故流程）

如果误用 HTTP `addFromPath` 把已有 Eagle 原图复制到了产品文件夹：

1. 立刻停止复制导入。
2. 先用 folder-linker 给原图补真实引用。
3. 验证 `应有引用 = 已到位`、`缺失 = 0`。
4. 生成副本清单，字段必须区分：
   - `duplicate_item_id`：误复制出来的新 item
   - `original_item_ids`：原图 item，绝对不能动
5. 得到卡卡明确确认后，只把 `duplicate_item_id` 批量 `moveToTrash`。
6. 回收站可恢复，禁止永久删除。

## 收尾汇报格式

每次 Step 3 完成必须给卡卡：

```text
✅ <供应商> 落地完成
- Eagle 完整路径: ...
- 父 folderId: ...
- 建子文件夹: N 个（产品 + Excluded）
- 引用 item: M 个
- folder-linker 队列: D:\2026AI\.runtime\folder_link_queue\...
- 引用验证: 应有 N / 已到位 N / 缺失 0
- 报告路径: backend\outputs\supplier_scouts\<供应商>\apply_report.md
- 下一步: 卡卡在 Eagle 审查 products_draft.md、照片联系表、P*/01_出图主参考
```

## 重要约束（项目硬规则）

- ❌ 不直接改 Eagle library 的 `metadata.json`、`tags.json`、`mtime.json`
- ❌ HTTP `/api/item/update` 改 `folders` 不可靠（返回 200 但不生效），必须用 Eagle 插件 SDK
- ❌ HTTP `addFromPath` 会复制新 item，不能用于“把已有原图放进产品文件夹”
- ❌ Eagle item 和文件夹默认不删；清理误复制副本必须先列清单并得到卡卡确认，只能进回收站
- ✅ HTTP `/api/item/update` 可改 `isDeleted` 字段（从回收站还原）
- ✅ 给 item 加 folder 引用用 Eagle 插件 SDK: `eagle.item.getById(id)` → `itemObj.folders = [...]; await itemObj.save()`
- ✅ 所有 `products_draft.md/json` 和 `apply_plan.md` 必须先给卡卡审查再 apply
- ✅ 第一阶段完成后，`products_draft.md` 和 `contact_sheet_photos.jpg` 必须导入 Eagle 供应商父文件夹并验证

## 与其他工作流的关系

- 完成本工作流后，沙发供应商进入 `sofa-product-image-gen.md` 第二步开始电商图生成
- 餐椅、茶几等其他品类后续可建对应专属 workflow，本工作流到 Eagle 分拣完成为止
- 文件夹安全规则统一引用 `eagle-folder-ops.md`

## 已知 TODO

- [ ] 后续可补脚本化标准合并：从 `analyze_supplier.py` 产物读取 `analysis.md/json` + 照片 item 清单，自动生成 `products_draft.md/json`
- [ ] 视频分析阶段失败重试机制（77code 偶发 502/429）
- [x] ~~apply 阶段 rollback~~ → v2 不再需要，原始 item 不移动不删除
- [x] folder-linker Eagle 插件已实现（`D:\2026AI\eagle-plugins\folder-linker\`）
- [x] flash 选帧回退逻辑修复（`rerun_frames_v3.py`）：失败时按 center_sec 就近选帧 + per-product 去重，不再所有 shot 退到同一帧
- [x] 帧质检关卡（`analyze_supplier_v3.py`）：导入 Eagle 前自动检查重复帧/sharpness=0/flash 失败率，不通过则阻断
