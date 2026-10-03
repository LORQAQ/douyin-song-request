# Rebuild the desktop shortcuts and force Windows to refresh its icon cache.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/fix-shortcut-icons.ps1
#
# Pure ASCII on purpose (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).
# The Chinese shortcut names are built from codepoints.

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$desktop = [Environment]::GetFolderPath('Desktop')
$icon = Join-Path $root 'public\app.ico'
$startBat = Join-Path $root 'start.bat'
$bgBat = Join-Path $root 'start-background.bat'

$nameMain = -join @([char]0x6296, [char]0x97F3, [char]0x70B9, [char]0x6B4C)
$nameBg = $nameMain + (-join @([char]0xFF08, [char]0x540E, [char]0x53F0, [char]0xFF09))

if (-not (Test-Path $icon)) { throw "Icon missing: $icon (run: node scripts/make-icon.js)" }

function New-Shortcut([string]$linkPath, [string]$target, [string]$desc) {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($linkPath)
    $sc.TargetPath = $target
    $sc.WorkingDirectory = $root
    $sc.Description = $desc
    $sc.IconLocation = ($icon + ',0')
    $sc.WindowStyle = 1
    $sc.Save()
}

Write-Host 'Rebuilding shortcuts ...'
foreach ($name in @($nameMain, $nameBg)) {
    $link = Join-Path $desktop ($name + '.lnk')
    if (Test-Path $link) { Remove-Item $link -Force }
}
New-Shortcut (Join-Path $desktop ($nameMain + '.lnk')) $startBat 'Douyin danmaku song request -> Bilibili auto play'
New-Shortcut (Join-Path $desktop ($nameBg + '.lnk')) $bgBat 'Start Douyin song-request in background (no console window)'
Write-Host '  done'

# Tell Explorer to re-read icons for these two files
try {
    Add-Type -AssemblyName System.Drawing
    foreach ($name in @($nameMain, $nameBg)) {
        $link = Join-Path $desktop ($name + '.lnk')
        if (Test-Path $link) {
            $i = New-Object System.Drawing.Icon($icon, 32, 32)
            $i.Dispose()
        }
    }
} catch {
    Write-Host ('  (icon preload skipped: ' + $_.Exception.Message + ')')
}

# Drop the Explorer icon cache so the old blank icon disappears
Write-Host 'Clearing Explorer icon cache ...'
$cacheDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
$removed = 0
Get-ChildItem $cacheDir -Filter 'iconcache*.db' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        Remove-Item $_.FullName -Force -ErrorAction Stop
        $removed++
    } catch {
        # locked by explorer.exe - not fatal, SHChangeNotify below still helps
    }
}
Write-Host ('  removed ' + $removed + ' cache file(s)')

# Broadcast "icons changed" to the shell
try {
    $signature = '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);'
    $type = Add-Type -MemberDefinition $signature -Name 'ShellNotify2' -Namespace 'Win32Fix' -PassThru -ErrorAction Stop
    # SHCNE_ASSOCCHANGED = 0x08000000, SHCNF_IDLIST = 0
    $type::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)
    Write-Host '  shell notified'
} catch {
    Write-Host ('  (notify failed: ' + $_.Exception.Message + ')')
}

Write-Host ''
Write-Host 'Result:' -ForegroundColor Green
$shell2 = New-Object -ComObject WScript.Shell
foreach ($name in @($nameMain, $nameBg)) {
    $link = Join-Path $desktop ($name + '.lnk')
    if (Test-Path $link) {
        $sc = $shell2.CreateShortcut($link)
        Write-Host ('  ' + $link)
        Write-Host ('     target: ' + $sc.TargetPath)
        Write-Host ('     icon  : ' + $sc.IconLocation)
    }
}
Write-Host ''
Write-Host 'If the desktop icon still looks blank, press F5 on the desktop.' -ForegroundColor Cyan
Write-Host 'Worst case: sign out and sign back in (that fully rebuilds the icon cache).' -ForegroundColor Cyan
