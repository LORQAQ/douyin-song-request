using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

/// <summary>
/// 悬浮窗要用的 Win32 互操作。
///
/// 单独放成 .cs 文件（而不是嵌在 ps1 的 here-string 里）是有原因的：
/// 之前把 C# 代码写在 PowerShell 的 here-string 里，通过 -File 传参时
/// 整个脚本会被命令行编码搞坏，Add-Type 直接失败、进程静默退出。
/// 独立文件没有这个问题，也更好维护。
/// </summary>
public class OverlayWin32
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TRANSPARENT = 0x00000020;
    public const int WS_EX_LAYERED = 0x00080000;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_TOPMOST = 0x00000008;
    public const uint MOD_ALT = 0x0001;
    public const uint MOD_CONTROL = 0x0002;

    /// <summary>切换鼠标穿透（透过窗口点到下面的程序）</summary>
    public static void SetClickThrough(IntPtr h, bool on)
    {
        int ex = GetWindowLong(h, GWL_EXSTYLE);
        if (on) ex |= (WS_EX_TRANSPARENT | WS_EX_LAYERED);
        else ex &= ~WS_EX_TRANSPARENT;
        SetWindowLong(h, GWL_EXSTYLE, ex);
    }

    /// <summary>从 Alt+Tab 列表里隐藏（悬浮窗不该占那一格）</summary>
    public static void HideFromAltTab(IntPtr h)
    {
        int ex = GetWindowLong(h, GWL_EXSTYLE);
        SetWindowLong(h, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW);
    }

    /// <summary>报告窗口的样式（自检用）</summary>
    public static string Describe(IntPtr h)
    {
        int ex = GetWindowLong(h, GWL_EXSTYLE);
        var sb = new StringBuilder();
        var title = new StringBuilder(256);
        GetWindowText(h, title, title.Capacity);
        sb.Append("标题=「").Append(title.ToString()).Append("」 ");
        sb.Append("可见=").Append(IsWindowVisible(h) ? "是" : "否").Append(" ");
        sb.Append("分层窗口=").Append((ex & WS_EX_LAYERED) != 0 ? "是(透明)" : "否").Append(" ");
        sb.Append("鼠标穿透=").Append((ex & WS_EX_TRANSPARENT) != 0 ? "开" : "关").Append(" ");
        sb.Append("不进AltTab=").Append((ex & WS_EX_TOOLWINDOW) != 0 ? "是" : "否").Append(" ");
        sb.Append("置顶=").Append((ex & WS_EX_TOPMOST) != 0 ? "是" : "否");
        return sb.ToString();
    }
}
