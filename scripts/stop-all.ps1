# 一键停止：点歌程序 + 歌单悬浮窗 + 摆位工具
#
# 用法:
#   powershell -File scripts\stop-all.ps1            停服务和悬浮窗（播放页保留）
#   powershell -File scripts\stop-all.ps1 -All       连播放页一起关
#   powershell -File scripts\stop-all.ps1 -Quiet     不打印过程

param(
  [switch]$All,      # 连音乐播放页一起关
  [switch]$Quiet     # 只输出结果
)

$ErrorActionPreference = 'Continue'

function Say($t, $c = 'Gray') { if (-not $Quiet) { Write-Host $t -ForegroundColor $c } }

$killed = 0
Say ""
Say "  ============================================" 'Cyan'
Say "     停止抖音点歌（全部）" 'Cyan'
Say "  ============================================" 'Cyan'
Say ""

# ---- 1) 停服务（占用 8787 的 node）----
Say "  [1/3] 停止点歌程序 …"
$conns = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
if ($conns.Count -eq 0) {
  Say "        本来就没在跑"
} else {
  # 注意：不能用 $pid 当变量名 —— 它是 PowerShell 的只读内置变量（当前进程号），
  # 赋值会报 "Cannot overwrite variable PID because it is read-only"。
  foreach ($procId in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.ProcessName } else { '未知' }
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
      Say ("        已停止 " + $name + " (pid " + $procId + ")") 'Green'
      $killed++
    } else {
      Say ("        停止失败 pid " + $procId) 'Red'
    }
  }
}

# ---- 2) 停悬浮窗相关程序 ----
Say "  [2/3] 停止悬浮窗 …"
$names = @('SongOverlay', 'OverlayPlacer')
foreach ($n in $names) {
  $ps = @(Get-Process -Name $n -ErrorAction SilentlyContinue)
  if ($ps.Count -eq 0) { continue }
  foreach ($p in $ps) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
      Say ("        已停止 " + $n + " (pid " + $p.Id + ")") 'Green'
      $killed++
    }
  }
}
if ($killed -eq 0) { Say "        本来就没在跑" }

# ---- 3) 可选：关掉音乐播放页 ----
Say "  [3/3] 音乐播放页 …"
$player = @()
try {
  $player = @(Get-Process chrome -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -match '音乐播放页' })
} catch { }

$closePlayer = $All.IsPresent
if (-not $All -and $player.Count -gt 0 -and -not $Quiet) {
  $ans = Read-Host "        要连音乐播放页一起关掉吗？(y/N，8 秒后默认不关)"
  if ($ans -match '^[Yy]') { $closePlayer = $true }
}

if ($player.Count -eq 0) {
  Say "        没有开着的播放页"
} elseif ($closePlayer) {
  foreach ($p in $player) {
    try {
      $p.CloseMainWindow() | Out-Null
      Start-Sleep -Milliseconds 300
      if (-not $p.HasExited) { $p.Kill() }
      Say ("        已关闭播放页 (pid " + $p.Id + ")") 'Green'
      $killed++
    } catch { }
  }
} else {
  Say ("        保留了 " + $player.Count + " 个播放页窗口") 'DarkGray'
}

Say ""
Say "  ============================================" 'Cyan'
if ($killed -eq 0) {
  Say "     没什么需要停的" 'Yellow'
} else {
  Say ("     已停止 " + $killed + " 项") 'Green'
}
Say "  ============================================" 'Cyan'
Say ""
