$ErrorActionPreference = 'Continue'

$bk = 'D:\2026AI\image-workflow-studio\backend'
$logOut = Join-Path $bk 'app.runtime.log'
$logErr = Join-Path $bk 'app.runtime.log.err'
$wrapper = Join-Path $bk '_run_studio.bat'

Write-Host "=== Studio backend restart (schtasks.exe) ==="

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

# Also kill anything listening on 5001/5688
foreach ($port in 5688, 5001) {
  $conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    Write-Host ("  port {0} listener PID {1} -> kill" -f $port, $c.OwningProcess)
    try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop } catch { Write-Host "    skip: $_" }
  }
}

Start-Sleep -Seconds 2

# 2) Truncate logs
Set-Content -Path $logOut -Value '' -Encoding UTF8
Set-Content -Path $logErr -Value '' -Encoding UTF8

# 3) Resolve python and build wrapper bat
$pyExe = 'C:\Program Files\Python310\python.exe'
if (-not (Test-Path $pyExe)) { $pyExe = 'python' }

$wrapperContent = @"
@echo off
cd /d "$bk"
"$pyExe" app.py >> "$logOut" 2>> "$logErr"
"@
Set-Content -Path $wrapper -Value $wrapperContent -Encoding ASCII

# 4) Use schtasks.exe (more reliable than PS cmdlet) to create + run a one-shot task
$taskName = 'iws-studio-oneshot'

# Delete previous task if any
& schtasks.exe /delete /tn $taskName /f 2>$null | Out-Null

$startTime = (Get-Date).AddMinutes(2).ToString('HH:mm')
$startDate = (Get-Date).ToString('yyyy/MM/dd')

# /sc ONCE /st HH:mm /sd yyyy/MM/dd  -- task armed but we'll fire it manually with /run
$createOut = & schtasks.exe /create /tn $taskName /tr ('"' + $wrapper + '"') /sc ONCE /st $startTime /sd $startDate /rl LIMITED /f 2>&1
Write-Host "  schtasks /create -> $createOut"

# Manually run it now so we don't wait for the trigger
$runOut = & schtasks.exe /run /tn $taskName 2>&1
Write-Host "  schtasks /run -> $runOut"

# 5) Wait up to 25s for 5688 to come up
$ok = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 1
  $listening = Get-NetTCPConnection -State Listen -LocalPort 5688 -ErrorAction SilentlyContinue
  if ($listening) { $ok = $true; break }
}

if ($ok) {
  $listenerPid = (Get-NetTCPConnection -State Listen -LocalPort 5688 | Select-Object -First 1).OwningProcess
  Write-Host "[OK] 5688 listening, PID=$listenerPid"
} else {
  Write-Host "[FAIL] 5688 not listening after 25s; tail of err log:"
  if (Test-Path $logErr) { Get-Content $logErr -Tail 60 }
  Write-Host "--- stdout log:"
  if (Test-Path $logOut) { Get-Content $logOut -Tail 60 }
  Write-Host "--- python processes still alive:"
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Select-Object ProcessId, CommandLine | Format-List
}

# Cleanup the scheduled task (keep system clean)
& schtasks.exe /delete /tn $taskName /f 2>$null | Out-Null

Write-Host "=== done ==="
