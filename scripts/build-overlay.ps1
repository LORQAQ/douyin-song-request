# 编译歌单悬浮窗（转发到 overlay 目录里自己的构建脚本）
#
# 【为什么只做转发】
#   悬浮窗现在是**独立子项目**（overlay/ 目录，自带 README / build.bat / run.bat），
#   不依赖点歌插件的任何东西。编译器调用方式只应该有一份，
#   放在 overlay/build.bat 里 —— 这样别人把 overlay 目录单独拷走也能编译。
#   这里保留一个入口只是为了不破坏 `npm run overlay:build` 这个习惯用法。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$bat = Join-Path $root 'overlay\build.bat'

if (-not (Test-Path $bat)) {
  throw "找不到 overlay\build.bat —— 悬浮窗子项目不完整？"
}

Write-Host "歌单悬浮窗是独立子项目，正在调用它自己的构建脚本："
Write-Host "  overlay\build.bat"
Write-Host ""
Write-Host "（它也可以单独使用：进 overlay 目录双击 build.bat 即可）"
Write-Host ""

& cmd /c "`"$bat`""

if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "构建脚本返回 $LASTEXITCODE，可能编译失败了。" -ForegroundColor Red
}

# build.bat 末尾有 pause，非交互环境下会卡住，这里做个收尾提示
Write-Host ""
Write-Host "产物在 overlay\bin\ 目录。" -ForegroundColor Green
