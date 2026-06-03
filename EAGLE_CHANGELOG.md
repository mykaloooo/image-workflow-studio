# Eagle 操作变更日志与踩坑记录

> **这是 Eagle 操作的权威本地副本**。中央记忆不可靠（115 服务器宕机、跨设备同步延迟、向量检索漏召回），所有 Eagle 相关的：
>
> - 新规则
> - 字段发现 / API 行为
> - 踩坑事故和事故复盘
> - 工具/插件改动
>
> 都必须 **先追加到本文件**，再考虑同步中央记忆。本文件是新窗口/新设备/新 AI 接手时的第一手依据。

## 写入规则（强制）

每条记录必须包含以下字段：

- **日期**（精确到日期，重要事故精确到时分）
- **类型**：`[规则]` / `[字段]` / `[踩坑]` / `[API]` / `[工具]` / `[决策]`
- **标题**：一句话概括（`[类型] 标题`）
- **详情**：现象 → 原因 → 解决方案 → 验证方式
- **同步**：哪些 `.windsurfrules` / workflow / GUIDE / 中央记忆已同步更新

**追加格式**：新记录写在最上面（最新在最前），不要插在中间。

**禁止事项**：

- 禁止把 Eagle 相关重要发现只写中央记忆不写本文件。
- 禁止删除历史记录（只能追加 `[修正]` 类型条目修订旧结论）。
- 禁止把多个无关改动塞进一条记录。

---

## 2026-05-14

### [规则] 批量生图写回 Eagle 必须带完整提示词和中文对照

**现象**：林泰红橡榻榻米床 V2/V3 详情页批量生成后，图片已导入 Eagle，但 annotation 只写了批次说明、模型、参考图和目标文件夹，没有写入每张图实际使用的完整提示词。回看时无法追溯“这张图到底用哪段 prompt 出的”，也无法复盘文字、卖点和图像不匹配的原因。

**原因**：临时脚本和 image-batch-gen 插件此前只把 prompt 保存在本地脚本、报告或插件任务面板里，未把“完整提示词”作为 Eagle item 的必填元数据。若未来使用英文 prompt，也没有强制提供中文对照，导致卡卡在 Eagle 里看图时无法直接判断图文逻辑。

**解决**：

1. 新增硬规则：所有批量生图导入 Eagle 时，item annotation 必须包含完整提示词。
2. 如果模型实际使用英文 prompt，annotation 必须同时包含中文版对照提示词；插件端阻止纯英文无中文提示词提交。
3. 插件 `D:\2026AI\eagle-plugins\image-batch-gen\logic.js` 新增 `buildGenerationAnnotation()`，统一写入：任务类型、模型、参数、来源/参考图、【中文对照提示词 / 原始面板提示词】、必要时再写【模型实际提示词】。
4. 林泰 V2/V3 已生成但缺完整 prompt 的 12 张图，需用 Eagle API 回填 annotation，并用 `/api/item/info` 验证。

**验证方式**：

- 插件：`node --check D:\2026AI\eagle-plugins\image-batch-gen\logic.js`
- Eagle 回填：逐个读取 `/api/item/info?id=...`，确认 `annotation` 包含 `【完整提示词】` 或 `【中文对照提示词 / 原始面板提示词】`。

**同步**：

- 本文件 ✅
- `.windsurfrules` 待同步
- `.windsurf/workflows/eagle-folder-ops.md` 待同步
- `EAGLE_FOLDER_GUIDE.md` 待同步
- 插件 `image-batch-gen` v0.1.20 待验证
- 中央记忆待同步

### [工具] image-batch-gen v0.1.18：独立供应商管理页 + 即时同步

**现象**：插件里点 `⚙ 供应商管理` 会 `window.open` 打开 Studio Web 但底层渲染整个 React App（画布 + ConfigPanel + 上面浮 SystemSettings modal），用户体验是"画布上又浮一个 modal"，跟在 Canvas 工具栏开 modal 一样麻烦。卡卡反馈"我不想再去无限画布那里管理了，太麻烦"。

**改动**（image-workflow-studio）：

1. `frontend/src/components/SystemSettings.jsx`：
   - 加 `variant='modal'|'page'` prop（默认 `'modal'` 向后兼容画布工具栏调用）
   - `variant='page'` 时：外层用 `system-settings-page > system-settings-page-inner`，标题改为「👥 供应商管理」，底部按钮改为「关闭窗口」
   - 保存成功后：page 模式不自动关窗（modal 仍保留 1.5s 自动关），同时 `window.opener.postMessage({type:'iws-providers-updated'}, '*')` 通知打开者刷新

2. `frontend/src/App.jsx`：
   - 新增 `viewMode` state，URL `?view=suppliers` 时设 `'suppliers'`
   - 渲染时 `viewMode === 'suppliers'` 直接渲染 `<SystemSettings variant='page' />`，**完全不渲染 Canvas/ConfigPanel/初始化要求**
   - `onClose` 优先 `window.close()`（window.open 弹窗允许），失败兜底跳 `/`

3. `frontend/src/styles/app.css`：加 `.system-settings-page` / `.system-settings-page-inner` 全屏样式（max-width 1100px、header/footer sticky）

**改动**（插件 `D:\2026AI\eagle-plugins\image-batch-gen\`）：

1. `logic.js:3180-3216` `openProviderManager`：
   - URL 从 `?settings=providers` 改成 `?view=suppliers`（用新独立页路由）
   - 拿到 `window.open` 返回的子窗口引用，`setInterval` 每 500ms 检测 `childWin.closed`
   - 关闭后立刻 `loadActiveModelAfterBackend()` 重拉 providers + toast
   - 5 分钟兜底清 interval 防止内存泄漏

2. `logic.js:5042-5050` bootstrap：加全局 `window.addEventListener('message', ...)` 监听 `iws-providers-updated`，保存即时同步（不用等关窗）

3. `manifest.json` v0.1.17 → **v0.1.18**
4. `index.html` script 缓存戳 `?v=20260514-source-fix` → `?v=20260514-supplier-page`

**同步机制双保险**：
- 即时同步：Studio 保存 → `window.opener.postMessage` → 插件立刻刷新（< 50ms）
- 兜底同步：用户关闭子窗口 → setInterval 检测 closed → 插件刷新

**验证**：
- `node --check D:\2026AI\eagle-plugins\image-batch-gen\logic.js` → OK
- esbuild transform `SystemSettings.jsx` / `App.jsx` → OK
- 实际验证：等卡卡 Eagle 重启后跑「⚙ 供应商管理」按钮（同时也是 D 盘单源 v0.1.17 → v0.1.18 的端到端验证）

**同步**：
- 本文件 ✅
- 中央记忆（待）
- `.windsurfrules` / workflow / GUIDE 无需更新（不涉及 Eagle 操作规则）

### [决策] eagle-plugins C 盘卸载，强制走 D 盘单源（image-batch-gen + wanx-batch-gen）

**背景**：5/11 截图发现两个 D 盘 + C 盘共存的插件实际跑 C 盘：
- C 盘 `kaka-image-batch-gen` v0.1.17（5/14 凌晨 copy 上去对齐 D 盘）
- C 盘 `kaka-wanx-batch-gen` v0.1.2（5/2 装的）

5/12 排查 GPT-Image-2 失败时一开始就是因为以为跑 D 盘 v0.1.16 在调，结果实际跑 C 盘 v0.1.14（API 错误信息显示不一样），耗了 1 小时才意识到。后来 D/C 同步到 v0.1.17 才避免再被坑。

**决策**：**长期走 D 盘单源**，C 盘 `%APPDATA%\Eagle\Plugins\` 彻底清空。

**执行**：完全退出 Eagle 后，move C 盘 → `D:\2026AI\eagle-plugins\_archive\c-plugins-backup-20260514\`：

```
kaka-image-batch-gen  v0.1.17  15 文件 618 KB → 备份
kaka-wanx-batch-gen   v0.1.2   4 文件  145 KB → 备份
```

`%APPDATA%\Eagle\Plugins\` 现已清空（0 个子目录）。

**意外发现**：C 盘 `kaka-wanx-batch-gen` 是 v0.1.2，而 D 盘 `image-batch-gen-wanx` 是 v0.1.3。Eagle 一直加载 C 盘 v0.1.2，导致 D 盘 v0.1.3 的改动从未生效（具体改动需后续比对）。

**优点**（D 盘单源）：
- 改 D 盘 logic.js 直接重启 Eagle 就生效（不用 robocopy）
- 不会再"以为改的 D 盘其实跑的 C 盘"
- 备份保留 1 周，回滚成本低

**验证**：等卡卡启动 Eagle，看 `log.log` 里 `Init plugin` 路径只剩 D 盘（无 C 盘），且 `Open plugin: 图片批量生成[0.1.18]` 正常加载即通过（v0.1.18 同时携带"独立供应商页"改动）。

**同步**：
- 本文件 ✅
- 中央记忆（待）

---

### [规则] image-batch-gen 入库三件套修复（违反 .windsurfrules 第 14/21-22/101 行）

**现象**：审计 `D:\2026AI\eagle-plugins\image-batch-gen\logic.js` 发现 `importToEagle` 函数三处违规：

1. HTTP fallback 路径用 `POST /api/item/update {id, folders:[...]}` 改文件夹（违反 `.windsurfrules:14` 和本文件已验证结论：folders 字段 HTTP 不可靠）
2. 完全没有 `.windsurfrules:21-22` 要求的"导入后必须用 /api/item/info + /api/item/list 双重验证"
3. SDK `eagle.item.modify` 失败被 `try { ... } catch (_) {}` 静默吞，意味着唯一可靠的改 folders 路径出错时日志看不到，用户只看到 "✓ 成功" 实际图没到目标文件夹

**原因**：插件最初按"成功率高就行"写，没追到本仓库规则收敛后的最新结论。

**解决**（2026-05-14 凌晨改动）：

1. 新增 `verifyItemInFolder(itemId, folderId, retries, intervalMs)` 辅助函数（`logic.js:3890-3914`）：
   - 用 `GET /api/item/info?id=...` 校验返回的 `folders` 数组包含目标 folderId
   - 支持重试（默认 0 次，modify 后用 2 次 × 300ms 等异步落库）
   - 返回 `{ ok, item, actualFolders }`，失败时附带实际 folders 让上层抛错更清楚

2. 重写 `importToEagle`（`logic.js:3916-3998`）：
   - SDK 主路径：addFromPath → 第 1 次校验 → 不在目标则 SDK `eagle.item.modify` → modify 失败 `log warn`（不再吞）→ 第 2 次校验（2 次重试）→ 仍失败 `throw`
   - HTTP fallback：addFromPath body 一次性带 folderId → 直接校验 → 失败 `throw`（不再用 `/api/item/update` 二次改 folders）

3. 上层 `runQueuedJob` 的 try/catch 原本就会把 throw 算到 `item.queueStatus='failed'`，重发面板能直接看到失败项；用户不会再误以为"成功了但图不见了"。

**验证**：
- `node --check d:\2026AI\eagle-plugins\image-batch-gen\logic.js` 通过
- 跑批后可用 `/api/item/list?folders=<targetFolderId>` 复核应入 N 张 / 实际 M 张

**版本**：manifest v0.1.14 → v0.1.15（P0 中间产物，已打包 `image-batch-gen-v0.1.15.eagleplugin` 但未独立发布）→ v0.1.16（P0+P1 综合发布版，见下方 5/14 P1 条目）

**同步位置**：
- `D:\2026AI\eagle-plugins\image-batch-gen\logic.js` 第 3887-3998 行（已改）
- `D:\2026AI\eagle-plugins\image-batch-gen\manifest.json` 升 v0.1.16
- `EAGLE_CHANGELOG.md`：本条 + 下方 5/14 P1 条目
- `.windsurfrules`：无需改（本次按现有规则修复，不新增规则）
- 中央记忆：v0.1.15 已写入 `ee4bc1b0`；v0.1.16 待写
- PC1 同步：待卡卡确认是否推送到 J:\AI2026\ZL\projects\eagle-plugins\image-batch-gen

---

### [踩坑] image-batch-gen v0.1.17 补 task_meta.source 字段（v0.1.16 遗漏）

**现象**：v0.1.16 装载后卡卡验证 `generation_history.jsonl` 时发现：
- `machine_id: "pc2"` 本来就有（backend 从 `system_config.json` 取，不读插件文件）
- 插件加的 `task_meta.machine_id / plugin_id` **根本不会写入**

**原因**：查看 `@d:\2026AI\image-workflow-studio\backend\history_recorder.py:47` 确认两点：

1. `_VALID_SOURCES = ("canvas", "eagle_plugin", "script")` —— backend 只认这三个 source 值
2. `record_generation()` 从 `task_meta` 只读 6 个字段：`source / canvas_save_state / eagle_item_ids / canvas_node_id / batch_id / script_name`，**`machine_id / plugin_id / display_name / folder_id / annotation` 都不读**

插件历来没传 `task_meta.source = "eagle_plugin"`，导致所有插件生成的图在 jsonl 里 `source: "unknown"`，跟画布/脚本/其他客户端混在一起无法区分。违反中央记忆 `d39ad293` 要求的"三路 task_meta 打标"。

**解决**（`@d:\2026AI\eagle-plugins\image-batch-gen\logic.js:4506-4516`）：

```js
task_meta: {
  ...,
  auto_import_to_eagle: false,
  // 关键字段：backend history_recorder.py 只认 source ∈ ("canvas", "eagle_plugin", "script")
  source: 'eagle_plugin',
  // 前向兼容字段：backend 现在不读但以后 history_recorder.py 可能升级识别
  machine_id: MACHINE_ID,
  plugin_id: 'kaka-image-batch-gen',
}
```

**验证**：`node --check` 通过；装载 v0.1.17 后生成 1 张图，`generation_history.jsonl` 应该看到 `"source":"eagle_plugin"`（之前是 `"unknown"`）。

**版本**：v0.1.16 → v0.1.17

**同步位置**：
- `D:\2026AI\eagle-plugins\image-batch-gen\logic.js`（1 处 edit）
- `manifest.json` v0.1.17
- `index.html` 缓存戳 `20260514-source-fix`
- 包：`D:\2026AI\eagle-plugins\image-batch-gen-v0.1.17.eagleplugin`
- C 盘同步：`%APPDATA%\Eagle\plugins\kaka-image-batch-gen\`（已复制）
- 中央记忆：待写

**一个重要认知补漏**：Eagle 加载机制 —— D 盘 `D:\2026AI\eagle-plugins\` 是源码工作目录（Eagle **不读这里**），真正被 Eagle 加载的是 C 盘 `%APPDATA%\Eagle\plugins\<id>\`（Eagle 启动时只读这里）。Settings 里 `libraryDirs` 只含 L 盘/PC1 共享库，没有 D 盘 library。**以后所有插件改动都必须同步到 C 盘才生效**（双击 .eagleplugin 装包，或手动 copy 文件）。

---

### [规则] image-batch-gen v0.1.16 P1 防御性三项（machine_id / BOM provider 跌幅校验 / P* 拒建 gen）

**背景**：v0.1.15 P0 入库三件套修完后，按规则继续追加 P1 三项防御性优化合成 v0.1.16 统一发布。

**改动**（`D:\2026AI\eagle-plugins\image-batch-gen\logic.js`）：

1. **task_meta 加 machine_id + plugin_id**（中央记忆 d39ad293：历史聚合面板要求"三路 task_meta 打标"）
   - 顶部加 `const MACHINE_ID = require('os').hostname()` 常量
   - `runQueuedJob` 内 `payload.task_meta` 新增 `machine_id: MACHINE_ID, plugin_id: 'kaka-image-batch-gen'`
   - 跨机器查 Studio 历史聚合面板时能区分 PC1 vs PC2 来源

2. **BOM provider 数量跌幅校验**（中央记忆 d4feedaa：PC2 缺第 3 道防线，插件层补回来）
   - localStorage key `kaka-batch-gen-provider-count-peak` 存历史峰值
   - 阈值 0.5：当前数 < 峰值 * 0.5 且峰值 ≥ 4 时大声告警（`setStatus 'err' + log 'err'`）
   - 不阻断入队，只警告——如果 backend system_config.json 被 BOM 写坏静默 fallback 到 4 个示例 provider，卡卡能第一时间看见

3. **P* 产品成品文件夹禁建 gen 子目录**（遵守 `.windsurfrules:93-97`）
   - 新增 `isProductFinalFolderName(name)`：正则 `^P\d+(?![a-zA-Z0-9])` 匹配"P1"、"P12 红框定稿"、"P12-成品"，不误匹配"Photo"、"PC1"、"P12abc"
   - `ensureGenSubfolder` 开头检测 parentFolder 名是不是 P* 模式，是则 `throw`，强制让卡卡改选父级素材文件夹
   - 阻止"gen 临时图污染产品最终版目录"这一规则破坏面

**版本**：v0.1.15 → v0.1.16（最终发布版本）

**验证**：`node --check d:\2026AI\eagle-plugins\image-batch-gen\logic.js` 通过

**同步位置**：
- `D:\2026AI\eagle-plugins\image-batch-gen\logic.js` 顶部常量 + `loadActiveModel` + `ensureGenSubfolder` + `runQueuedJob` task_meta 共6 处 edit
- `manifest.json` v0.1.16
- `index.html` 缓存戳 `20260514-p1-bundle`
- 包：`D:\2026AI\eagle-plugins\image-batch-gen-v0.1.16.eagleplugin`
- 中央记忆：待写
- PC1 同步：待卡卡确认

**已知限制**：
- `machine_id` 用 Node `os.hostname()`，不依赖 Studio backend 配置（与 backend machine_id 独立）
- BOM 校验只告警不阻断，避免误判卡卡有意删 provider 的合理操作
- P* 检测仅按名字正则，不读 `iconColor`（将来扩展 `fetchEagleFolderTree` 保留 iconColor 时一并加）

---

## 2026-05-11

### [工具] image-batch-gen v0.1.13 加归档 localStorage 持久化

**现象**：5/10 上线的"任务结果面板（失败重发/已完成重生/取消还原）"在关闭插件窗口或重启 Eagle 后归档历史丢失，用户无法找回上一会话的失败项。

**原因**：archivedJobs 只放内存 `state.archivedJobs`，没落盘。

**解决**：
- 加 localStorage key=`kaka-batch-gen-archived-jobs`
- LRU 30 批上限，软上限 8MB（超出按从旧到新逐步丢弃）
- 新增 `persistArchivedJobs / loadArchivedJobs`；`archiveFinishedJob / clearArchivedHistory / enqueueResendJobs` 末尾各 persist 一次
- bootstrap 开头 `loadArchivedJobs()`
- Set 类（resultsExpanded / resultsCollapsed / resultsSelection）不持久化（重开默认最新展开、其余折叠、未选中）

**验证**：`node --check` 通过；本机关窗口重开历史保留 OK。

**版本**：v0.1.12 → v0.1.13

**同步位置**：
- `D:\2026AI\eagle-plugins\image-batch-gen\logic.js`（已改，5/11 02:00 完成 PC1 项目→PC2 Eagle 同步）
- `EAGLE_CHANGELOG.md`：本条（补漏）
- 中央记忆：`5e354ecf-b629-497e-85ac-4d5429ba196f`

---

## 2026-05-10

### [工具] image-batch-gen v0.1.10-v0.1.12 任务结果面板上线（补漏）

**现象**：批次跑完后失败项无处可见，用户要手动找日志。

**解决**：
- 批次跑完后保留 30 批历史（archivedJobs）
- 三 tab：❌失败 / ✅已完成 / 🗑取消，每批显示 prompt 和原参数
- 支持直接重发、编辑后重发（可改 prompt 或一键套用当前面板供应商参数）、取消回收站还原
- 等待队列里取消的项也进回收站（`archiveCancelledFromWaiting` 构造 phantom job）

**改动文件**：`index.html`（CSS + 面板 HTML + 对话框）、`logic.js`（archivedJobs 状态、archiveFinishedJob / renderResultsPanel / enqueueResendJobs / openResendDialog 等）

**验证**：`node --check` 通过

**版本**：v0.1.9 → v0.1.10 → v0.1.11 → v0.1.12（三个迭代版本，未单独发包）

**同步位置**：
- `D:\2026AI\eagle-plugins\image-batch-gen\logic.js / index.html`
- 中央记忆：`dbe98075-e7de-47a4-ad17-163a9604c90d`（含文档 https://api.kakahome.top/docs/MSh0VJcK.html）

---

### [工具] image-workflow-studio + image-batch-gen 端口 5001→5688 同步迁移（补漏）

**现象**：PC1 5/10 把 Studio 后端端口从 5001 改为 5688（避开常见占用），PC2 需要对齐。

**解决**：
- `backend/app.py`：`find_free_port` 默认 5688
- `vite.config.js`：proxy 改 5688
- 两个启动 bat：URL 改 5688
- Eagle 插件 image-batch-gen + image-batch-gen-wanx：
  - `logic.js` `normalizeStudioUrl` 加 5001→5688 自动迁移逻辑（旧用户的 localStorage 会被静默改写）
  - `index.html` input 默认值 5688 + `<script ?v=20260510-port5688>` 缓存戳
- su-prompt-toolkit：`canvas-bridge.js / output-agent.js / template-manager.js` 同步

**踩坑**：Eagle 实际加载插件路径是 `%APPDATA%\Eagle\plugins\<id>\`（`kaka-image-batch-gen` / `kaka-wanx-batch-gen`），不是 D 盘工作树；只改 D 盘文件 Eagle 看不到。装回插件后才生效。

**同步位置**：
- `D:\2026AI\eagle-plugins\image-batch-gen\logic.js`
- `D:\2026AI\image-workflow-studio\backend\app.py`
- 中央记忆：`05d38445-5edc-4af7-9878-a591b2c712a8`（任务单 hW1z2HvZ）

---

### [API] HTTP /api/item/update 改 annotation 字段可靠（补充结论）

**背景**：之前的记录只明确 `update` 改 `folders` 不可靠、改 `isDeleted` 可靠。本次批量清理 138 组重复验证了 **annotation 字段也可靠**。

**验证**：5/10 批量清理 138 组，共 **126 次** `POST /api/item/update {id, annotation:"..."}` 调用，每次写入后立即 `GET /api/item/info?id=...` 验证 `annotation` 字段字符级一致，**成功率 100%**。

**可用字段总结**（HTTP `/api/item/update`）：

| 字段 | 可靠性 | 来源 |
|---|---|---|
| `annotation` | ✅ 可靠 | 2026-05-10 验证 |
| `isDeleted: false` | ✅ 可靠 | 历史已记录 |
| `folders` | ❌ **不可靠**（返回 success 但未生效） | 历史已记录，必须走 `eagle.item.modify` SDK |
| `tags` | 未专门验证，按历史谨慎使用 | — |
| `star` | 未验证 | — |

**同步**：

- `EAGLE_FOLDER_GUIDE.md`：§HTTP API 章节补充 annotation 字段
- 中央记忆：待同步

---

### [API] HTTP /api/item/moveToTrash 可靠

**验证**：5/10 批量清理，共 **234 个 item** 通过一次性调用 `POST /api/item/moveToTrash {"itemIds":[...]}` 进回收站，后续 `GET /api/item/info?id=...` 检查 `isDeleted=true`，成功率 100%。

**用法**：

```python
import json, urllib.request
data = json.dumps({"itemIds": ["id1", "id2", ...]}).encode("utf-8")
req = urllib.request.Request(
    "http://localhost:41595/api/item/moveToTrash",
    data=data,
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=30) as r:
    print(json.loads(r.read()))  # {'status': 'success'}
```

**还原**：`POST /api/item/update {id, isDeleted: false}`（历史已记录可靠）。

**注意**：`moveToTrash` 只是软删，item 仍在 Eagle 库里（`isDeleted=true` 状态），`api/item/list` 默认不返回。要永久删除需卡卡在 Eagle UI 里清空回收站。

**同步**：

- `EAGLE_FOLDER_GUIDE.md`：§HTTP API 章节补充 moveToTrash
- 中央记忆：待同步

---

### [决策] 重复 item 清理工作流（folder-linker + HTTP update + moveToTrash）

**背景**：Eagle 库里历史遗留 234 个物理复制副本（同图不同 name，分散在多个文件夹），需清理回归"1 份原图 + 多 folder link"。

**标准工作流（可复用）**：

1. **发现重复**：扫描全库 item → 按指纹 `(size, ext, width, height)` 分组 → 仅保留 ext ∈ `{jpg,jpeg,png,webp,bmp,gif}` 且 size > 64KB 的组（避免 md/json 小文件 size 巧合误判）。
2. **选主 itemId**：优先 name 是原始拍摄名格式（`IMG_YYYYMMDD_HHMMSS`、`video_YYYYMMDD_HHMMSS`、`DSC*` 等）；否则选最简洁的产品语义名（排除含 "淘汰/v2/v3/弃用/被替代/初版/旧版" 关键字的）。取候选里 `btime` 最早的。
3. **生成动作**：
   - 副本 name ≠ 主 name → 追加 "曾用名: {name}" 到主 annotation
   - 副本 annotation 非空且 ≠ 主 annotation → 追加 "原 annotation: {...}" 到主 annotation
   - target_folders = 全组 folders 并集
   - 所有副本 itemId → moveToTrash
4. **fail-safe 执行**（分批，每步验证）：
   - Step 1: `update {annotation}` 每个 item 后立即 `info` 验证 annotation 一致
   - Step 2: 写 folder-linker 队列（只 add，不 remove），60s 内等队列处理完，验证 `folders` 包含目标
   - Step 3: 一次性 `moveToTrash`，验证 `isDeleted=true`
   - 任何一步失败立即终止，记录 `exec_log_*.json`
5. **备份**：执行前 dump 全部涉及 itemId 的完整元数据到 `.runtime/_dup_all_items.json`（支持还原）

**为什么不全程用 `eagle.item.modify`（SDK）**：SDK 只能通过 Eagle 插件调用，必须用插件加载新版本才能跑；HTTP `update` 改 annotation 已验证可靠，且不需要重启 Eagle，批量调度脚本更方便。

**为什么 folders 必须走 folder-linker 插件队列**：历史已验证 HTTP `update {folders:[...]}` 不可靠（返回 success 但未生效），唯一可靠路径是 `eagle.item.modify(id, {folders})`，走 Eagle 插件 SDK。folder-linker 插件通过监听 `D:\2026AI\.runtime\folder_link_queue\` 自动处理，只 add 不 remove（去重合并不需要 remove）。

**成果（2026-05-10）**：138 组 / 234 副本 / 0 异常，一次性跑通。相关脚本：

- 规则 + 计划生成：`.runtime/_plan_v3_original_name.py`
- 批次执行：`.runtime/_exec_batch.py "<supplier_batch>" [--apply]`
- 验证：`.runtime/_verify_batch.py "<supplier_batch>"`

**同步**：

- `EAGLE_FOLDER_GUIDE.md`：考虑新增"重复 item 清理"章节
- `.windsurf/workflows/`：考虑新增 `dedup-items.md` workflow
- 中央记忆：待同步

---

### [规则] 禁用终端 inline curl / Invoke-WebRequest 读 Eagle API

**现象**：PowerShell/Cascade 终端用 `curl http://localhost:41595/...` 或 `Invoke-RestMethod` 读 Eagle API 时，遇到 1MB+ 中文 JSON 会卡死，等待用户输入超时。

**原因**：

- PowerShell 里 `curl` 是 `Invoke-WebRequest` 别名，会做 HTML 解析。
- `Invoke-RestMethod` 解析 JSON 后输出嵌套对象到终端，中文+大体积容易卡。
- `curl.exe ... | python ...` 管道传 1MB+ 数据给 stdin 也会卡。

**解决**：

```powershell
# 第一步：urllib 写文件（不打印响应内容）
python -c "import urllib.request; open(r'D:\2026AI\image-workflow-studio\.runtime\_eagle_probe.json','wb').write(urllib.request.urlopen('http://localhost:41595/api/folder/list', timeout=10).read())"

# 第二步：单独 python 读文件，只打印需要字段
python -c "import json; d=json.load(open(r'D:\2026AI\image-workflow-studio\.runtime\_eagle_probe.json','r',encoding='utf-8')); print(len(d['data']), '个顶层文件夹')"
```

**验证**：在 Cascade 终端跑上面两步，秒级返回，不卡。

**同步**：

- `.windsurfrules`：加"读取 Eagle API 的强规则"节
- `.windsurf/workflows/eagle-folder-ops.md`：§1.1 新增
- `.windsurf/workflows/product-image-gen.md`：§0.5 加引用
- `.windsurf/workflows/supplier-product-analyze.md`：§Step 0 加引用
- `EAGLE_FOLDER_GUIDE.md`：§3.0 新增
- 中央记忆：`team_shared` ID `716ed6f7-4d5d-4c77-b904-6b4b0794d8a1`

---

### [字段] folder 节点的 iconColor + icon（卡卡的语义标记层）

**发现**：`/api/folder/list` 返回的每个 folder 节点可能带两个可选字段，是卡卡在 Eagle UI 里手动右键设置的标记，用来给 AI 下指令。

**字段定义**：

| 字段 | 含义 | 已观测取值 |
|------|------|-----------|
| `iconColor` | 文件夹颜色 | `red` / `blue` / `aqua`（Eagle UI 还支持 yellow/green/purple/pink/orange） |
| `icon` | 文件夹符号 | `upload`（上传箭头）/ `lightbulb`（灯泡）/ `excalmation`（**Eagle 拼错的 exclamation 感叹号**，匹配时按这个错拼） |

**当前库分布**（2026-05-10 扫描）：

- `iconColor=red`：124 个
- `iconColor=blue`：13 个
- `iconColor=aqua`：1 个
- `icon=lightbulb`：19 个
- `icon=excalmation`：2 个
- `icon=upload`：1 个

**两个字段可同时存在**（例如 `0317 龙江展/歌宝婷` 同时是 `iconColor=blue + icon=lightbulb`）。

**约束**：

- 列出 Eagle 文件夹给卡卡看时，必须把这两个字段一起带出来；缺失就标 `[无标记]`。
- 写文件夹的 API（`/folder/create`、`/folder/update`）**不支持**设置颜色/图标，只能由卡卡在 Eagle UI 右键设置。
- 字段大小写敏感：是 `iconColor` 不是 `iconcolor`，是 `excalmation` 不是 `exclamation`。
- **禁止 AI 自行揣测语义并据此执行写操作**；语义对照由卡卡口头/明确指定。

**语义对照表**（**待卡卡填**）：

| 标记 | 语义 | 触发动作 |
|------|------|---------|
| `iconColor=red` | 待卡卡定义 | — |
| `iconColor=blue` | 待卡卡定义 | — |
| `iconColor=aqua` | 待卡卡定义 | — |
| `icon=lightbulb` | 待卡卡定义 | — |
| `icon=excalmation` | 待卡卡定义 | — |
| `icon=upload` | 待卡卡定义 | — |

**验证用例**：歌宝婷下 P1 红 = `iconColor=red`，P2 青 = `iconColor=aqua`，P3 上传箭头 = `icon=upload`，P4-P6 无字段。

**同步**：

- `.windsurfrules`：加"文件夹颜色和图标字段"节
- `.windsurf/workflows/eagle-folder-ops.md`：§11 全新一节
- `.windsurf/workflows/product-image-gen.md`：§0.5 加字段读取
- `.windsurf/workflows/supplier-product-analyze.md`：§Step 0 加字段必读
- `EAGLE_FOLDER_GUIDE.md`：§3.2 新增
- 中央记忆：`team_shared` ID `716ed6f7-4d5d-4c77-b904-6b4b0794d8a1`

---

## 历史踩坑（迁移自既有规则与中央记忆）

### [API] HTTP /api/item/update 改 folders 不可靠

**结论**：`POST /api/item/update {id, folders:[...]}` 返回 `status: success` 但 `item/info` 查出来 `folders` 实际未变。**不能**当作改文件夹/多文件夹引用的可靠手段。

**已验证可用替代**：Eagle 插件 SDK `eagle.item.modify(id, { folders: [...] })`。

**已验证可改字段**：`isDeleted`（从回收站还原 item）：`POST /api/item/update {id, isDeleted: false}` ✅。

**同步位置**：`eagle-folder-ops.md` §6.1、§6.3、`.windsurfrules` Eagle API/SDK 边界节、中央记忆 `ff7af77b-f826-4a96-8dca-7a4be119d62e`。

---

### [API] HTTP /api/item/addFromPath 是新建 item，不是引用

**踩坑**：用 `addFromPath` 把 Eagle 库里已有原图"挂"到产品文件夹，会**复制**一份新 item，不是引用。两者删除后会出现回收站和库内容混乱。

**正确方案**：folder-linker 插件队列 → `eagle.item.modify(id, { folders: [...] })` 加引用，原图 item id 不变、不复制、不进回收站。

**插件路径**：`D:\2026AI\eagle-plugins\folder-linker\`
**队列目录**：`D:\2026AI\.runtime\folder_link_queue\`

**同步位置**：`eagle-folder-ops.md` §6.2、`supplier-product-analyze.md` Step 3、中央记忆 `434ba22b-ac54-4b9a-abd4-8f0207a1ce10`、`3bc32c96-10e3-4a38-88b2-ea6369405790`。

---

### [API] Eagle HTTP API 没有删文件夹接口

**结论**：`POST /folder/delete`、`DELETE /folder/{id}`、`folderIds[]` 三种全部 404。

**唯一可行流程**：

1. AI 完成所有 item 操作后输出空/废弃文件夹清单。
2. 编辑 library 根目录 `metadata.json` 删除对应 folders 节点（必须先备份）。
3. 提醒卡卡在 Eagle 里切换资源库再切回（或重启 Eagle），重新加载 metadata.json，空文件夹消失。

**关键**：metadata.json 必须在 Eagle 不读取时改。Eagle 切库时会保存内存 → 改文件 → 切回时重新加载。

**项目规则**：apply 类脚本只建子文件夹+重入 item，不主动改 metadata.json；需要清理空文件夹时输出清单并提醒卡卡"切库刷新"。

**同步位置**：`.windsurfrules` 删除规则节、`eagle-folder-ops.md` §8.3、中央记忆 `10bbfa89-f84d-48e6-902c-5872806858e2`。

---

### [API] /api/item/list 用 folders 不要用 folderId

**结论**：读单个文件夹的 item 用 `GET /api/item/list?folders=<folderId>`，**不要用 `folderId=<...>`**（后者返回混合结果）。

**同步位置**：`supplier-product-analyze.md` Step 0、`eagle-folder-ops.md` §6.2.3。

---

### [踩坑] 127.0.0.1 vs localhost

**现象**：PC1 出现过 `127.0.0.1:41595` 命中 Windows 假 listener 导致 `Server disconnected`。

**解决**：优先用 `localhost`，走 IPv6 `::1` 才稳定命中 Eagle。

**同步位置**：`EAGLE_FOLDER_GUIDE.md` §2、`eagle-folder-ops.md` §1。
