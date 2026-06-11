# Create desktop shortcut for Image Workflow Studio
#
# Usage:
#   Right-click this file -> Run with PowerShell
#   OR:  powershell -ExecutionPolicy Bypass -File create_shortcut.ps1
#
# Auto-handles desktop redirection (D: drive, OneDrive, etc.) via
# [Environment]::GetFolderPath('Desktop')

$ErrorActionPreference = 'Stop'

# Force UTF-8 output so the Chinese .bat filename prints correctly
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = $PSScriptRoot
if (-not $projectRoot) {
    $projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

# Locate the launcher .bat (Chinese filename, but PowerShell handles Unicode paths fine)
$batFiles = Get-ChildItem -Path $projectRoot -Filter '*.bat' -File |
    Where-Object { $_.Name -notmatch 'Electron' -and $_.Name -notmatch 'bak' }

$batPath = $null
foreach ($f in $batFiles) {
    # Prefer the short main launcher (just '启动.bat' = 6 bytes UTF-8)
    if ($f.Name.Length -le 8) {
        $batPath = $f.FullName
        break
    }
}
if (-not $batPath -and $batFiles.Count -gt 0) {
    $batPath = $batFiles[0].FullName
}

if (-not $batPath -or -not (Test-Path $batPath)) {
    Write-Host "ERROR: Could not find launcher .bat in $projectRoot" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "Launcher: $batPath" -ForegroundColor Cyan

# Real desktop path (handles D:\Desktop redirection / OneDrive)
$desktopPath = [Environment]::GetFolderPath('Desktop')
Write-Host "Desktop:  $desktopPath" -ForegroundColor Cyan

# Use an ASCII shortcut name to avoid any encoding edge cases
$shortcutName = 'Image-Workflow-Canvas.lnk'
$shortcutPath = Join-Path $desktopPath $shortcutName

# Create the .lnk via WScript.Shell (Windows COM)
try {
    $WshShell = New-Object -ComObject WScript.Shell
    $shortcut = $WshShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $batPath
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.Description = 'Image Workflow Studio - one-click launcher'
    $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,165"
    $shortcut.WindowStyle = 1
    $shortcut.Save()

    Write-Host ""
    Write-Host "SUCCESS: shortcut created at:" -ForegroundColor Green
    Write-Host "  $shortcutPath" -ForegroundColor White
    Write-Host ""
    Write-Host "Double-click 'Image-Workflow-Canvas' on your desktop to launch." -ForegroundColor Yellow
} catch {
    Write-Host ""
    Write-Host "ERROR creating shortcut:" -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Read-Host "Press Enter to close this window"
