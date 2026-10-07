# V-Fletch shortcut installer (location-independent: uses the folder this script lives in)
# Creates two shortcuts pointing to launch.bat:
#   1. inside the vfletch folder (portable)
#   2. on the user's Desktop (daily use)
$ErrorActionPreference = 'Stop'

$vfletch = $PSScriptRoot
$target  = Join-Path $vfletch 'launch.bat'
# Prefer the packaged V-Fletch brand icon when available, otherwise fall back to a stock Windows icon
$brandIcon = Join-Path $vfletch 'brand\icon.ico'
$icon = if (Test-Path $brandIcon) { "$brandIcon,0" } else { "$env:SystemRoot\System32\shell32.dll,220" }

if (-not (Test-Path $target)) { throw "launch.bat not found: $target" }

$ws = New-Object -ComObject WScript.Shell

function New-VfletchShortcut {
    param([string]$Path, [string]$Name)
    $lnkPath = Join-Path $Path "$Name.lnk"
    $lnk = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath       = $target
    $lnk.WorkingDirectory = $vfletch
    $lnk.IconLocation     = $icon
    $lnk.WindowStyle      = 7            # minimized
    $lnk.Description      = 'V-Fletch Office Agent - double click to open'
    $lnk.Save()
    Write-Host "Created: $lnkPath"
}

New-VfletchShortcut -Path $vfletch -Name 'V-Fletch 办公助手'
New-VfletchShortcut -Path ([Environment]::GetFolderPath('Desktop')) -Name 'V-Fletch 办公助手'
Write-Host 'Done.'
