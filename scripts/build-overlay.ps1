# 编译歌单悬浮窗相关的所有程序（用系统自带的 C# 编译器，不需要装 SDK）
#
# 为什么用 csc.exe 而不是 dotnet：
#   Windows 自带 .NET Framework 的 C# 编译器，直接产出单个 exe，
#   用户机器上不用装 .NET SDK / Electron / 任何运行时（.NET Framework 4.x 系统自带）。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$srcDir = Join-Path $root 'overlay'
$outDir = Join-Path $srcDir 'bin'

if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

# 找 csc.exe（.NET Framework 的编译器，系统自带）
$csc = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $csc) { throw "找不到 csc.exe（系统缺 .NET Framework 4.x？）" }

Write-Host "编译器: $csc"
Write-Host ""

# 要编译的程序。ui=$true 表示是窗口程序（/target:winexe，不弹黑框）
$targets = @(
  @{ src = 'SongOverlay.cs';   exe = 'SongOverlay.exe';   ui = $true;  desc = '歌单悬浮窗（透明置顶）' },
  @{ src = 'OverlayPlacer.cs'; exe = 'OverlayPlacer.exe'; ui = $true;  desc = '摆位工具（拖动/贴角/穿透）' },
  @{ src = 'WhereIsIt.cs';     exe = 'WhereIsIt.exe';     ui = $false; desc = '查位置（命令行）' }
)

$ok = 0
foreach ($t in $targets) {
  $src = Join-Path $srcDir $t.src
  $exe = Join-Path $outDir $t.exe
  if (-not (Test-Path $src)) {
    Write-Host ("  -  跳过（源文件不存在）: " + $t.src) -ForegroundColor Yellow
    continue
  }

  $mode = if ($t.ui) { 'winexe' } else { 'exe' }
  $refs = @('/reference:System.dll')
  if ($t.ui) {
    $refs += '/reference:System.Drawing.dll'
    $refs += '/reference:System.Windows.Forms.dll'
  }

  & $csc /nologo "/target:$mode" /optimize+ "/out:$exe" @refs $src 2>&1 |
    Where-Object { $_ -notmatch 'warning CS' } |
    ForEach-Object { Write-Host ("      " + $_) }

  if (Test-Path $exe) {
    $kb = [math]::Round((Get-Item $exe).Length / 1KB, 1)
    Write-Host ("  OK  " + $t.exe.PadRight(20) + "$kb KB   " + $t.desc) -ForegroundColor Green
    $ok++
  } else {
    Write-Host ("  !!  " + $t.exe + " 编译失败") -ForegroundColor Red
  }
}

Write-Host ""
if ($ok -eq $targets.Count) {
  Write-Host "全部编译成功（$ok/$($targets.Count)）" -ForegroundColor Green
} else {
  Write-Host "编译完成 $ok/$($targets.Count)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "启动方式:"
Write-Host "   悬浮窗        npm run overlay"
Write-Host "   摆位工具      npm run overlay:place"
Write-Host "   查位置        npm run overlay:where"