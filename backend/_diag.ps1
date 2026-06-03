$ErrorActionPreference = 'Continue'

Write-Host "=== Python processes ==="
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Select-Object ProcessId, ParentProcessId, CommandLine |
  Format-List

Write-Host ""
Write-Host "=== Listening ports 5001/5688/5689/5690 ==="
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 5001,5688,5689,5690 } |
  Select-Object LocalAddress, LocalPort, OwningProcess |
  Format-Table -AutoSize

Write-Host ""
Write-Host "=== app.runtime.log (full) ==="
$logPath = 'D:\2026AI\image-workflow-studio\backend\app.runtime.log'
if (Test-Path $logPath) { Get-Content $logPath -Encoding UTF8 } else { Write-Host "(no log)" }

Write-Host ""
Write-Host "=== app.runtime.log.err (full) ==="
$logErr = 'D:\2026AI\image-workflow-studio\backend\app.runtime.log.err'
if (Test-Path $logErr) { Get-Content $logErr -Encoding UTF8 } else { Write-Host "(no err log)" }
