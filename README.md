# image-workflow-studio

图片工作流 / 无限画布项目，当前 PC2 本地路径为 `D:\2026AI\image-workflow-studio`。

## ⚠️ 新任务先看：Eagle 操作

涉及 Eagle 文件夹、子文件夹、`gen` 目录、批量生图回传、图片入库挂文件夹时：

1. **`EAGLE_CHANGELOG.md`**：Eagle 操作的权威本地副本（规则变更、字段发现、踩坑记录）。中央记忆不可靠，本文件是新窗口/新设备/新 AI 接手时的第一手依据。**任何 Eagle 相关改动必须先追加到这里**。
2. **`EAGLE_FOLDER_GUIDE.md`**：读写速查文档。
3. **`.windsurf/workflows/eagle-folder-ops.md`**：详细操作流程（slash `/eagle-folder-ops` 触发）。
4. **`.windsurfrules`**：项目级强规则（每窗口自动加载）。

不要直接改 Eagle 库里的 `metadata.json`，不要按文件夹名硬猜，文件夹树读取和新建都走 Eagle API / 插件 SDK。

## 项目定位

这个项目负责图片节点画布、提示词配置、图片供应商配置、图片生成和本地输出管理。当前 GPT 生图供应商和多模型能力先在 PC2 本地验证，未得到卡卡明确确认前不要自动同步到 PC1。

## 主要模块

| 目录/文件 | 作用 |
|---|---|
| `backend` | Flask 后端、供应商配置、生成接口、运行日志接口。 |
| `frontend` | Vite + React 前端，无限画布和系统设置界面。 |
| `electron` | Electron 桌面包装。 |
| `docs` | 项目说明、API 配置和历史设计记录。 |
| `backend\outputs` | 图片生成和导入资产，默认视为真实产物。 |
| `.venv` | Python 虚拟环境，可重建候选。 |
| `.runtime` / `logs` | 本地调试日志和运行记录。 |

## 常用入口

- 后端核心：`backend\app.py`
- 前端核心：`frontend\src\Canvas.jsx`
- 图片节点：`frontend\src\components\ImageNode.jsx`
- 系统设置：`frontend\src\components\SystemSettings.jsx`
- 前端 API：`frontend\src\utils\api.js`
- 供应商配置：`backend\system_config.json`
- 供应商统一入口：`image_api_config.py`

## 使用建议

- 单独用 Windsurf 打开本目录时，优先看本 README 和 `docs`。
- 电商家居出图先看 `docs\电商产品出图流程.md`；做家居 Bento 卖点海报时再看 `docs\家居产品Bento卖点海报工作流.md`。
- 涉及供应商 key、`system_config.json`、`image_api_config.py` 时只在本机处理，不外发配置内容。
- `backend\outputs` 不是普通缓存，清理或迁移前必须确认。
- PC2 改动确认通过后，再由卡卡确认是否同步到 PC1。

## 关联项目

- `D:\2026AI\flow-web-automator`：Flow 网页自动化与本地 bridge。
- `D:\2026AI\eagle-plugins\image-batch-gen`：Eagle 批量改图插件会调用本项目生成接口。
- `docs\project-cards\image-workflow-studio.md`：总工作区项目卡。
