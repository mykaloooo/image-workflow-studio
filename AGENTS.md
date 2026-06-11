# AGENTS.md — image-workflow-studio 协作契约

> **所有 AI 助手（Claude / Cascade / Cursor / Codex / Gemini 等）进入本仓库必读。**
> 仓库主人卡卡不写代码，所有改动都靠 AI。多个 AI 轮流改 = 容易把"昨天好的"今天搞坏。
> 这份文档是底线，**违反 = 破坏卡卡的生产工具**。

---

## 1. 项目角色

`image-workflow-studio` 是卡卡的**生产级**电商/装修/产品图片批量生成工具：

- **后端**：`backend/app.py`，Flask 在 5688 端口，统一封装 5 种生图协议
- **前端**：React 在 `frontend/`（无限画布 + 系统设置 + 历史面板）
- **客户端**：Eagle 插件 `eagle-plugins/image-batch-gen/`（独立仓库，但跟本仓库耦合）
- **多机部署**：PC1 (J:\AI2026\ZL\projects\image-workflow-studio) + PC2 (D:\2026AI\image-workflow-studio)

卡卡每天用它出商品图，**任何 regression 都直接影响她当天的工作**。

---

## 2. 改代码之前的「三步必做」

### 步骤 1 — 先查中央记忆

```
mcp2_recall  query="<你要改的功能名>"  projects=["image-workflow-studio","eagle"]  sort_by=recent
```

如果记忆里有 `# 已修复 / # 已验证 / # 已锁定` 的记录，**先看完再动手**。
不查记忆 = 你不知道这段代码为什么是现在这样写的 = 大概率重复造成 regression。

### 步骤 2 — 跑回归测试

```bash
cd backend
python -m pytest tests/ -v
```

**全绿才能继续改**。如果你的改动会让测试变红，先停下来问卡卡。

### 步骤 3 — 改完再跑一次测试 + 让卡卡口头确认

测试绿了不等于功能对，**最终验收靠卡卡试用**。
改完告诉卡卡："请你跑一张图试试"，**得到确认才能 git commit**。

---

## 3. ⛔ 已锁定的代码段（动了等于 bug）

每条都附中央记忆 ID。**改之前先 recall**，否则你就是下一个引入 regression 的 AI。

| # | 位置 | 雷点 | 记忆 ID |
|---|---|---|---|
| **L1** | `backend/app.py` `_generate_openai_images_edit` (≈2069-2091 行) | 参考图**严禁**按 `target_size` 强行 stretch。必须保持原比例。**已踩坑 2 次**（5/10 修过，5/12 又坏过） | `b032055a` |
| **L2** | `backend/app.py` `_normalize_openai_size` + `_OPENAI_RESOLUTION_SIZE_MAP` | 4K/2K/1K → WxH 的映射表。任何 provider 用 codex/gpt-image 都吃这个表 | `3387828a` |
| **L3** | `backend/app.py` `load_system_config` / `save_system_config` | utf-8-sig 容忍 BOM + LOUD CRITICAL 告警 + auto backup + schema 校验（providers 跌幅 >50% 拒写）| `d4feedaa` |
| **L4** | `eagle-plugins/image-batch-gen/logic.js` GEMINI/OPENAI/WANX/FLOW 比例配置表 | 13 个比例最大尺寸已校验，clamp 规则不可改 | `dfffdde9` |
| **L5** | 反代 `chatgpt2api/api/ai.py` 的 `/v1/images/edits` size 透传 | 不传 size 会默认成 1:1，生成图比例错 | `0049c5f6` |
| **L6** | `backend/app.py` `_generate_openai_images` retry 链 + fallback 切 provider | cpa↔chat2api 互为兜底，3 段重试，延迟 0/5/30s | `(2026-05-12)` |
| **L7** | `eagle-plugins/image-batch-gen/logic.js` payload 必带 `mode` 字段 + 后端 `/api/generate` 校验 | 图生图无图必须 400 拒绝，不能静默退化文生图 | `(2026-05-12)` |

---

## 4. 已锁定的功能矩阵（卡卡 2026-05-12 确认）

这些功能**当前能稳定工作**，未经卡卡同意不许改：

### 4.1 已锁 Provider（卡卡在用）

| Provider ID | 模型 | 用途 |
|---|---|---|
| `chat2api_japan_plus` | codex-gpt-image-2 | **默认**，日本机 4K |
| `cpa_japan` | gpt-image-2 | 卡卡自有 CPA Japan 3 号池 |
| `doce_77code` | gpt-image-2 | doce 77code |
| `packyapi` | gpt-image-2 | PackyAPI |
| `packyapi_slb` | gpt-image-2 | PackyAPI SLB |
| `doce_chat_mini` | gpt-5.4-mini chat-image | 便宜 70× |
| `codexapis_chat_mini` | gpt-5.4-openai-compact chat-image | — |
| `codexapi` | gpt-5.4-mini / gpt-5.5 chat-image | codexapis.com；旧别名 `cpa_us_chat` 必须自动规范为 `codexapi` |

> 其他 provider (`default_image` / `default_chat` / `provider_1774884171155` / `chat2api_japan_plus_legacy` 等) 当前未用，可继续配置，但**不许动以上 8 个的协议处理代码**。

### 4.2 已锁生图模式（3 种全锁）

- `text` — 文生图（纯 prompt）
- `image` — 图生图（1 张参考图 + prompt）
- `multi` — 多参考图（多张 + prompt）

### 4.3 已锁比例 & 尺寸（全锁）

- **OpenAI/Codex**: 7 比例（1:1, 3:2, 2:3, 16:9, 9:16, 4:3, 3:4）× 1K/2K/4K
- **OpenAI 原比例锁定**: 0.5/0.75/1/1.25/1.5/1.75/2 倍，按参考图实际比例自动换算
- **Gemini**: 10 比例 (1:1, 4:3, 3:2, 16:9, 21:9, 4:5, 3:4, 2:3, 9:16, 5:4)
- **万相 wan2.7-image-pro**: 5 比例 + 原比例 × 1K/2K/4K
- **Flow Web**: 5 比例，固定 1K 回传（高清通过 Flow 二次下载补 2K/4K）
- **任意非标比例**（1:2, 1:3, 1:4 等）— 通过"图生图 + 原比例锁定"路径自动换算（**这是 feature，不是 bug，不要"修正"**）

### 4.4 已锁队列 / 任务管理

- 批次并行 1-4 批
- 可视化队列（复选框 / 分页 / 取消等待 / 取消当前）
- 任务结果面板（失败/已完成/取消 三 tab）
- 失败重发（原参数 / 编辑 prompt 后重发）

> 卡卡反馈：**UI 显示吃力，需要调样式**。允许调 CSS / 布局，但**功能行为不变**。

### 4.5 已锁 Eagle 集成

- 选 N 张图 → `gen.原名` 入同 Eagle 文件夹
- 选 1 个 Eagle 文件夹 → `{原名}_gen` 子文件夹
- 转画布（Eagle → Studio 无限画布）
- Flow 候选图 → 2K/4K 二次下载
- 打开插件自动启动后端（5688，空闲 1200s 自退）

### 4.6 已锁后端基础设施

- 生图历史聚合面板（PC1+PC2 跨机聚合）
- system_config.json BOM 容忍 + 三道防线（auto backup / schema 校验 / LOUD 告警）
- Provider fallback 重试（cpa↔chat2api）
- 图生图模式必带参考图校验（mode=image/multi 无图 → 400）

---

## 5. 还在迭代 / 允许改动的部分

- **队列 UI 调优**（功能锁，样式可改）
- **提示词历史快速面板**（新需求，等卡卡画 UI 草图）
- **新增 provider**（添加新协议时**不许动现有 7 个的代码路径**，加新分支即可）
- **新增模型**（同上）

---

## 6. 多 AI 协作规则

### 6.1 不许直接 push / scp 覆盖另一台机器
PC1 ↔ PC2 必须走 git。直接覆盖 = 静默回退（5/10→5/12 那次拉伸 regression 就是这样产生的）。

### 6.2 改代码必须 commit
不许"改完不 commit 就跑"。每次改动 1 个独立 commit，message 写清楚改了什么。这样卡卡能 `git revert` 单独回滚某一个改动。

### 6.3 改 app.py 必须先看顶部注释 + 中央记忆
`backend/app.py` 是 5 协议核心，每次改动牵一发动全身。

### 6.4 删 / 改测试需要卡卡明确同意
`backend/tests/` 下的每个测试都对应一个已修过的 bug。
**测试变红 = 你引入了 regression**，不许"删了它让 CI 过"。

### 6.5 当前 baseline tag
本仓库当前稳定基线 = git tag `stable-20260512`（2026-05-12 卡卡确认）。
任何破坏后可一键回滚：
```bash
git checkout stable-20260512 -- <破掉的文件>
```

### 6.6 ⛔ 交互式命令禁止远程代跑（2026-05-13 教训）

**任何会等待 stdin 输入的命令，必须让卡卡本人在终端跑，AI 不许通过 SSH/IDE 远程执行**。

血泪场景：2026-05-13 早上，AI 用 `ssh pc2 ... git clone github.com:...` 远程让 PC2 clone GitHub。PC2 第一次连 GitHub 触发 SSH host key 确认（`Are you sure you want to continue connecting (yes/no)?`），但远程通道无法把 stdin 转给 AI，命令**挂死 10 分钟**才被卡卡发现。

**判定交互式命令的关键词（看到立刻停手让卡卡来跑）**：

- 任何 `ssh` 第一次连新主机 → host key prompt
- `git clone` / `git push` / `git pull` 带 HTTPS 凭据 → 用户名密码 prompt
- `sudo` / Windows UAC 弹窗
- `npm login` / `pip install` 需要选项的交互安装
- 任何带 `--interactive` 或没明确 `--yes` / `-y` 的工具

**给 AI 的强制规则**：

1. 如果命令**可能**触发交互式 prompt，**不要远程跑**，而是：
   - 把命令打印出来给卡卡，让她复制粘贴到她本地终端
   - 等她回报输出
2. 远程跑 SSH/git 必须显式加 `BatchMode=yes` / `--no-progress` / 等非交互 flag
3. 远程命令超过 30 秒没返回 → **主动取消并询问卡卡**，不能默默挂着

### 6.7 ⛔ 长命令进度必须全程可见（2026-05-13 卡卡硬要求）

**所有窗口的进度，必须给卡卡看到。不许 silent 跑、不许装作"已完成"骗她。**

血泪场景：2026-05-13 多次 SSH 远程命令"看起来卡死实际还在跑"或"挂死 stdin 等输入"，卡卡傻等没回应——浪费时间还焦虑。

**强制规则（违反 = 卡卡白等）**：

1. **SSH 远程长命令必加 `ssh -t`**（强制 TTY，pip/wget/scp/git clone 进度条才显示）
2. **不要主动关进度条**：不要 `--progress-bar off` / `--quiet` / `> NUL` / `2>&1 | Out-Null`
3. **不要 pipe 到缓冲工具**：tail/grep/head/Out-String/Select-Object/Format-Table 都会缓冲，命令跑完才一次性出，看起来像卡死
4. **网络命令设大超时 + 显式 timeout**：
   - `pip --timeout 60`
   - `curl --max-time 120`
   - `scp -o ConnectTimeout=30`
   - `ssh -o ConnectTimeout=10 -o ServerAliveInterval=15`
5. **国内服务器装包用国内镜像**：`pip install -i https://mirrors.aliyun.com/pypi/simple/`（国外源 `files.pythonhosted.org` 国内常超时）
6. **AI 自己 `run_command` 跑长命令也一样**：
   - 跑前**预告耗时**（"预计 1 分钟"/"预计 5 分钟"）
   - 给卡卡留**另开窗口验证**的命令（例如 `Get-Process python` 看进程是否在跑）
   - 跑完**主动确认结果**（不要默默"已完成"）
   - 超过预告时间还没回 → **主动取消并询问**，不能默默挂着

**正确示范**（卡卡能看到进度）：
```powershell
# ✅ scp 显式带超时 + 不关进度
scp -o ConnectTimeout=30 pc2:/path/to/file ./local
# ✅ pip 默认带进度条，别关
pip install package --timeout 60
# ✅ 长任务前告诉卡卡"预计 X 分钟"，让她另开窗口能验证
```

**错误示范**（卡卡看着像卡死）：
```powershell
# ❌ 输出被吞
ssh pc2 "long-command" 2>&1 | Out-Null
# ❌ pipe 缓冲，命令完才出
ssh pc2 "long-command" | Select-Object -First 30
# ❌ 静默关进度
pip install package --quiet --progress-bar off
```

**已落地**：本节 + 中央记忆 ID `ec35e7fe`（work-assistant）。

---

## 7. 紧急情况

### 7.1 卡卡说"图变形了 / 拉伸了"
99% 是 L1 (`_generate_openai_images_edit` 参考图按 size stretch) 回归。
立刻看 `backend/app.py` 该函数，比对 memory `b032055a`。

### 7.2 卡卡说"供应商都没了 / 只剩 4 个"
99% 是 L3 (system_config.json BOM 或解析失败) 回归。
立刻看 `backend/_server.err.log` 找 LOUD CRITICAL，检查 `system_config.json` 是否有 BOM (用 `Get-Content -Encoding Byte | Select-Object -First 3`，应该是 `EF BB BF` 或纯文本)。

### 7.3 卡卡说"4K 出图比例错了 / 出来变成 1:1"
99% 是 L5 (反代 size 透传) 或 L2 (`_OPENAI_RESOLUTION_SIZE_MAP`) 回归。

### 7.4 卡卡说"重启后端没用 / 改的代码没生效"
插件需要重启 Eagle / 关闭插件窗口重开，浏览器需要硬刷新。
后端 `restartStudioBackend` 功能在 `logic.js` 里，会 kill + 重启。

---

## 8. 中央记忆（必查清单）

进项目前先 recall 这几个核心 ID（一次性记住所有历史地雷）：

```
b032055a  参考图保持比例不拉伸（5/10 + 5/12 重修）
3387828a  4K 比例错误修复 _normalize_openai_size
d4feedaa  system_config.json BOM 三道防线
dfffdde9  13 比例最大尺寸已校验
0049c5f6  PC2 chatgpt2api edits size 透传
9812059e  chat-image 第 5 协议（gpt-5.4-mini）
411693ee  批次并行队列架构
6e072180  失败重发 / 任务结果面板
d39ad293  生图历史聚合面板
3b7e8c59  打开插件自动启动后端
```

---

**最后一句**：卡卡一行代码都不懂，但她每一次"图坏了"都是真金白银的损失。
这份契约是给所有 AI 看的 — 别成为那个"自信地破坏了好功能"的 AI。
