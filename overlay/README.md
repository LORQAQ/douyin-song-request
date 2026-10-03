# 歌单悬浮窗（SongOverlay）

一个**完全独立**的 Windows 透明置顶窗口，用来把歌单显示在直播画面上。

![示意](https://img.shields.io/badge/Platform-Windows-0078D4?logo=windows&logoColor=white)
![.NET](https://img.shields.io/badge/.NET%20Framework-4.x%20(系统自带)-512BD4)
![依赖](https://img.shields.io/badge/依赖-无-brightgreen)

## 它是什么

- **真透明**：用 Win32 分层窗口（`UpdateLayeredWindow`）逐像素 alpha，不是浏览器那种假透明
- **鼠标穿透**：默认点它不挡你操作（`Ctrl+Alt+M` 可临时关掉，方便拖动）
- **置顶显示**：一直在最上面（可关，见 `--behind`）
- **位置记忆**：拖到哪就记住哪，下次打开还在原地
- **零依赖**：编译成单个 exe，不需要装 Node / Electron / 任何运行时（用系统自带的 .NET Framework 4.x）
- **不绑定任何程序**：它只连一个 WebSocket 收歌单数据。谁推给它都能用

## 快速开始

### 方式一：直接用编译好的（推荐）

```bat
:: 双击运行
SongOverlay.exe

:: 或者跑我这个脚本（会自动找 exe，没有就尝试编译）
启动悬浮窗.bat
```

### 方式二：自己编译

需要 Windows 自带的 C# 编译器（`csc.exe`，不用装 Visual Studio 或 .NET SDK）：

```bat
:: 双击运行
编译.bat
```

或者手动：

```bat
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
  /target:winexe /optimize+ /out:bin\SongOverlay.exe ^
  /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll ^
  SongOverlay.cs
```

## 在直播伴侣里使用

1. 启动 `SongOverlay.exe`（出现一个透明窗口）
2. 直播伴侣 → **添加素材 → 窗口捕获**
3. 在列表里选 **「歌单悬浮窗」**
4. 拖到画面合适的位置

> **如果列表里找不到它**，有两种可能：
>
> | 原因 | 解决 |
> |---|---|
> | 窗口被当成"工具窗口"过滤了 | 这个版本默认已经是普通窗口，正常应该能找到 |
> | 采集软件不接受鼠标穿透的窗口 | 加 `--fixed` 启动（关掉鼠标穿透）|
>
> 跑 `WinDiag.exe` 可以列出所有可被捕获的窗口及其属性，看它到底被什么条件过滤了。

## 命令行参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--host <地址>` | `127.0.0.1` | WebSocket 服务端地址 |
| `--port <端口>` | `8787` | WebSocket 服务端端口 |
| `--max <数量>` | `6` | 队列最多显示几条 |
| `--left <x>` | 记住的位置，否则 40 | 窗口左边距 |
| `--top <y>` | 记住的位置，否则左下角 | 窗口上边距 |
| `--fixed` | 关 | **关掉鼠标穿透**（能直接用鼠标拖；采集软件挑食时也用它）|
| `--behind` | 关 | **不置顶**，可被别的窗口盖住（想让桌面看不到它时用）|
| `--no-taskbar` | 关 | 不进 Alt+Tab 和任务栏（注意：部分采集软件会因此找不到它）|
| `--no-cover` | 关 | 不显示封面图（脱离点歌插件时建议加，省一次无效请求）|

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl+Alt+T` | 切换鼠标穿透 |
| `Ctrl+Alt+M` | 关掉鼠标穿透（之后可以用鼠标拖动窗口）|
| `Ctrl+Alt+Q` | 退出 |

## 数据从哪来（协议）

悬浮窗启动后会连 `ws://<host>:<port>/ws/audio`，等对方推 JSON 过来。
**任何程序**按这个格式推数据都能驱动它 —— 不限于本仓库的点歌插件。

```jsonc
// 当前播放（字段都可选）
{"type": "now",
 "song": "晴天",
 "status": "playing",        // playing / 其它值表示准备中
 "nickname": "观众甲",        // 谁点的
 "source": "周杰伦精选 · P3",  // 来源小字
 "pic": "https://..."}       // 封面图 URL

// 队列
{"type": "queue",
 "items": [{"song": "稻香", "nickname": "观众乙"}]}
```

**连不上时**它会显示「等待点歌程序连接…（监听 127.0.0.1:8787）」，每 2 秒重试一次，
不报错、不弹窗、不影响别的功能。

## 配套工具

| 程序 | 用途 |
|---|---|
| `SongOverlay.exe` | 悬浮窗本体 |
| `OverlayPlacer.exe` | 摆位工具：屏幕缩略图上拖动方块移动窗口，一键贴角，切穿透开关 |
| `WhereIsIt.exe` | 查位置：屏幕上找不到窗口时看清楚它到底在哪；也能直接挪 (`WhereIsIt.exe 40 40`) |
| `WinDiag.exe` | 窗口诊断：列出所有可被捕获的窗口及属性，排查采集软件为什么找不到它 |

## 常见问题

**Q：直播伴侣的窗口捕获列表里找不到它？**
A：先跑 `WinDiag.exe` 看窗口属性。常见原因是设了鼠标穿透，加 `--fixed` 重启试试。

**Q：我不想让它出现在 Alt+Tab 里？**
A：加 `--no-taskbar`。但注意这会让部分采集软件找不到它，建议确认采集能用之后再加。

**Q：桌面上一堆窗口挡住了它？**
A：它是置顶的，正常情况下一直在最上面。如果加了 `--behind` 就不是了 —— 去掉这个参数即可。

**Q：我不想要封面图，报错怎么办？**
A：加 `--no-cover`。封面图默认会先试本机图片代理（点歌插件提供），失败会静默跳过，不影响歌单显示。

**Q：窗口位置乱了 / 跑到屏幕外了？**
A：删掉同目录的 `overlay-pos.json` 就会回到默认位置；或者用 `WhereIsIt.exe 40 40` 挪回来。

**Q：支持多显示器吗？**
A：窗口可以拖到任意显示器，但位置记忆只记主屏坐标系。`--left/--top` 支持负值。

## 技术说明

- **透明**：`WS_EX_LAYERED` + `UpdateLayeredWindow`，每帧画一张 32 位带 alpha 的位图
- **鼠标穿透**：`WS_EX_TRANSPARENT`（用 `Ctrl+Alt+M` 动态开关）
- **不抢焦点**：`WS_EX_NOACTIVATE`
- **WebSocket 客户端**：手写的（RFC 6455 握手 + 帧解析），不引第三方库
- **JSON 解析**：手写的极简提取器，只取需要的字段，不引 JSON 库
- **零依赖**：整个程序只引用 `System.dll` / `System.Drawing.dll` / `System.Windows.Forms.dll`

## 已知限制

- 只支持 Windows
- 依赖 .NET Framework 4.x（Windows 8 以上都自带，不用额外安装）
- 窗口必须是真实存在的窗口 —— 直播伴侣不支持浏览器源，也不支持"隐藏但可捕获"的窗口
  （Windows 没有这种机制：窗口要么在屏幕上，要么就抓不到）
