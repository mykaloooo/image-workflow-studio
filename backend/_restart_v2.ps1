$ErrorActionPreference = 'Continue'

$bk = 'D:\2026AI\image-workflow-studio\backend'
$logOut = Join-Path $bk 'app.runtime.log'
$logErr = Join-Path $bk 'app.runtime.log.err'

Write-Host "=== Studio backend restart (via Task Scheduler) ==="

# 1) Stop any python.exe whose CommandLine references our backend
$victims = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object {
    $cmd = [string]$_.CommandLine
    $cmd -match 'image-workflow-studio' -or $cmd -match 'backend\\app\.py'
  }
foreach ($p in $victims) {
  Write-Host ("  kill PID {0} :: {1}" -f $p.ProcessId, $p.CommandLine)
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { Write-Host "    skip: $_" }
}

# 2) Also kill anything listening on 5001/5688
foreach ($port in 5688, 5001) {
  $conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    Write-Host ("  port {0} listener PID {1} -> kill" -f $port, $c.OwningProcess)
    try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop } catch { Write-Host "    skip: $_" }
  }
}

Start-Sleep -Seconds 2

# 3) Truncate log files
Set-Content -Path $logOut -Value '' -Encoding UTF8
Set-Content -Path $logErr -Value '' -Encoding UTF8

# 4) Resolve python path
$pyExe = 'C:\Program Files\Python310\python.exe'
if (-not (Test-Path $pyExe)) { $pyExe = 'python' }

# 5) Build a wrapper bat that redirects output, so schtasks can run a single command
$wrapper = Join-Path $bk '_run_studio.bat'
$wrapperContent = @"
@echo off
cd /d "$bk"
"$pyExe" app.py >> "$logOut" 2>> "$logErr"
"@
Set-Content -Path $wrapper -Value $wrapperContent -Encoding ASCII

# 6) Register one-time scheduled task to start it 5 seconds from now
$taskName = 'iws-studio-oneshot-' + (Get-Date).ToString('yyyyMMddHHmmss')
Write-Host "  scheduling task: $taskName"

$action = New-ScheduledTaskAction -Execute $wrapper
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddSeconds(5))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -DeleteExpiredTaskAfter (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

try {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "  task registered"
} catch {
  Write-Host "  Register-ScheduledTask failed: $_"
}

# 7) Wait up to 25 seconds for port 5688 to come up
Start-Sleep -Seconds 8
$ok = $false
for ($i = 0; $i -lt 17; $i++) {
  $listening = Get-NetTCPConnection -State Listen -LocalPort 5688 -ErrorAction SilentlyContinue
  if ($listening) { $ok = $true; break }
  Start-Sleep -Seconds 1
}

if ($ok) {
  $pid_listener = (Get-NetTCPConnection -State Listen -LocalPort 5688 | Select-Object -First 1).OwningProcess
  Write-Host "[OK] 5688 listening, PID=$pid_listener"
} else {
  Write-Host "[FAIL] 5688 not listening; tail of err log:"
  if (Test-Path $logErr) { Get-Content $logErr -Tail 60 }
  Write-Host "--- stdout log:"
  if (Test-Path $logOut) { Get-Content $logOut -Tail 60 }
}

Write-Host "=== done ==="
