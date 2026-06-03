# PC2 image-workflow-studio backend 重启脚本
# 用法（在 PC2 上）：powershell -NoProfile -ExecutionPolicy Bypass -File _pc2_restart_studio.ps1
# 设计为可被 SSH 远程触发；用 Start-Process 创建 detached 子进程，SSH 退出后存活。

$ErrorActionPreference = 'Continue'
$bk = 'D:\2026AI\image-workflow-studio\backend'
$logOut = Join-Path $bk 'app.runtime.log'
$logErr = Join-Path $bk 'app.runtime.log.err'

Write-Host "=== Studio backend 重启 ==="
Write-Host "工作目录: $bk"

# 1. 清掉所有跑这份 backend\app.py 的 python 进程
$victims = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object {
    $cmd = [string]$_.CommandLine
    $cmd -match 'image-workflow-studio' -or $cmd -match 'backend\\app\.py' -or $cmd -match 'backend/app\.py'
  }

if ($victims) {
  foreach ($p in $victims) {
    Write-Host ("  kill PID {0} :: {1}" -f $p.ProcessId, $p.CommandLine)
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { Write-Host "    skip: $_" }
  }
  Start-Sleep -Seconds 2
} else {
  Write-Host "  未找到匹配 backend 的 python 进程"
}

# 2. 双保险：kill 监听 5688 / 5001 的进程（如果还活着）
foreach ($port in 5688, 5001) {
  $conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    Write-Host ("  port {0} listener PID {1} -> kill" -f $port, $c.OwningProcess)
    try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop } catch { Write-Host "    skip: $_" }
  }
}
Start-Sleep -Seconds 1

# 3. 启动新版（detached）
Write-Host "启动新进程..."
$pyExe = 'C:\Program Files\Python310\python.exe'
if (-not (Test-Path $pyExe)) { $pyExe = 'python' }

$proc = Start-Process -FilePath $pyExe `
  -ArgumentList 'app.py' `
  -WorkingDirectory $bk `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logOut `
  -RedirectStandardError $logErr `
  -PassThru

Write-Host ("  新 PID: {0}" -f $proc.Id)
Start-Sleep -Seconds 5

# 4. 验证 5688 已起来
$ok = $false
for ($i = 0; $i -lt 10; $i++) {
  $listening = Get-NetTCPConnection -State Listen -LocalPort 5688 -ErrorAction SilentlyContinue
  if ($listening) { $ok = $true; break }
  Start-Sleep -Seconds 1
}
if ($ok) {
  Write-Host "[OK] 5688 listening"
} else {
  Write-Host "[FAIL] 5688 not listening, last 40 lines of err log:"
  if (Test-Path $logErr) { Get-Content $logErr -Tail 40 }
}

Write-Host "=== done ==="
