# image-workflow-studio 项目规则

## 📕 最高优先级：先读 AGENTS.md

**所有 Windsurf / Cascade 会话进入本仓库时，第一件事是阅读仓库根目录的 [`AGENTS.md`](../AGENTS.md)。**

AGENTS.md 内容比本文件优先级更高，包含：
- 已锁定的代码段清单（动了等于 bug）
- 已锁定的功能矩阵（卡卡确认过的稳定能力）
- 改代码必跑的回归测试命令（`pytest backend/tests/`）
- 必查的中央记忆 ID 清单（历史地雷）
- 当前 baseline tag = `stable-20260512`

**违反 AGENTS.md 的契约 = 破坏卡卡的生产工具**。卡卡一行代码都不懂，但每天靠这个工具出商品图。

---

## ⚠️ Windows + Python subprocess 必须隐藏窗口

**所有 `subprocess.run` / `subprocess.Popen` / `subprocess.call` 等外部命令调用必须使用 `run_silent` / `popen_silent`（来自 `backend/utils/subprocess_helpers.py`），或显式传入 `creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)`。**

### 原因

Windows 默认给 `subprocess` 启动的外部进程创建一个前台 `conhost` 窗口。在后台守护线程中周期性调用 `ssh` / `du` / `git` / `curl` 等命令时，**每次都会闪一个黑窗**，严重影响桌面体验。

### 正确写法

```python
from utils.subprocess_helpers import run_silent

result = run_silent(
    ["ssh", host, command],
    capture_output=True,
    text=True,
    timeout=20,
)
```

### 错误示例（禁止）

```python
# ❌ 这会闪窗
subprocess.run(["ssh", host, command], capture_output=True)
subprocess.Popen(["git", "fetch"])
```

## 后台守护进程多实例堆叠

`start_recovery_patrol` 等通过模块级 flag（如 `recovery_patrol_started`）防止同一进程内多次注册线程，但**多次启动 backend 进程**仍会堆叠（每个进程独立有自己的巡逻线程）。

启动 backend 前应确认旧进程已退出：

```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like "*image-workflow-studio*" }
```

如果有残留实例，在重启前先清理：

```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like "*image-workflow-studio*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## 历史背景

2026-05-10 排查后台闪窗问题，定位根因：

1. `recovery_run_remote()` 调用 `ssh.exe` 没加 `CREATE_NO_WINDOW`
2. 当时有 7 个 backend 实例堆叠，每个都跑独立的巡逻线程

修复方式：
- 引入 `utils/subprocess_helpers.py` 集中封装
- 落地本规则文件防止再次踩坑

关联中央记忆：`72acfd1a-898a-4082-8563-5358bb149f44`（PaperCut 闪窗）、`1d3f3e35-4927-4e4a-a411-e346d7e8a3dd`（Windsurf Cascade Allow List）。
