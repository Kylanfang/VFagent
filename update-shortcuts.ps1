# (Re)create V-Fletch shortcuts pointing to the packaged exe (location-independent)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$exe = Join-Path $root 'release\win-unpacked\V-Fletch.exe'
if (-not (Test-Path $exe)) { throw "exe not found: $exe" }
$ws = New-Object -ComObject WScript.Shell
foreach ($base in @($root, [Environment]::GetFolderPath('Desktop'))) {
    $lnkPath = Join-Path $base 'V-Fletch 办公助手.lnk'
    $lnk = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath       = $exe
    $lnk.WorkingDirectory = Split-Path $exe
    $lnk.IconLocation     = "$exe,0"
    $lnk.WindowStyle      = 1
    $lnk.Description      = 'V-Fletch 办公智能体 - 双击打开'
    $lnk.Save()
    Write-Host "created: $lnkPath"
}
Write-Host 'Done.'
