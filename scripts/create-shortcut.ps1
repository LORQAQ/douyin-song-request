# Create a desktop shortcut for the Douyin song-request plugin.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1 -Background
#
# NOTE: this file is intentionally pure ASCII. Windows PowerShell 5.1 reads
# BOM-less UTF-8 files as ANSI, which corrupts non-ASCII characters and can
# break the script. The Chinese shortcut name is written via a codepoint list.

param(
    [switch]$Background
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$desktop = [Environment]::GetFolderPath('Desktop')

# Shortcut name is built from codepoints so this file stays pure ASCII:
#   6296 97F3 70B9 6B4C           = Dou Yin Dian Ge
#   FF08 540E 53F0 FF09           = ( + Hou Tai + )
$nameMain = -join @([char]0x6296, [char]0x97F3, [char]0x70B9, [char]0x6B4C)
$nameBg = $nameMain + (-join @([char]0xFF08, [char]0x540E, [char]0x53F0, [char]0xFF09))

if ($Background) {
    $target = Join-Path $root 'start-background.bat'
    $Name = $nameBg
    $desc = 'Start Douyin song-request in background (no console window)'
} else {
    $target = Join-Path $root 'start.bat'
    $Name = $nameMain
    $desc = 'Douyin danmaku song request -> Bilibili auto play'
}

$icon = Join-Path $root 'public\app.ico'
$linkPath = Join-Path $desktop ($Name + '.lnk')

if (-not (Test-Path $target)) { throw "Launcher not found: $target" }
if (-not (Test-Path $icon)) { throw "Icon not found: $icon (run: node scripts/make-icon.js)" }

# Copy the icon to a stable per-user folder: the shortcut keeps working even if
# the project folder is moved or renamed later.
$stableDir = Join-Path $env:LOCALAPPDATA 'DSH-SongRequest'
New-Item -ItemType Directory -Force -Path $stableDir | Out-Null
$stableIcon = Join-Path $stableDir 'app.ico'
Copy-Item $icon $stableIcon -Force

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $root
$shortcut.Description = $desc
$shortcut.IconLocation = ($stableIcon + ',0')
$shortcut.WindowStyle = 1
$shortcut.Save()

# Ask Explorer to refresh icons so the shortcut does not show as a blank page
try {
    $signature = '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);'
    $type = Add-Type -MemberDefinition $signature -Name 'ShellNotify' -Namespace 'Win32' -PassThru -ErrorAction Stop
    $type::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)
} catch {
    # not critical
}

Write-Host ''
Write-Host 'Shortcut created:' -ForegroundColor Green
Write-Host ('  path   : ' + $linkPath)
Write-Host ('  target : ' + $target)
Write-Host ('  icon   : ' + $stableIcon)
Write-Host ''
Write-Host 'Double click it on the desktop to start.' -ForegroundColor Cyan
